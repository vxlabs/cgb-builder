/**
 * Code Graph Builder — MCP Server
 *
 * Exposes cgb capabilities to AI agents (Claude Code, Cursor, etc.)
 * via the Model Context Protocol over stdio transport.
 *
 * Conventions (see docs/MCP_TOOLS.md):
 *   - `root` is optional everywhere: args.root ?? CGB_ROOT ?? cwd
 *   - output is compact JSON with repo-relative paths; node IDs stay absolute
 *   - list tools accept limit (default 50, max 500) and offset and return
 *     { total, returned, offset, truncated, items }
 *   - never write to stdout outside the MCP transport (use src/util/log.ts)
 */

import * as path from 'path';
import * as fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { warnOnce } from '../util/log.js';
import { ensureFresh } from './freshness.js';
import {
  resolveRoot,
  rel,
  expandId,
  compactNode,
  page,
  relPaths,
  ok,
  err,
  type ToolResult,
} from './format.js';
import type { GraphDb } from '../graph/db.js';
import type { GraphNode, NodeKind } from '../types.js';
import type { GraphEngine } from '../graph/engine.js';
import type { Parser } from '../parser/index.js';
import type { BundleGenerator } from '../bundle/generator.js';

function readVersion(): string {
  try {
    // dist/mcp -> package root, and src/mcp -> package root under ts-jest
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- untyped third-party/dynamic value; behaviour unchanged
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch (e) {
    warnOnce('mcp', 'version', 'could not read package.json version', e);
    return '0.0.0';
  }
}

const VERSION = readVersion();

// ─── Server options ───────────────────────────────────────────────────────────

export interface McpServerOptions {
  /** Serve only non-mutating tools and never write the DB or the filesystem. */
  readOnly?: boolean;
  /** Directory holding graph.db (overrides env CGB_DB_DIR and `<root>/.cgb`). */
  dbDir?: string;
  /** Default project root used when a tool call omits `root`. */
  root?: string;
}

/** Tools that never modify the DB or the filesystem; the only ones served with `--read-only`. */
export const READ_ONLY_TOOLS: readonly string[] = [
  'cgb_deps',
  'cgb_impact',
  'cgb_symbol',
  'cgb_callers',
  'cgb_callees',
  'cgb_search',
  'cgb_bundle',
  'cgb_stats',
  'cgb_path',
  'cgb_detect_changes',
  'cgb_review_context',
  'cgb_large_functions',
  'cgb_entry_points',
  'cgb_call_chain',
  'cgb_criticality',
  'cgb_communities',
  'cgb_architecture',
  'cgb_dead_code',
  'cgb_rename_preview',
  'cgb_refactor_suggest',
  'cgb_wiki_section',
  'cgb_registry_list',
  'cgb_registry_search',
  'cgb_embed_search',
  'cgb_embed_similar',
];

/** Options of the running server; callTool() can override them per call. */
let serverOptions: McpServerOptions = {};
const callOptions = new AsyncLocalStorage<McpServerOptions>();

function opts(): McpServerOptions {
  return callOptions.getStore() ?? serverOptions;
}

// ─── Service bootstrap ────────────────────────────────────────────────────────

interface Services {
  root: string;
  db: GraphDb;
  engine: GraphEngine;
  parser: Parser;
  bundle: BundleGenerator;
}

async function getServices(root: string): Promise<Services> {
  const { GraphDb } = await import('../graph/db.js');
  const { GraphEngine } = await import('../graph/engine.js');
  const { Parser } = await import('../parser/index.js');
  const { BundleGenerator } = await import('../bundle/generator.js');

  const { dbDir, readOnly } = opts();
  const db = new GraphDb(root, { dbDir, readOnly });
  try {
    await db.init();
  } catch (e) {
    db.close();
    throw e;
  }
  const engine = new GraphEngine(db);
  const parser = new Parser(db, root);
  const bundle = new BundleGenerator(db, engine, root);
  return { root, db, engine, parser, bundle };
}

/**
 * Open the graph for `args.root`, run fn, and always close the DB.
 * Unless needGraph is false, an empty graph yields a "Graph not built" error.
 * Unless fresh is false (or the server is read-only), changed files are re-parsed first
 * (see freshness.ts); when that is cut short the JSON result gets `stale: true`.
 */
async function withGraph(
  args: { root?: string },
  fn: (s: Services) => Promise<ToolResult> | ToolResult,
  needGraph = true,
  fresh = true,
): Promise<ToolResult> {
  const root = resolveRoot(args);
  if (!fs.existsSync(root)) return err(`Directory does not exist: ${root}`);
  const s = await getServices(root);
  try {
    if (needGraph && s.db.getStats().nodes === 0) {
      return err(`Graph not built for ${root}`, 'Call cgb_init first');
    }
    let stale = false;
    if (fresh && !opts().readOnly && s.db.getStats().nodes > 0) {
      try {
        stale = (await ensureFresh(root, s.db)).skipped;
      } catch (e) {
        warnOnce('mcp', 'freshness', 'auto-refresh failed; serving the graph as is', e);
      }
    }
    const result = await fn(s);
    return stale ? markStale(result) : result;
  } finally {
    s.db.close();
  }
}

/** Add stale:true and a hint to a JSON-object result. */
function markStale(r: ToolResult): ToolResult {
  if (r.isError) return r;
  try {
    const data = JSON.parse(r.content[0].text) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return ok({
        ...data,
        stale: true,
        staleHint: 'Many files changed; run cgb_init to refresh the graph',
      });
    }
  } catch (e) {
    warnOnce('mcp', 'stale', 'could not annotate result as stale', e);
  }
  return r;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTarget(root: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(root, target);
}

interface PageArgs {
  limit?: number;
  offset?: number;
}

/** Upper bound used when asking an analyzer for "everything" before paginating. */
const ALL = 100000;

/** Community with a bounded file list (full lists can be thousands of entries). */
function compactCommunity<T extends { files: string[] }>(root: string, c: T) {
  const files = c.files.map((f) => rel(root, f));
  return { ...relPaths(root, c), files: files.slice(0, 15), fileCount: files.length };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const ROOT_PROP = {
  type: 'string',
  description:
    'Project root. Optional: defaults to the CGB_ROOT env var, then the server working directory.',
};
const LIMIT_PROP = { type: 'number', description: 'Max items to return (default 50, max 500)' };
const OFFSET_PROP = { type: 'number', description: 'Items to skip, for paging (default 0)' };
const PAGING = { limit: LIMIT_PROP, offset: OFFSET_PROP };

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  withRoot = true,
) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object' as const,
      properties: withRoot ? { root: ROOT_PROP, ...properties } : properties,
      required,
    },
  };
}

const TOOLS = [
  tool(
    'cgb_init',
    'Scans the project and builds or refreshes the code graph; returns graph stats and layers. ' +
      'Run first on a new project (other tools return "Graph not built" until then); re-run after large changes.',
    {
      force: {
        type: 'boolean',
        description: 'Re-parse all files even if unchanged (default: false)',
      },
    },
  ),
  tool(
    'cgb_deps',
    'Returns what a file imports: direct and transitive dependencies as compact nodes (paged). ' +
      'Use for "what does this file depend on"; use cgb_impact for the reverse direction.',
    {
      target: { type: 'string', description: 'File path, relative to root or absolute' },
      depth: { type: 'number', description: 'Transitive depth (default: 3)' },
      ...PAGING,
    },
    ['target'],
  ),
  tool(
    'cgb_impact',
    'Returns the files affected if a file changes (reverse dependencies with depth), paged, nearest first. ' +
      'Use before editing a widely used file; use cgb_detect_changes for a whole git diff.',
    {
      target: { type: 'string', description: 'File path, relative to root or absolute' },
      depth: { type: 'number', description: 'Maximum traversal depth (default: 10)' },
      ...PAGING,
    },
    ['target'],
  ),
  tool(
    'cgb_symbol',
    'The first tool to use when you know a name. Looks up a symbol by name or node ID (falls back to ranked search) and returns, per match: ' +
      'file, line range, signature, doc, caller and callee counts, top 5 callers and callees, containing class and a readHint ("Read <file> lines a-b"). ' +
      'Replaces grep plus read; then use cgb_callers / cgb_callees to walk the call graph.',
    {
      name: { type: 'string', description: 'Symbol name, e.g. "GraphDb" or "parseFile"' },
      id: {
        type: 'string',
        description: 'Node ID; repo-relative paths accepted. Takes precedence over name.',
      },
      kind: {
        type: 'string',
        description: 'Restrict to a kind: function, method, class, interface, type, file, module',
      },
      file: {
        type: 'string',
        description: 'Restrict to files whose repo-relative path contains this text',
      },
      limit: { type: 'number', description: 'Max matches (default 5, max 50)' },
    },
  ),
  tool(
    'cgb_callers',
    'Who calls this symbol: BFS over calls edges, nearest first. Items are compact nodes with depth and via (edge reason). ' +
      'Use before changing a function signature; use cgb_impact for file-level blast radius.',
    {
      id: {
        type: 'string',
        description: 'Node ID (get it from cgb_symbol or cgb_search); repo-relative paths accepted',
      },
      depth: { type: 'number', description: 'Hops to follow (default 1, max 5)' },
      ...PAGING,
    },
    ['id'],
  ),
  tool(
    'cgb_callees',
    'What this symbol calls: BFS over calls edges, nearest first. Items are compact nodes with depth and via (edge reason). ' +
      'Use to understand a function without reading it; cgb_call_chain gives the same trace as a flat list.',
    {
      id: {
        type: 'string',
        description: 'Node ID (get it from cgb_symbol or cgb_search); repo-relative paths accepted',
      },
      depth: { type: 'number', description: 'Hops to follow (default 1, max 5)' },
      ...PAGING,
    },
    ['id'],
  ),
  tool(
    'cgb_search',
    'Single search entry point. Ranks exact name, then prefix, then full-text matches; returns compact nodes with matchedBy and score, paged. ' +
      'Conceptual queries (several words) automatically add vector matching when embeddings exist (cgb_embed_build); pass semantic:true to force it.',
    {
      query: { type: 'string', description: 'Search term or free text' },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict to node kinds, e.g. ["function","class"]',
      },
      includeExternal: {
        type: 'boolean',
        description: 'Include external packages (default false)',
      },
      semantic: { type: 'boolean', description: 'Force hybrid lexical + vector search' },
      contextFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Semantic mode: files whose nodes get a 1.5x boost',
      },
      ...PAGING,
    },
    ['query'],
  ),
  tool(
    'cgb_bundle',
    'Returns a Markdown context bundle for one file or symbol: summary, dependencies, reverse dependencies, hierarchy, optional source. ' +
      'Use to load full structural context before editing a file.',
    {
      target: {
        type: 'string',
        description:
          'File path (relative to root or absolute) or a node ID such as "function:src/a.ts#foo"',
      },
      depth: { type: 'number', description: 'Dependency depth (default: 2)' },
      includeSource: { type: 'boolean', description: 'Include the file source (default: true)' },
      maxTargetLines: {
        type: 'number',
        description: 'Max source lines for the target (default: 200)',
      },
      includeDependencySource: {
        type: 'boolean',
        description: 'Include short source snippets of internal dependencies (default: false)',
      },
    },
    ['target'],
  ),
  tool(
    'cgb_stats',
    'Returns graph summary: file, node and edge counts, counts by kind, layers, cycle count and orphan count. ' +
      'Cheap health check; use cgb_architecture for a deeper overview.',
    {},
  ),
  tool(
    'cgb_path',
    'Finds the shortest dependency path between two files. Use to explain how module A reaches module B.',
    {
      from: { type: 'string', description: 'Source file path, relative or absolute' },
      to: { type: 'string', description: 'Target file path, relative or absolute' },
    },
    ['from', 'to'],
  ),
  tool(
    'cgb_detect_changes',
    'Analyses a git diff against the graph: per-file risk score (0-100), blast radius, security relevance, test gaps. ' +
      'Use before committing or merging; use cgb_review_context for a reviewer brief.',
    { base: { type: 'string', description: 'Git base ref (default: HEAD~1), e.g. main, HEAD~3' } },
  ),
  tool(
    'cgb_review_context',
    'Builds a review brief for changes since a git ref: changed files, affected files, tests, focus areas. ' +
      'Use to prime a code review; cgb_detect_changes gives raw risk scoring instead.',
    {
      base: { type: 'string', description: 'Git base ref (default: HEAD~1)' },
      format: {
        type: 'string',
        enum: ['json', 'markdown'],
        description: 'Output format (default: markdown)',
      },
    },
  ),
  tool(
    'cgb_large_functions',
    'Lists the most connected functions and methods (fan-in + fan-out), highest first, paged. ' +
      'Use to find refactoring candidates and hotspots.',
    { ...PAGING },
  ),
  tool(
    'cgb_entry_points',
    'Lists functions, methods and files with no inbound calls (tops of call chains), by fan-out descending, paged. ' +
      'Use to find public APIs and handlers; follow with cgb_call_chain.',
    { ...PAGING },
  ),
  tool(
    'cgb_call_chain',
    'Traces outgoing calls from a node, with depth per step, paged. ' +
      'Use to follow an execution flow; get the node ID from cgb_symbol or cgb_entry_points.',
    {
      nodeId: {
        type: 'string',
        description:
          'Node ID: "<kind>:<path>#<symbol>", e.g. "function:src/a.ts#myFunc". Repo-relative paths are accepted.',
      },
      maxDepth: { type: 'number', description: 'Maximum depth (default: 5)' },
      ...PAGING,
    },
    ['nodeId'],
  ),
  tool(
    'cgb_criticality',
    'Scores functions, methods, classes and interfaces by criticality (fan-in x3 + fan-out) with labels critical/high/medium/low, paged. ' +
      'Use to decide where changes need the most care.',
    { ...PAGING },
  ),
  tool(
    'cgb_communities',
    'Detects module clusters (Louvain, or connected components as fallback) and stores community ids on nodes. ' +
      'Returns clusters with label, role, cohesion, hubs and up to 15 files each, paged, largest first.',
    { ...PAGING },
  ),
  tool(
    'cgb_architecture',
    'Returns an architecture overview: clusters (paged), layers, cycles, orphan files, health score. ' +
      'Use for onboarding or architecture review; cgb_stats is the cheaper summary.',
    { ...PAGING },
  ),
  tool(
    'cgb_dead_code',
    'Lists symbols with no inbound calls or imports (test files excluded), paged. Candidates only: verify before deleting. ' +
      'With includeUnusedExports, also returns exported functions/classes nobody references or imports as "unusedExports".',
    {
      includeUnusedExports: {
        type: 'boolean',
        description: 'Also list unused exported symbols (default: false)',
      },
      ...PAGING,
    },
  ),
  tool(
    'cgb_rename_preview',
    'Previews renaming a symbol. With newName it returns concrete per-occurrence edits (items: file, line, column, before, after, confidence), warnings and a refactorId for cgb_apply_refactor; ' +
      'an invalid identifier is an error. Without newName, edge-level impact only. Never writes to disk.',
    {
      nodeId: {
        type: 'string',
        description: 'Symbol node ID (find with cgb_symbol); repo-relative paths accepted',
      },
      newName: { type: 'string', description: 'New name; required to get a refactorId' },
    },
    ['nodeId'],
  ),
  tool(
    'cgb_apply_refactor',
    'Applies a stored rename preview to disk using a refactorId from cgb_rename_preview, then re-indexes the touched files (reparsed: true). ' +
      'Aborts with nothing written and returns conflicts if any line changed since the preview. Previews expire after 10 minutes; paths are checked against the project root.',
    { refactorId: { type: 'string', description: '8-char hex id from cgb_rename_preview' } },
    ['refactorId'],
  ),
  tool(
    'cgb_refactor_suggest',
    'Suggests structural refactors from connectivity: extract helpers for high fan-out functions, split high fan-in files. Paged. ' +
      'Use after cgb_large_functions to turn hotspots into actions.',
    { ...PAGING },
  ),
  tool(
    'cgb_wiki_generate',
    'Generates a Markdown wiki (one page per community plus an index). Returns the page list (paged) or, with outputDir, writes the files. ' +
      'Use cgb_wiki_section for a single page.',
    {
      outputDir: {
        type: 'string',
        description: 'Write .md files here (relative to root or absolute)',
      },
      ...PAGING,
    },
  ),
  tool(
    'cgb_wiki_section',
    'Generates the wiki page for one community and returns its Markdown. ' +
      'Pass the 0-based index of the community from cgb_communities.',
    { communityIndex: { type: 'number', description: '0-based community index' } },
    ['communityIndex'],
  ),
  tool(
    'cgb_registry_register',
    'Registers a project in the global registry (~/.cgb/registry.json) so cgb_registry_search can query it.',
    { name: { type: 'string', description: 'Friendly name (default: directory name)' } },
  ),
  tool(
    'cgb_registry_list',
    'Lists projects in the global registry, paged.',
    { ...PAGING },
    [],
    false,
  ),
  tool(
    'cgb_registry_search',
    'Searches symbols across all registered projects; each result names its source project, paged. ' +
      'Use cgb_search for the current project only.',
    {
      query: { type: 'string', description: 'Search term' },
      maxPerRepo: { type: 'number', description: 'Max results per repo (default: 10)' },
      ...PAGING,
    },
    ['query'],
    false,
  ),
  tool(
    'cgb_embed_build',
    'Computes and stores vector embeddings for graph nodes (provider local, google or minimax). ' +
      'Optional: improves cgb_search (conceptual queries) and cgb_embed_similar; without it they fall back to TF-IDF. Local downloads ~30MB on first use.',
    {
      provider: { type: 'string', description: '"local" | "google" | "minimax" (default: local)' },
    },
  ),
  tool(
    'cgb_embed_search',
    'DEPRECATED alias of cgb_search (same handler and arguments); use cgb_search. ' +
      'Hybrid search fuses exact/prefix/FTS5 BM25 matches with vector similarity when embeddings exist.',
    {
      query: { type: 'string', description: 'Free text, e.g. "authentication middleware"' },
      contextFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files whose nodes get a 1.5x boost',
      },
      semantic: { type: 'boolean', description: 'Force hybrid lexical + vector search' },
      ...PAGING,
    },
    ['query'],
  ),
  tool(
    'cgb_embed_similar',
    'Finds nodes semantically similar to a given node, paged. Use to find related functions or classes.',
    {
      nodeId: { type: 'string', description: 'Reference node ID; repo-relative paths accepted' },
      ...PAGING,
    },
    ['nodeId'],
  ),
];

// ─── Tool handlers ────────────────────────────────────────────────────────────

type RootArg = { root?: string };

async function handleInit(args: RootArg & { force?: boolean }) {
  const { force = false } = args;
  return withGraph(
    args,
    async ({ db, parser, engine, root }) => {
      const result = await parser.scanAll(force);
      const stats = db.getStats();
      return ok({
        success: true,
        root,
        durationMs: result.durationMs,
        parsed: result.parsed,
        skipped: result.skipped,
        errors: relPaths(root, result.errors.slice(0, 10)),
        graph: {
          files: stats.files,
          nodes: stats.nodes,
          edges: stats.edges,
          byKind: db.getNodeCountByKind(),
        },
        layers: engine.layers().slice(0, 15),
      });
    },
    false,
    false,
  );
}

async function handleDeps(args: RootArg & PageArgs & { target: string; depth?: number }) {
  const { target, depth = 3 } = args;
  return withGraph(args, ({ root, engine }) => {
    const result = engine.deps(`file:${resolveTarget(root, target)}`, depth);
    if (!result)
      return err(`File not found in graph: ${target}`, 'Call cgb_init first, or check the path');
    return ok({
      target: compactNode(root, result.target),
      direct: page(
        result.direct.map((n) => compactNode(root, n)),
        args,
      ),
      transitive: page(
        result.transitive.map((n) => compactNode(root, n)),
        args,
      ),
    });
  });
}

async function handleImpact(args: RootArg & PageArgs & { target: string; depth?: number }) {
  const { target, depth = 10 } = args;
  return withGraph(args, ({ root, engine }) => {
    const result = engine.impact(`file:${resolveTarget(root, target)}`, depth);
    if (!result)
      return err(`File not found in graph: ${target}`, 'Call cgb_init first, or check the path');
    return ok({
      target: compactNode(root, result.target),
      ...page(
        result.affected.map((a) => ({ depth: a.depth, ...compactNode(root, a.node) })),
        args,
      ),
    });
  });
}

const MAX_SEARCH = 500;
const MAX_HOPS = 5;
const MAX_VISITED = 5000;
const TOP_N = 5;
const KIND_ORDER = [
  'class',
  'interface',
  'function',
  'method',
  'type',
  'module',
  'file',
  'external_dep',
];

type CompactNodeLike = ReturnType<typeof compactNode>;

interface SearchArgs extends RootArg, PageArgs {
  query: string;
  kinds?: string[];
  includeExternal?: boolean;
  semantic?: boolean;
  contextFiles?: string[];
}

/** cgb_search, and its deprecated alias cgb_embed_search. */
async function handleSearch(args: SearchArgs) {
  return withGraph(args, async ({ root, db }) => {
    const query = String(args.query ?? '');
    const kinds = args.kinds?.length ? (args.kinds as NodeKind[]) : undefined;
    const useHybrid =
      args.semantic === true || (/\s/.test(query.trim()) && db.getEmbeddingCount() > 0);

    const items: Array<CompactNodeLike & { matchedBy: string; score: number }> = [];
    if (useHybrid) {
      const { hybridSearch } = await import('../embed/index.js');
      const contextFiles = args.contextFiles?.map((f) => resolveTarget(root, f));
      const hits = await hybridSearch(db, query, {
        limit: MAX_SEARCH,
        contextFiles,
        localOnly: opts().readOnly,
      });
      const byId = new Map(db.getNodesByIds(hits.map((h) => h.id)).map((n) => [n.id, n]));
      for (const h of hits) {
        const n = byId.get(h.id);
        if (!n) continue;
        if (n.isExternal && !args.includeExternal) continue;
        if (kinds && !kinds.includes(n.kind)) continue;
        items.push({ ...compactNode(root, n), matchedBy: 'hybrid', score: h.score });
      }
    } else {
      const ranked = db.searchNodesRanked(query, {
        limit: MAX_SEARCH,
        kinds,
        includeExternal: args.includeExternal,
      });
      const byId = new Map(db.getNodesByIds(ranked.map((r) => r.id)).map((n) => [n.id, n]));
      for (const r of ranked) {
        const n = byId.get(r.id);
        if (n)
          items.push({
            ...compactNode(root, n),
            matchedBy: r.matchedBy,
            score: Math.round(r.score * 10000) / 10000,
          });
      }
    }
    return ok({ query, ...page(items, args) });
  });
}

/** Unique nodes by id in order; symbol nodes before file nodes. */
function uniqueNodes(rows: Array<{ node: GraphNode }>): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const { node } of rows) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out.sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file'));
}

async function handleSymbol(
  args: RootArg & { name?: string; id?: string; kind?: string; file?: string; limit?: number },
) {
  return withGraph(args, ({ root, db, engine }) => {
    const { name, id, kind, file } = args;
    if (!name && !id) return err('Provide name or id', 'e.g. {"name":"GraphDb"}');
    const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 5), 50));
    const kinds = kind ? [kind as NodeKind] : undefined;
    const needle = file ? file.split('\\').join('/') : undefined;
    const inFile = (n: GraphNode): boolean => !needle || rel(root, n.filePath).includes(needle);

    let matches: Array<{ node: GraphNode; matchedBy: string }> = [];
    if (id) {
      const n = db.getNode(expandId(root, id));
      if (n) matches = [{ node: n, matchedBy: 'id' }];
    } else if (name) {
      matches = db
        .getNodesByName(name, kinds)
        .filter((n) => !n.isExternal && inFile(n))
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
        .map((node) => ({ node, matchedBy: 'exact' }));
      if (matches.length === 0) {
        const ranked = db.searchNodesRanked(name, { limit: 50, kinds });
        const byId = new Map(db.getNodesByIds(ranked.map((r) => r.id)).map((n) => [n.id, n]));
        for (const r of ranked) {
          const n = byId.get(r.id);
          if (n && inFile(n)) matches.push({ node: n, matchedBy: r.matchedBy });
        }
      }
    }
    if (matches.length === 0)
      return err(`No symbol found for ${id ?? name}`, 'Try cgb_search with a partial name');

    const items = matches.slice(0, limit).map(({ node, matchedBy }) => {
      const c = compactNode(root, node);
      const callers = uniqueNodes(engine.callers(node.id)?.callers ?? []);
      const callees = uniqueNodes(engine.callees(node.id)?.callees ?? []);
      let container: CompactNodeLike | undefined;
      for (const e of db.getEdgesToByKind(node.id, 'contains')) {
        const parent = db.getNode(e.fromId);
        if (parent && parent.kind !== 'file') {
          container = compactNode(root, parent);
          break;
        }
      }
      const readHint =
        node.startLine !== undefined
          ? `Read ${c.file} lines ${node.startLine}-${node.endLine ?? node.startLine}`
          : `Read ${c.file}`;
      return {
        ...c,
        matchedBy,
        callers: callers.length,
        callees: callees.length,
        topCallers: callers.slice(0, TOP_N).map((n) => compactNode(root, n)),
        topCallees: callees.slice(0, TOP_N).map((n) => compactNode(root, n)),
        ...(container ? { container } : {}),
        readHint,
      };
    });
    return ok({
      query: id ?? name,
      total: matches.length,
      returned: items.length,
      truncated: matches.length > items.length,
      items,
    });
  });
}

type CallRows = Array<{ node: GraphNode; reason: string }>;

/** BFS over calls edges (callers or callees) with a visited set. */
async function handleHops(
  direction: 'callers' | 'callees',
  args: RootArg & PageArgs & { id: string; depth?: number },
) {
  return withGraph(args, ({ root, engine }) => {
    const id = expandId(root, String(args.id ?? ''));
    const maxDepth = Math.max(1, Math.min(Math.floor(Number(args.depth) || 1), MAX_HOPS));
    const rowsOf = (nodeId: string): { target: GraphNode; rows: CallRows } | null => {
      if (direction === 'callers') {
        const r = engine.callers(nodeId);
        return r ? { target: r.target, rows: r.callers } : null;
      }
      const r = engine.callees(nodeId);
      return r ? { target: r.target, rows: r.callees } : null;
    };
    const first = rowsOf(id);
    if (!first) return err(`Node not found: ${args.id}`, 'Use cgb_symbol to find the node ID');

    const visited = new Set<string>([id]);
    const items: Array<CompactNodeLike & { depth: number; via: string }> = [];
    let frontier: Array<{ id: string; name: string }> = [{ id, name: first.target.name }];
    let capped = false;

    for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !capped; depth++) {
      const next: Array<{ id: string; name: string }> = [];
      for (const cur of frontier) {
        const res = depth === 1 ? first : rowsOf(cur.id);
        if (!res) continue;
        for (const { node, reason } of res.rows) {
          if (visited.has(node.id)) continue;
          visited.add(node.id);
          const rel2 = direction === 'callers' ? 'calls' : 'called by';
          items.push({
            ...compactNode(root, node),
            depth,
            via: depth === 1 ? reason : `${reason} (${rel2} ${cur.name})`,
          });
          next.push({ id: node.id, name: node.name });
          if (items.length >= MAX_VISITED) {
            capped = true;
            break;
          }
        }
        if (capped) break;
      }
      frontier = next;
    }
    return ok({
      target: compactNode(root, first.target),
      depth: maxDepth,
      ...(capped ? { capped: true } : {}),
      ...page(items, args),
    });
  });
}

async function handleBundle(
  args: RootArg & {
    target: string;
    depth?: number;
    includeSource?: boolean;
    maxTargetLines?: number;
    includeDependencySource?: boolean;
  },
) {
  const {
    target,
    depth = 2,
    includeSource = true,
    maxTargetLines = 200,
    includeDependencySource = false,
  } = args;
  return withGraph(args, ({ root, bundle }) => {
    // Node ids ("function:src/a.ts#foo", "external_dep:...") pass through; file paths are resolved.
    const isNodeId =
      /^[a-z_]+:/.test(target) && (target.includes('#') || target.startsWith('external_dep:'));
    const absTarget = isNodeId ? expandId(root, target) : resolveTarget(root, target);
    const result = bundle.generate(absTarget, {
      depth,
      includeSource,
      maxTargetLines,
      includeDependencySource,
    });
    return ok({
      target: isNodeId ? absTarget : rel(root, absTarget),
      tokenEstimate: result.totalTokenEstimate,
      bundle: bundle.render(result),
    });
  });
}

async function handleStats(args: RootArg) {
  return withGraph(args, ({ root, db, engine }) => {
    const stats = db.getStats();
    const cycles = engine.detectCycles();
    return ok({
      files: stats.files,
      nodes: stats.nodes,
      edges: stats.edges,
      byKind: db.getNodeCountByKind(),
      layers: engine.layers().slice(0, 20),
      cycleCount: cycles.length,
      cycles: relPaths(root, cycles.slice(0, 5)),
      orphanCount: engine.orphans().length,
    });
  });
}

async function handlePath(args: RootArg & { from: string; to: string }) {
  const { from, to } = args;
  return withGraph(args, ({ root, engine }) => {
    const result = engine.path(
      `file:${resolveTarget(root, from)}`,
      `file:${resolveTarget(root, to)}`,
    );
    if (!result)
      return ok({
        found: false,
        from,
        to,
        message: `No dependency path found from ${from} to ${to}`,
      });
    return ok({
      found: true,
      length: result.path.length,
      path: result.path.map((n) => compactNode(root, n)),
      edges: result.edges.map((e) => ({ kind: e.kind, reason: e.reason })),
    });
  });
}

// ─── Git tool handlers ────────────────────────────────────────────────────────

async function handleDetectChanges(args: RootArg & { base?: string }) {
  const { base = 'HEAD~1' } = args;
  const root = resolveRoot(args);
  if (!fs.existsSync(root)) return err(`Directory does not exist: ${root}`);
  const { getGitChanges, isGitRepo } = await import('../git/diff.js');
  if (!isGitRepo(root)) return err(`Not a git repository: ${root}`);

  return withGraph(args, async ({ db, engine }) => {
    const { analyzeChanges } = await import('../git/changes.js');
    const gitChanges = await getGitChanges(root, base);
    if (gitChanges.length === 0)
      return ok({ message: `No changes found between ${base} and HEAD`, changes: [] });
    return ok(relPaths(root, analyzeChanges(gitChanges, db, engine)));
  });
}

async function handleReviewContext(
  args: RootArg & { base?: string; format?: 'json' | 'markdown' },
) {
  const { base = 'HEAD~1', format = 'markdown' } = args;
  const root = resolveRoot(args);
  if (!fs.existsSync(root)) return err(`Directory does not exist: ${root}`);
  const { isGitRepo } = await import('../git/diff.js');
  if (!isGitRepo(root)) return err(`Not a git repository: ${root}`);

  return withGraph(args, async ({ db, engine }) => {
    const { buildReviewContext, formatReviewContext } = await import('../git/review-context.js');
    const ctx = await buildReviewContext(root, db, engine, base);
    if (format === 'json') return ok(relPaths(root, ctx));
    return ok({ markdown: formatReviewContext(ctx), tokenEstimate: ctx.tokenEstimate });
  });
}

// ─── Flows tool handlers ──────────────────────────────────────────────────────

async function handleLargeFunctions(args: RootArg & PageArgs) {
  return withGraph(args, async ({ root, db }) => {
    const { findLargeFunctions } = await import('../flows/index.js');
    return ok(relPaths(root, page(findLargeFunctions(db, ALL), args)));
  });
}

async function handleEntryPoints(args: RootArg & PageArgs) {
  return withGraph(args, async ({ root, db }) => {
    const { FlowsAnalyzer } = await import('../flows/index.js');
    return ok(relPaths(root, page(new FlowsAnalyzer(db).entryPoints(ALL), args)));
  });
}

async function handleCallChain(args: RootArg & PageArgs & { nodeId: string; maxDepth?: number }) {
  const { nodeId, maxDepth = 5 } = args;
  return withGraph(args, async ({ root, db }) => {
    const { FlowsAnalyzer } = await import('../flows/index.js');
    const id = expandId(root, nodeId);
    const chain = new FlowsAnalyzer(db).callChain(id, maxDepth);
    if (chain.length === 0) {
      return err(
        `Node not found or no outbound calls: ${nodeId}`,
        'Use cgb_symbol to find the node ID',
      );
    }
    return ok({ nodeId: id, ...relPaths(root, page(chain, args)) });
  });
}

async function handleCriticality(args: RootArg & PageArgs) {
  return withGraph(args, async ({ root, db }) => {
    const { FlowsAnalyzer } = await import('../flows/index.js');
    return ok(relPaths(root, page(new FlowsAnalyzer(db).criticalityScores(ALL), args)));
  });
}

// ─── Community tool handlers ──────────────────────────────────────────────────

async function handleCommunities(args: RootArg & PageArgs) {
  return withGraph(args, async ({ root, db, engine }) => {
    const { CommunityDetector } = await import('../communities/index.js');
    const detector = new CommunityDetector(db, engine);
    // side effect (unless read-only): writes community_id onto nodes
    const communities = opts().readOnly
      ? detector.detect()
      : detector.detectAndPersistWithResult().communities;
    return ok(
      page(
        communities.map((c) => compactCommunity(root, c)),
        args,
      ),
    );
  });
}

async function handleArchitecture(args: RootArg & PageArgs) {
  return withGraph(args, async ({ root, db, engine }) => {
    const { CommunityDetector } = await import('../communities/index.js');
    const o = new CommunityDetector(db, engine).overview();
    const { communities, cycles, orphans, ...rest } = o;
    return ok({
      ...relPaths(root, rest),
      communities: page(
        communities.map((c) => compactCommunity(root, c)),
        args,
      ),
      cycleCount: cycles.length,
      cycles: relPaths(root, cycles.slice(0, 20)),
      orphanCount: orphans.length,
      orphans: relPaths(root, orphans.slice(0, 20)),
    });
  });
}

// ─── Refactor tool handlers ───────────────────────────────────────────────────

async function handleDeadCode(args: RootArg & PageArgs & { includeUnusedExports?: boolean }) {
  return withGraph(args, async ({ root, db }) => {
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    const analyzer = new RefactorAnalyzer(db);
    const dead = page(analyzer.deadCode(ALL), args);
    if (!args.includeUnusedExports) return ok(relPaths(root, dead));
    return ok(relPaths(root, { ...dead, unusedExports: page(analyzer.unusedExports(ALL), args) }));
  });
}

async function handleRenamePreview(args: RootArg & { nodeId: string; newName?: string }) {
  const { nodeId, newName } = args;
  return withGraph(args, async ({ root, db }) => {
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    const analyzer = new RefactorAnalyzer(db);
    const id = expandId(root, nodeId);
    let preview;
    try {
      preview = newName ? analyzer.renamePreviewWithEdits(id, newName) : analyzer.renamePreview(id);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 'newName must be a valid identifier');
    }
    if (!preview)
      return err(`Node not found: ${nodeId}`, 'Use cgb_symbol to find the correct node ID');
    return ok(relPaths(root, preview));
  });
}

async function handleApplyRefactor(args: RootArg & { refactorId: string }) {
  const { applyRefactorAsync } = await import('../refactor/index.js');
  return withGraph(
    args,
    async ({ root, db }) => {
      const result = await applyRefactorAsync(args.refactorId, root, db);
      return ok(relPaths(root, result));
    },
    false,
    false,
  );
}

async function handleRefactorSuggest(args: RootArg & PageArgs) {
  return withGraph(args, async ({ root, db }) => {
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    return ok(relPaths(root, page(new RefactorAnalyzer(db).suggestions(ALL), args)));
  });
}

// ─── Wiki tool handlers ───────────────────────────────────────────────────────

async function handleWikiGenerate(args: RootArg & PageArgs & { outputDir?: string }) {
  const { outputDir } = args;
  return withGraph(args, async ({ root, db, engine }) => {
    const { CommunityDetector } = await import('../communities/index.js');
    const { WikiGenerator } = await import('../wiki/index.js');
    const generator = new WikiGenerator(db, new CommunityDetector(db, engine));

    if (outputDir) {
      const absOut = path.isAbsolute(outputDir) ? outputDir : path.resolve(root, outputDir);
      const written = generator.writeToDir(absOut);
      return ok({
        outputDir: rel(root, absOut),
        writtenFiles: written.length,
        files: relPaths(root, written),
      });
    }

    const result = generator.generate();
    return ok({
      totalPages: result.totalPages,
      indexPage: result.indexPage,
      ...page(
        result.pages.map((p) => ({
          title: p.title,
          slug: p.slug,
          communityId: p.communityId,
          chars: p.content.length,
        })),
        args,
      ),
    });
  });
}

async function handleWikiSection(args: RootArg & { communityIndex: number }) {
  const { communityIndex } = args;
  return withGraph(args, async ({ db, engine }) => {
    const { CommunityDetector } = await import('../communities/index.js');
    const { WikiGenerator } = await import('../wiki/index.js');
    const detector = new CommunityDetector(db, engine);
    const communities = detector.detect();
    if (communityIndex < 0 || communityIndex >= communities.length) {
      return err(
        `communityIndex ${communityIndex} out of range. There are ${communities.length} communities (0-based).`,
        'Call cgb_communities to list them',
      );
    }
    const wikiPage = new WikiGenerator(db, detector).generate().pages[communityIndex];
    if (!wikiPage) return err(`No wiki page generated for community index ${communityIndex}.`);
    return ok(wikiPage);
  });
}

// ─── Registry tool handlers ───────────────────────────────────────────────────

async function handleRegistryRegister(args: RootArg & { name?: string }) {
  const root = resolveRoot(args);
  if (!fs.existsSync(root)) return err(`Directory does not exist: ${root}`);
  const { RegistryManager } = await import('../registry/index.js');
  return ok({ registered: new RegistryManager().register(args.name ?? '', root) });
}

async function handleRegistryList(args: PageArgs) {
  const { RegistryManager } = await import('../registry/index.js');
  return ok(page(new RegistryManager(undefined, opts().readOnly).load(), args));
}

async function handleRegistrySearch(args: PageArgs & { query: string; maxPerRepo?: number }) {
  const { RegistryManager } = await import('../registry/index.js');
  const readOnly = opts().readOnly;
  const results = await new RegistryManager(undefined, readOnly).search(
    args.query,
    args.maxPerRepo ?? 10,
    readOnly,
  );
  return ok({ query: args.query, ...page(results, args) });
}

// ─── Embed handlers ───────────────────────────────────────────────────────────

async function handleEmbedBuild(args: RootArg & { provider?: string }) {
  const { provider = 'local' } = args;
  return withGraph(args, async ({ db }) => {
    const { embedNodes, getProvider } = await import('../embed/index.js');
    const result = await embedNodes(db, getProvider(provider));
    return ok({ provider, ...result });
  });
}

async function handleEmbedSimilar(args: RootArg & PageArgs & { nodeId: string }) {
  return withGraph(args, async ({ root, db }) => {
    const { EmbedSearcher } = await import('../embed/index.js');
    const id = expandId(root, args.nodeId);
    const results = new EmbedSearcher(db).findSimilar(id, 500);
    return ok({ nodeId: id, ...relPaths(root, page(results, args)) });
  });
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/** Run a tool by name under the current options. Exported for tests. */
export async function handleTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const { readOnly, root } = opts();
  if (readOnly && !READ_ONLY_TOOLS.includes(name)) {
    return err(`Tool ${name} is not available in read-only mode.`);
  }
  if (args['root'] === undefined && root) args = { ...args, root };
  try {
    switch (name) {
      case 'cgb_init':
        return await handleInit(args as never);
      case 'cgb_deps':
        return await handleDeps(args as never);
      case 'cgb_impact':
        return await handleImpact(args as never);
      case 'cgb_symbol':
        return await handleSymbol(args as never);
      case 'cgb_callers':
        return await handleHops('callers', args as never);
      case 'cgb_callees':
        return await handleHops('callees', args as never);
      case 'cgb_search':
        return await handleSearch(args as never);
      case 'cgb_bundle':
        return await handleBundle(args as never);
      case 'cgb_stats':
        return await handleStats(args as never);
      case 'cgb_path':
        return await handlePath(args as never);
      case 'cgb_detect_changes':
        return await handleDetectChanges(args as never);
      case 'cgb_review_context':
        return await handleReviewContext(args as never);
      case 'cgb_large_functions':
        return await handleLargeFunctions(args as never);
      case 'cgb_entry_points':
        return await handleEntryPoints(args as never);
      case 'cgb_call_chain':
        return await handleCallChain(args as never);
      case 'cgb_criticality':
        return await handleCriticality(args as never);
      case 'cgb_communities':
        return await handleCommunities(args as never);
      case 'cgb_architecture':
        return await handleArchitecture(args as never);
      case 'cgb_dead_code':
        return await handleDeadCode(args as never);
      case 'cgb_rename_preview':
        return await handleRenamePreview(args as never);
      case 'cgb_apply_refactor':
        return await handleApplyRefactor(args as never);
      case 'cgb_refactor_suggest':
        return await handleRefactorSuggest(args as never);
      case 'cgb_wiki_generate':
        return await handleWikiGenerate(args as never);
      case 'cgb_wiki_section':
        return await handleWikiSection(args as never);
      case 'cgb_registry_register':
        return await handleRegistryRegister(args as never);
      case 'cgb_registry_list':
        return await handleRegistryList(args as never);
      case 'cgb_registry_search':
        return await handleRegistrySearch(args as never);
      case 'cgb_embed_build':
        return await handleEmbedBuild(args as never);
      case 'cgb_embed_search': // deprecated alias of cgb_search
        return await handleSearch(args as never);
      case 'cgb_embed_similar':
        return await handleEmbedSimilar(args as never);
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`Tool ${name} failed: ${message}`);
  }
}

/** Run a tool under explicit options (e.g. read-only) without affecting other calls. */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  options: McpServerOptions = serverOptions,
): Promise<ToolResult> {
  return callOptions.run(normalizeOptions(options), () => handleTool(name, args));
}

/** Tool definitions served under the given options (read-only filters out mutating tools). */
export function listTools(options: McpServerOptions = {}) {
  if (!options.readOnly) return TOOLS;
  const allowed = new Set(READ_ONLY_TOOLS);
  return TOOLS.filter((t) => allowed.has(t.name));
}

function normalizeOptions(options: McpServerOptions): McpServerOptions {
  return {
    ...options,
    root: options.root ? path.resolve(options.root) : undefined,
    dbDir: options.dbDir ? path.resolve(options.dbDir) : undefined,
  };
}

// ─── Prompt definitions ───────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: 'review_changes',
    description:
      'Generates a focused code-review prompt for the current git diff. ' +
      'Pass root so the agent can call cgb_review_context automatically.',
    arguments: [
      {
        name: 'root',
        description: 'Absolute project root (default: CGB_ROOT or server cwd)',
        required: false,
      },
      {
        name: 'base',
        description: 'Base git ref to diff against (default: main)',
        required: false,
      },
    ],
  },
  {
    name: 'architecture_map',
    description:
      'Produces a prompt that asks the agent to describe the high-level architecture ' +
      'of the project using cgb_architecture and cgb_communities.',
    arguments: [
      {
        name: 'root',
        description: 'Absolute project root (default: CGB_ROOT or server cwd)',
        required: false,
      },
    ],
  },
  {
    name: 'debug_issue',
    description:
      'Scaffolds a debugging prompt: given a symptom, the agent traces call chains, ' +
      'checks dependencies, and proposes root-cause hypotheses.',
    arguments: [
      {
        name: 'root',
        description: 'Absolute project root (default: CGB_ROOT or server cwd)',
        required: false,
      },
      {
        name: 'symptom',
        description: 'Short description of the observed bug or failure',
        required: true,
      },
      {
        name: 'entry',
        description: 'File or function name that is the suspected entry point',
        required: false,
      },
    ],
  },
  {
    name: 'onboard_developer',
    description:
      'Creates an onboarding prompt that walks a new developer through the codebase: ' +
      'architecture overview, key entry points, communities, and top-level wiki.',
    arguments: [
      {
        name: 'root',
        description: 'Absolute project root (default: CGB_ROOT or server cwd)',
        required: false,
      },
    ],
  },
  {
    name: 'pre_merge_check',
    description:
      'Generates a pre-merge checklist prompt: detects changes, scores risk, ' +
      'checks for dead code, and summarises impact for a human reviewer.',
    arguments: [
      {
        name: 'root',
        description: 'Absolute project root (default: CGB_ROOT or server cwd)',
        required: false,
      },
      { name: 'base', description: 'Base git ref (default: main)', required: false },
    ],
  },
] as const;

// ─── Prompt message builders ──────────────────────────────────────────────────

function buildReviewChangesPrompt(root: string, base: string): string {
  return [
    `You are performing a code review for the project at \`${root}\`.`,
    '',
    `**Step 1** — Call \`cgb_review_context\` with root="${root}"${base !== 'main' ? ` base="${base}"` : ''} to retrieve the change summary, risk score, and affected nodes.`,
    '**Step 2** — For each high-risk file identified, call `cgb_deps` and `cgb_impact` to understand upstream and downstream blast-radius.',
    '**Step 3** — Call `cgb_dead_code` to check whether any of the changed files introduce dead code.',
    '**Step 4** — Summarise your findings as a structured review with sections: Summary, Risk Assessment, Potential Issues, and Recommendations.',
  ].join('\n');
}

function buildArchitectureMapPrompt(root: string): string {
  return [
    `You are mapping the architecture of the project at \`${root}\`.`,
    '',
    '**Step 1** — Call `cgb_stats` to get a high-level overview of the graph.',
    '**Step 2** — Call `cgb_architecture` to get layer breakdown and key hubs.',
    '**Step 3** — Call `cgb_communities` to list module clusters.',
    '**Step 4** — For each community, call `cgb_entry_points` to surface public API surfaces.',
    '**Step 5** — Produce a structured architecture document with: Overview, Layers, Module Clusters, Entry Points, and Dependencies.',
  ].join('\n');
}

function buildDebugIssuePrompt(root: string, symptom: string, entry?: string): string {
  const entryHint = entry
    ? `The suspected entry point is \`${entry}\`. Start with \`cgb_call_chain\` using nodeId="${entry}".`
    : 'Use `cgb_entry_points` to identify candidate entry points first.';
  return [
    `You are debugging the following issue in the project at \`${root}\`:`,
    '',
    `> **Symptom**: ${symptom}`,
    '',
    `**Step 1** — ${entryHint}`,
    '**Step 2** — For each node in the call chain, call `cgb_deps` to check external dependencies that might be the source of failure.',
    '**Step 3** — Call `cgb_criticality` to identify which nodes in the chain are most business-critical.',
    '**Step 4** — Call `cgb_search` with relevant keywords from the symptom to find related code.',
    '**Step 5** — Propose at least three root-cause hypotheses ranked by likelihood, and suggest targeted fixes for each.',
  ].join('\n');
}

function buildOnboardDeveloperPrompt(root: string): string {
  return [
    `You are onboarding a new developer to the project at \`${root}\`.`,
    '',
    'Please produce a concise onboarding guide by following these steps:',
    '',
    "**Step 1** — Call `cgb_stats` for a bird's-eye view (file count, node count, edge count).",
    '**Step 2** — Call `cgb_architecture` to explain the layer structure.',
    '**Step 3** — Call `cgb_communities` to describe the major module clusters.',
    '**Step 4** — Call `cgb_entry_points` to list the main public entry points a developer will interact with.',
    '**Step 5** — Call `cgb_wiki_generate` to produce a full Markdown wiki and include a link/summary.',
    '',
    'Format the output as: Welcome, Project Structure, Module Map, Getting Started (key entry points), and Next Steps.',
  ].join('\n');
}

function buildPreMergeCheckPrompt(root: string, base: string): string {
  return [
    `You are performing a pre-merge quality check for the project at \`${root}\` against base ref \`${base}\`.`,
    '',
    '**Step 1** — Call `cgb_detect_changes` to list all modified files and their risk scores.',
    '**Step 2** — Call `cgb_review_context` to get the full review summary.',
    '**Step 3** — For every file with risk > 70, call `cgb_impact` to enumerate affected downstream consumers.',
    '**Step 4** — Call `cgb_dead_code` to ensure no dead code is being introduced.',
    '**Step 5** — Call `cgb_refactor_suggest` to flag any structural issues introduced by the changes.',
    '',
    'Produce a **Pre-Merge Checklist** with sections: Changed Files & Risk, Blast Radius, Dead Code Check, Structural Issues, and a Go/No-Go recommendation.',
  ].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  serverOptions = normalizeOptions(options);
  const server = new Server(
    { name: 'cgb', version: VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  );

  // eslint-disable-next-line @typescript-eslint/require-await -- async kept for API/signature compatibility
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(serverOptions),
  }));
  // Prompts drive mutating tools (cgb_init etc.), so none are served read-only.
  // eslint-disable-next-line @typescript-eslint/require-await -- async kept for API/signature compatibility
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: serverOptions.readOnly ? [] : PROMPTS,
  }));

  // eslint-disable-next-line @typescript-eslint/require-await -- async kept for API/signature compatibility
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: pArgs = {} } = request.params;
    const root = resolveRoot({ root: pArgs['root'] as string | undefined });
    const base: string = pArgs['base'] ?? 'main';

    switch (name) {
      case 'review_changes':
        return {
          description: 'Code-review prompt with cgb context',
          messages: [
            { role: 'user', content: { type: 'text', text: buildReviewChangesPrompt(root, base) } },
          ],
        };
      case 'architecture_map':
        return {
          description: 'Architecture mapping prompt',
          messages: [
            { role: 'user', content: { type: 'text', text: buildArchitectureMapPrompt(root) } },
          ],
        };
      case 'debug_issue': {
        const symptom: string = pArgs['symptom'] ?? 'unknown error';
        const entry: string | undefined = pArgs['entry'] as string | undefined;
        return {
          description: 'Debugging prompt with call-chain tracing',
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: buildDebugIssuePrompt(root, symptom, entry) },
            },
          ],
        };
      }
      case 'onboard_developer':
        return {
          description: 'Developer onboarding guide',
          messages: [
            { role: 'user', content: { type: 'text', text: buildOnboardDeveloperPrompt(root) } },
          ],
        };
      case 'pre_merge_check':
        return {
          description: 'Pre-merge quality checklist',
          messages: [
            { role: 'user', content: { type: 'text', text: buildPreMergeCheckPrompt(root, base) } },
          ],
        };
      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    return handleTool(name, args);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', () => process.exit(0));
}
