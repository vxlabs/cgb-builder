/**
 * Code Graph Builder — MCP Server
 *
 * Exposes cgb capabilities to AI agents (Cursor, Claude Code, etc.)
 * via the Model Context Protocol over stdio transport.
 *
 * Tools exposed:
 *   cgb_init              — scan a project and build / refresh the graph
 *   cgb_deps              — get dependencies of a file
 *   cgb_impact            — impact analysis for a file
 *   cgb_search            — search nodes by name / path
 *   cgb_bundle            — generate AI context bundle (Markdown)
 *   cgb_stats             — get graph statistics
 *   cgb_path              — shortest dependency path between two files
 *   cgb_detect_changes    — detect git changes with risk scoring
 *   cgb_review_context    — build review context for AI reviewers
 *   cgb_large_functions   — find large / complex functions by connectivity
 *   cgb_entry_points      — find call-chain entry points
 *   cgb_call_chain        — trace call chain from a node
 *   cgb_criticality       — score nodes by criticality
 *   cgb_communities       — detect communities / module clusters
 *   cgb_architecture      — high-level architecture overview
 *   cgb_dead_code         — detect unreachable / dead code
 *   cgb_rename_preview    — preview impact of renaming a symbol (with newName → stores for apply)
 *   cgb_apply_refactor    — apply a stored rename preview to disk
 *   cgb_refactor_suggest  — suggest structural refactoring opportunities
 *   cgb_wiki_generate     — generate Markdown wiki from graph
 *   cgb_wiki_section      — generate wiki for a single community
 *   cgb_registry_register — register a repo in the global registry
 *   cgb_registry_list     — list registered repos
 *   cgb_registry_search   — search across all registered repos
 *   cgb_embed_build       — compute and store vector embeddings
 *   cgb_embed_search      — hybrid search (BM25 + vector + LIKE → RRF)
 */

import * as path from 'path';
import * as fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Service bootstrap ────────────────────────────────────────────────────────

async function getServices(root: string) {
  const { GraphDb } = await import('../graph/db.js');
  const { GraphEngine } = await import('../graph/engine.js');
  const { Parser } = await import('../parser/index.js');
  const { BundleGenerator } = await import('../bundle/generator.js');

  const db = new GraphDb(root);
  await db.init();
  const engine = new GraphEngine(db);
  const parser = new Parser(db, root);
  const bundle = new BundleGenerator(db, engine, root);
  return { db, engine, parser, bundle };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTarget(root: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(root, target);
}

function ok(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'cgb_init',
    description:
      'Scan a project directory and build (or refresh) the code graph. ' +
      'Must be run before using any other cgb tools. ' +
      'Returns graph stats and architectural layer summary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Absolute path to the project root directory' },
        force: { type: 'boolean', description: 'Re-parse all files even if unchanged (default: false)' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_deps',
    description:
      'Get all dependencies (imports) of a file. ' +
      'Returns direct and transitive dependencies with file paths.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory (must have been initialized with cgb_init)' },
        target: { type: 'string', description: 'Relative or absolute path to the file' },
        depth: { type: 'number', description: 'How many levels of transitive deps to include (default: 3)' },
      },
      required: ['root', 'target'],
    },
  },
  {
    name: 'cgb_impact',
    description:
      'Impact analysis: determine which files would be affected if a given file changes. ' +
      'Returns a sorted list of affected files with their dependency depth.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        target: { type: 'string', description: 'Relative or absolute path to the file being changed' },
        depth: { type: 'number', description: 'Maximum traversal depth (default: 10)' },
      },
      required: ['root', 'target'],
    },
  },
  {
    name: 'cgb_search',
    description:
      'Search for graph nodes by name, description, or file path. ' +
      'Useful for finding classes, functions, or files without knowing their exact location.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        query: { type: 'string', description: 'Search term (matches node name, description, and file path)' },
      },
      required: ['root', 'query'],
    },
  },
  {
    name: 'cgb_bundle',
    description:
      'Generate an AI-optimised context bundle for a file. ' +
      'The bundle is a compact Markdown document containing: file summary, ' +
      'direct dependencies, reverse dependencies, class hierarchy, and optionally the full source. ' +
      'Use this to give an AI agent the structural context it needs before editing a file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        target: { type: 'string', description: 'Relative or absolute path to the file to bundle' },
        depth: { type: 'number', description: 'Dependency traversal depth (default: 2)' },
        includeSource: { type: 'boolean', description: 'Include the full source of the target file in the bundle (default: true)' },
      },
      required: ['root', 'target'],
    },
  },
  {
    name: 'cgb_stats',
    description:
      'Get summary statistics for the project graph: ' +
      'file count, node count, edge count, node type breakdown, ' +
      'cycle detection results, and architectural layer distribution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_path',
    description:
      'Find the shortest dependency path between two files. ' +
      'Useful for understanding how one module depends (transitively) on another.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        from: { type: 'string', description: 'Relative or absolute path to the source file' },
        to: { type: 'string', description: 'Relative or absolute path to the target file' },
      },
      required: ['root', 'from', 'to'],
    },
  },
  {
    name: 'cgb_detect_changes',
    description:
      'Detect git changes and analyse their impact on the code graph. ' +
      'Returns a risk-scored breakdown of every changed file including blast radius, ' +
      'security relevance, and test coverage gaps. ' +
      'Requires the project to have been initialised with cgb_init and to be a git repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Absolute path to the project root (must be inside a git repository)' },
        base: { type: 'string', description: 'Git base ref to diff against (default: HEAD~1). Examples: main, HEAD~3, abc1234' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_review_context',
    description:
      'Build a focused code-review context for all changes since a given git ref. ' +
      'Returns changed files, blast-radius (affected) files, relevant test files, ' +
      'top focus areas, and a Markdown review brief. ' +
      'Ideal for priming an AI reviewer before it reads the diff.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Absolute path to the project root (must be inside a git repository)' },
        base: { type: 'string', description: 'Git base ref to diff against (default: HEAD~1). Examples: main, HEAD~3, abc1234' },
        format: {
          type: 'string',
          enum: ['json', 'markdown'],
          description: 'Output format — "json" for structured data, "markdown" for a human-readable brief (default: markdown)',
        },
      },
      required: ['root'],
    },
  },
  // ─── Flows tools ──────────────────────────────────────────────────────────
  {
    name: 'cgb_large_functions',
    description:
      'Find the most complex functions and methods by connectivity metrics (fan-in + fan-out). ' +
      'High fan-out functions often need refactoring; high fan-in functions are critical hotspots.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        limit: { type: 'number', description: 'Maximum results to return (default: 20)' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_entry_points',
    description:
      'Find entry points: functions, methods, or files that have no inbound calls ' +
      '(i.e. they are the "top" of call chains — likely public APIs or CLI handlers). ' +
      'Sorted by fan-out descending.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        limit: { type: 'number', description: 'Maximum entry points to return (default: 30)' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_call_chain',
    description:
      'Trace the full call chain starting from a given node. ' +
      'Returns each step in the chain with depth, name, file, and kind. ' +
      'Useful for understanding execution flows and debugging.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        nodeId: { type: 'string', description: 'Node ID to trace from (e.g. "function:path/to/file.ts:myFunc")' },
        maxDepth: { type: 'number', description: 'Maximum depth to trace (default: 5)' },
      },
      required: ['root', 'nodeId'],
    },
  },
  {
    name: 'cgb_criticality',
    description:
      'Score all non-external functions, methods, classes and interfaces by criticality. ' +
      'Criticality is computed from fan-in (weight 3×) + fan-out. ' +
      'Returns top nodes sorted by score with labels: critical / high / medium / low.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        limit: { type: 'number', description: 'Maximum results to return (default: 20)' },
      },
      required: ['root'],
    },
  },
  // ─── Community tools ──────────────────────────────────────────────────────
  {
    name: 'cgb_communities',
    description:
      'Detect communities (module clusters) using weighted Louvain algorithm. ' +
      'Persists results to the graph DB (writes community_id to nodes) so getCommunityMembers works. ' +
      'Returns each cluster with label, files, role, cohesion score, and top hub symbols. Sorted by size descending.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_architecture',
    description:
      'Generate a high-level architecture overview: communities, dependency layers, ' +
      'circular dependencies, orphan files, and a health score. ' +
      'Ideal for onboarding or architecture review sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
      },
      required: ['root'],
    },
  },
  // ─── Refactor tools ───────────────────────────────────────────────────────
  {
    name: 'cgb_dead_code',
    description:
      'Find potentially dead code: functions, methods, classes, and types with no inbound ' +
      'calls or imports. Does not flag test-file nodes. ' +
      'Use as a starting point for cleanup — always verify before deleting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        limit: { type: 'number', description: 'Maximum results to return (default: 30)' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_rename_preview',
    description:
      'Preview the impact of renaming a symbol. ' +
      'When newName is provided, returns concrete file edits with a refactorId that can be passed to cgb_apply_refactor. ' +
      'When newName is omitted, returns edge-level impact only (no stored preview). ' +
      'Does NOT make any disk changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        nodeId: { type: 'string', description: 'Node ID of the symbol to rename (use cgb_search to find it)' },
        newName: { type: 'string', description: 'New name for the symbol (required to generate a refactorId for apply)' },
      },
      required: ['root', 'nodeId'],
    },
  },
  {
    name: 'cgb_apply_refactor',
    description:
      'Apply a previously previewed rename to disk. ' +
      'Requires a refactorId from cgb_rename_preview (with newName). ' +
      'Previews expire after 10 minutes. Includes path-traversal safety checks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Absolute path to the project root (used for safety checks)' },
        refactorId: { type: 'string', description: '8-char hex ID returned by cgb_rename_preview' },
      },
      required: ['root', 'refactorId'],
    },
  },
  {
    name: 'cgb_refactor_suggest',
    description:
      'Suggest structural refactoring opportunities based on connectivity metrics. ' +
      'Flags high fan-out functions (extract helpers) and high fan-in files (split module).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        limit: { type: 'number', description: 'Maximum suggestions to return (default: 10)' },
      },
      required: ['root'],
    },
  },
  // ─── Wiki tools ───────────────────────────────────────────────────────────
  {
    name: 'cgb_wiki_generate',
    description:
      'Generate a Markdown wiki from the code graph. ' +
      'Creates one page per community plus an index/overview page. ' +
      'Optionally writes files to disk.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        outputDir: { type: 'string', description: 'Optional output directory. If set, writes .md files there.' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_wiki_section',
    description:
      'Generate a Markdown wiki page for a single community / module cluster. ' +
      'Pass the community index (0-based) from cgb_communities output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Project root directory' },
        communityIndex: { type: 'number', description: 'Index (0-based) of the community from cgb_communities output' },
      },
      required: ['root', 'communityIndex'],
    },
  },
  // ─── Registry tools ───────────────────────────────────────────────────────
  {
    name: 'cgb_registry_register',
    description:
      'Register a project in the global cgb registry (~/.cgb/registry.json). ' +
      'Allows cross-repo search with cgb_registry_search.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Absolute path to the project root' },
        name: { type: 'string', description: 'Optional friendly name for the project (defaults to directory name)' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_registry_list',
    description: 'List all projects registered in the global cgb registry.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cgb_registry_search',
    description:
      'Search for symbols across all registered cgb projects. ' +
      'Returns matching nodes from every repo along with their source project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search term to match against node names, descriptions and file paths' },
        maxPerRepo: { type: 'number', description: 'Maximum results per repo (default: 10)' },
      },
      required: ['query'],
    },
  },
  // ─── Embed tools ─────────────────────────────────────────────────────────────
  {
    name: 'cgb_embed_build',
    description:
      'Compute and store vector embeddings for all graph nodes. ' +
      'Required before cgb_embed_search can use real vector similarity (otherwise falls back to TF-IDF). ' +
      'Supports provider: "local" (@xenova/transformers), "google" (GOOGLE_API_KEY), "minimax" (MINIMAX_API_KEY). ' +
      '"local" downloads ~30MB ONNX model on first use.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Absolute path to the project root' },
        provider: { type: 'string', description: 'Embedding provider: "local" | "google" | "minimax" (default: "local")' },
      },
      required: ['root'],
    },
  },
  {
    name: 'cgb_embed_search',
    description:
      'Hybrid semantic search: BM25 (FTS5) + vector cosine + keyword LIKE, merged via Reciprocal Rank Fusion. ' +
      'Falls back to TF-IDF if no embeddings have been built (run cgb_embed_build first for best results). ' +
      'Returns nodes whose name/kind/path/description best match the query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Absolute path to the project root (must be initialised with cgb_init)' },
        query: { type: 'string', description: 'Free-text query — e.g. "authentication middleware" or "database connection pool"' },
        limit: { type: 'number', description: 'Maximum results to return (default: 20)' },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to boost — nodes in these files score 1.5x higher',
        },
      },
      required: ['root', 'query'],
    },
  },
  {
    name: 'cgb_embed_similar',
    description:
      'Find nodes that are semantically similar to a given node (by id). ' +
      'Useful for finding related functions, classes, or files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        root: { type: 'string', description: 'Absolute path to the project root' },
        nodeId: { type: 'string', description: 'ID of the reference node' },
        limit: { type: 'number', description: 'Maximum results (default: 10)' },
      },
      required: ['root', 'nodeId'],
    },
  },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleInit(args: { root: string; force?: boolean }) {
  const { root, force = false } = args;
  if (!fs.existsSync(root)) {
    return err(`Directory does not exist: ${root}`);
  }

  const { db, parser, engine } = await getServices(root);
  try {
    const result = await parser.scanAll(force);
    const stats = db.getStats();
    const byKind = db.getNodeCountByKind();
    const layers = engine.layers();

    return ok({
      success: true,
      durationMs: result.durationMs,
      parsed: result.parsed,
      skipped: result.skipped,
      errors: result.errors.slice(0, 10),
      graph: {
        files: stats.files,
        nodes: stats.nodes,
        edges: stats.edges,
        byKind,
      },
      layers: layers.slice(0, 15),
    });
  } finally {
    db.close();
  }
}

async function handleDeps(args: { root: string; target: string; depth?: number }) {
  const { root, target, depth = 3 } = args;
  const { db, engine } = await getServices(root);
  try {
    const absTarget = resolveTarget(root, target);
    const nodeId = `file:${absTarget}`;
    const result = engine.deps(nodeId, depth);
    if (!result) {
      return err(`File not found in graph: ${target}\nRun cgb_init first.`);
    }
    return ok({
      target: { id: result.target.id, name: result.target.name, filePath: result.target.filePath },
      direct: result.direct.map((n) => ({
        id: n.id,
        name: n.name,
        filePath: n.filePath,
        isExternal: n.isExternal,
        kind: n.kind,
      })),
      transitive: result.transitive.map((n) => ({
        id: n.id,
        name: n.name,
        filePath: n.filePath,
        isExternal: n.isExternal,
        kind: n.kind,
      })),
    });
  } finally {
    db.close();
  }
}

async function handleImpact(args: { root: string; target: string; depth?: number }) {
  const { root, target, depth = 10 } = args;
  const { db, engine } = await getServices(root);
  try {
    const absTarget = resolveTarget(root, target);
    const nodeId = `file:${absTarget}`;
    const result = engine.impact(nodeId, depth);
    if (!result) {
      return err(`File not found in graph: ${target}\nRun cgb_init first.`);
    }
    return ok({
      target: { id: result.target.id, name: result.target.name, filePath: result.target.filePath },
      affectedCount: result.affected.length,
      affected: result.affected.map((a) => ({
        depth: a.depth,
        id: a.node.id,
        name: a.node.name,
        filePath: a.node.filePath,
      })),
    });
  } finally {
    db.close();
  }
}

async function handleSearch(args: { root: string; query: string }) {
  const { root, query } = args;
  const { db, engine } = await getServices(root);
  try {
    const results = engine.search(query);
    return ok({
      query,
      count: results.length,
      results: results.slice(0, 30).map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        filePath: n.filePath,
        isExternal: n.isExternal,
        description: n.description,
      })),
    });
  } finally {
    db.close();
  }
}

async function handleBundle(args: {
  root: string;
  target: string;
  depth?: number;
  includeSource?: boolean;
}) {
  const { root, target, depth = 2, includeSource = true } = args;
  const { db, bundle } = await getServices(root);
  try {
    const absTarget = resolveTarget(root, target);
    const result = bundle.generate(absTarget, { depth, includeSource });
    const markdown = bundle.render(result);
    return ok({
      target: absTarget,
      tokenEstimate: result.totalTokenEstimate,
      bundle: markdown,
    });
  } finally {
    db.close();
  }
}

async function handleStats(args: { root: string }) {
  const { root } = args;
  const { db, engine } = await getServices(root);
  try {
    const stats = db.getStats();
    const byKind = db.getNodeCountByKind();
    const layers = engine.layers();
    const cycles = engine.detectCycles();
    const orphans = engine.orphans();
    return ok({
      files: stats.files,
      nodes: stats.nodes,
      edges: stats.edges,
      byKind,
      layers: layers.slice(0, 20),
      cycleCount: cycles.length,
      cycles: cycles.slice(0, 5),
      orphanCount: orphans.length,
    });
  } finally {
    db.close();
  }
}

async function handlePath(args: { root: string; from: string; to: string }) {
  const { root, from, to } = args;
  const { db, engine } = await getServices(root);
  try {
    const absFrom = resolveTarget(root, from);
    const absTo = resolveTarget(root, to);
    const result = engine.path(`file:${absFrom}`, `file:${absTo}`);
    if (!result) {
      return ok({
        found: false,
        from,
        to,
        message: `No dependency path found from ${from} to ${to}`,
      });
    }
    return ok({
      found: true,
      length: result.path.length,
      path: result.path.map((n) => ({ id: n.id, name: n.name, filePath: n.filePath })),
      edges: result.edges.map((e) => ({ kind: e.kind, reason: e.reason })),
    });
  } finally {
    db.close();
  }
}

// ─── Git tool handlers ────────────────────────────────────────────────────────

async function handleDetectChanges(args: { root: string; base?: string }) {
  const { root, base = 'HEAD~1' } = args;
  if (!fs.existsSync(root)) {
    return err(`Directory does not exist: ${root}`);
  }

  const { getGitChanges, isGitRepo } = await import('../git/diff.js');
  if (!isGitRepo(root)) {
    return err(`Not a git repository: ${root}`);
  }

  const { db, engine } = await getServices(root);
  try {
    const { analyzeChanges } = await import('../git/changes.js');
    const gitChanges = await getGitChanges(root, base);
    if (gitChanges.length === 0) {
      return ok({ message: `No changes found between ${base} and HEAD`, changes: [] });
    }
    const analysis = analyzeChanges(gitChanges, db, engine);
    return ok(analysis);
  } finally {
    db.close();
  }
}

async function handleReviewContext(args: { root: string; base?: string; format?: 'json' | 'markdown' }) {
  const { root, base = 'HEAD~1', format = 'markdown' } = args;
  if (!fs.existsSync(root)) {
    return err(`Directory does not exist: ${root}`);
  }

  const { isGitRepo } = await import('../git/diff.js');
  if (!isGitRepo(root)) {
    return err(`Not a git repository: ${root}`);
  }

  const { db, engine } = await getServices(root);
  try {
    const { buildReviewContext, formatReviewContext } = await import('../git/review-context.js');
    const ctx = await buildReviewContext(root, db, engine, base);

    if (format === 'json') {
      return ok(ctx);
    }

    return ok({ markdown: formatReviewContext(ctx), tokenEstimate: ctx.tokenEstimate });
  } finally {
    db.close();
  }
}

// ─── Flows tool handlers ──────────────────────────────────────────────────────

async function handleLargeFunctions(args: { root: string; limit?: number }) {
  const { root, limit = 20 } = args;
  const { db } = await getServices(root);
  try {
    const { findLargeFunctions } = await import('../flows/index.js');
    return ok(findLargeFunctions(db, limit));
  } finally {
    db.close();
  }
}

async function handleEntryPoints(args: { root: string; limit?: number }) {
  const { root, limit = 30 } = args;
  const { db } = await getServices(root);
  try {
    const { FlowsAnalyzer } = await import('../flows/index.js');
    const analyzer = new FlowsAnalyzer(db);
    return ok(analyzer.entryPoints(limit));
  } finally {
    db.close();
  }
}

async function handleCallChain(args: { root: string; nodeId: string; maxDepth?: number }) {
  const { root, nodeId, maxDepth = 5 } = args;
  const { db } = await getServices(root);
  try {
    const { FlowsAnalyzer } = await import('../flows/index.js');
    const analyzer = new FlowsAnalyzer(db);
    const chain = analyzer.callChain(nodeId, maxDepth);
    if (chain.length === 0) {
      return err(`Node not found or no outbound calls: ${nodeId}`);
    }
    return ok({ nodeId, stepCount: chain.length, chain });
  } finally {
    db.close();
  }
}

async function handleCriticality(args: { root: string; limit?: number }) {
  const { root, limit = 20 } = args;
  const { db } = await getServices(root);
  try {
    const { FlowsAnalyzer } = await import('../flows/index.js');
    const analyzer = new FlowsAnalyzer(db);
    return ok(analyzer.criticalityScores(limit));
  } finally {
    db.close();
  }
}

// ─── Community tool handlers ──────────────────────────────────────────────────

async function handleCommunities(args: { root: string }) {
  const { root } = args;
  const { db, engine } = await getServices(root);
  try {
    const { CommunityDetector } = await import('../communities/index.js');
    const detector = new CommunityDetector(db, engine);
    const communities = detector.detectAndPersist();
    db.persist();
    return ok(communities);
  } finally {
    db.close();
  }
}

async function handleArchitecture(args: { root: string }) {
  const { root } = args;
  const { db, engine } = await getServices(root);
  try {
    const { CommunityDetector } = await import('../communities/index.js');
    const detector = new CommunityDetector(db, engine);
    return ok(detector.overview());
  } finally {
    db.close();
  }
}

// ─── Refactor tool handlers ───────────────────────────────────────────────────

async function handleDeadCode(args: { root: string; limit?: number }) {
  const { root, limit = 30 } = args;
  const { db } = await getServices(root);
  try {
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    const analyzer = new RefactorAnalyzer(db);
    return ok(analyzer.deadCode(limit));
  } finally {
    db.close();
  }
}

async function handleRenamePreview(args: { root: string; nodeId: string; newName?: string }) {
  const { root, nodeId, newName } = args;
  const { db } = await getServices(root);
  try {
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    const analyzer = new RefactorAnalyzer(db);
    if (newName) {
      const preview = analyzer.renamePreviewWithEdits(nodeId, newName);
      if (!preview) {
        return err(`Node not found: ${nodeId}\nUse cgb_search to find the correct node ID.`);
      }
      return ok(preview);
    }
    const preview = analyzer.renamePreview(nodeId);
    if (!preview) {
      return err(`Node not found: ${nodeId}\nUse cgb_search to find the correct node ID.`);
    }
    return ok(preview);
  } finally {
    db.close();
  }
}

async function handleApplyRefactor(args: { root: string; refactorId: string }) {
  const { root, refactorId } = args;
  const { applyRefactor } = await import('../refactor/index.js');
  return ok(applyRefactor(refactorId, root));
}

async function handleRefactorSuggest(args: { root: string; limit?: number }) {
  const { root, limit = 10 } = args;
  const { db } = await getServices(root);
  try {
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    const analyzer = new RefactorAnalyzer(db);
    return ok(analyzer.suggestions(limit));
  } finally {
    db.close();
  }
}

// ─── Wiki tool handlers ───────────────────────────────────────────────────────

async function handleWikiGenerate(args: { root: string; outputDir?: string }) {
  const { root, outputDir } = args;
  const { db, engine } = await getServices(root);
  try {
    const { CommunityDetector } = await import('../communities/index.js');
    const { WikiGenerator } = await import('../wiki/index.js');
    const detector = new CommunityDetector(db, engine);
    const generator = new WikiGenerator(db, detector);

    if (outputDir) {
      const absOut = path.isAbsolute(outputDir) ? outputDir : path.resolve(root, outputDir);
      const written = generator.writeToDir(absOut);
      return ok({ outputDir: absOut, writtenFiles: written.length, files: written });
    }

    const result = generator.generate();
    return ok({
      totalPages: result.totalPages,
      indexPage: result.indexPage,
      pages: result.pages.map((p) => ({ title: p.title, slug: p.slug, communityId: p.communityId, chars: p.content.length })),
    });
  } finally {
    db.close();
  }
}

async function handleWikiSection(args: { root: string; communityIndex: number }) {
  const { root, communityIndex } = args;
  const { db, engine } = await getServices(root);
  try {
    const { CommunityDetector } = await import('../communities/index.js');
    const { WikiGenerator } = await import('../wiki/index.js');
    const detector = new CommunityDetector(db, engine);
    const communities = detector.detect();

    if (communityIndex < 0 || communityIndex >= communities.length) {
      return err(`communityIndex ${communityIndex} out of range. There are ${communities.length} communities (0-based).`);
    }

    const generator = new WikiGenerator(db, detector);
    const result = generator.generate();
    const page = result.pages[communityIndex];

    if (!page) {
      return err(`No wiki page generated for community index ${communityIndex}.`);
    }

    return ok(page);
  } finally {
    db.close();
  }
}

// ─── Registry tool handlers ───────────────────────────────────────────────────

async function handleRegistryRegister(args: { root: string; name?: string }) {
  const { root, name = '' } = args;
  if (!fs.existsSync(root)) {
    return err(`Directory does not exist: ${root}`);
  }
  const { RegistryManager } = await import('../registry/index.js');
  const registry = new RegistryManager();
  const entry = registry.register(name, root);
  return ok({ registered: entry });
}

async function handleRegistryList() {
  const { RegistryManager } = await import('../registry/index.js');
  const registry = new RegistryManager();
  const entries = registry.load();
  return ok({ count: entries.length, repos: entries });
}

async function handleRegistrySearch(args: { query: string; maxPerRepo?: number }) {
  const { query, maxPerRepo = 10 } = args;
  const { RegistryManager } = await import('../registry/index.js');
  const registry = new RegistryManager();
  const results = await registry.search(query, maxPerRepo);
  return ok({ query, count: results.length, results });
}

// ─── Embed handlers ───────────────────────────────────────────────────────────

async function handleEmbedBuild(args: { root: string; provider?: string }) {
  const { root, provider = 'local' } = args;
  const { db } = await getServices(root);
  try {
    const { embedNodes, getProvider } = await import('../embed/index.js');
    const p = getProvider(provider);
    const result = await embedNodes(db, p);
    db.persist();
    return ok({ provider, ...result });
  } finally {
    db.close();
  }
}

async function handleEmbedSearch(args: {
  root: string;
  query: string;
  limit?: number;
  contextFiles?: string[];
}) {
  const { root, query, limit = 20, contextFiles } = args;
  const { db } = await getServices(root);
  try {
    const { hybridSearch } = await import('../embed/index.js');
    const results = await hybridSearch(db, query, { limit, contextFiles });
    return ok({ query, count: results.length, results });
  } finally {
    db.close();
  }
}

async function handleEmbedSimilar(args: { root: string; nodeId: string; limit?: number }) {
  const { root, nodeId, limit = 10 } = args;
  const { db } = await getServices(root);
  const { EmbedSearcher } = await import('../embed/index.js');
  const searcher = new EmbedSearcher(db);
  const results = searcher.findSimilar(nodeId, limit);
  return ok({ nodeId, count: results.length, results });
}

// ─── Prompt definitions ───────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: 'review_changes',
    description:
      'Generates a focused code-review prompt for the current git diff. ' +
      'Pass root so the agent can call cgb_review_context automatically.',
    arguments: [
      { name: 'root', description: 'Absolute project root', required: true },
      { name: 'base', description: 'Base git ref to diff against (default: main)', required: false },
    ],
  },
  {
    name: 'architecture_map',
    description:
      'Produces a prompt that asks the agent to describe the high-level architecture ' +
      'of the project using cgb_architecture and cgb_communities.',
    arguments: [
      { name: 'root', description: 'Absolute project root', required: true },
    ],
  },
  {
    name: 'debug_issue',
    description:
      'Scaffolds a debugging prompt: given a symptom, the agent traces call chains, ' +
      'checks dependencies, and proposes root-cause hypotheses.',
    arguments: [
      { name: 'root', description: 'Absolute project root', required: true },
      { name: 'symptom', description: 'Short description of the observed bug or failure', required: true },
      { name: 'entry', description: 'File or function name that is the suspected entry point', required: false },
    ],
  },
  {
    name: 'onboard_developer',
    description:
      'Creates an onboarding prompt that walks a new developer through the codebase: ' +
      'architecture overview, key entry points, communities, and top-level wiki.',
    arguments: [
      { name: 'root', description: 'Absolute project root', required: true },
    ],
  },
  {
    name: 'pre_merge_check',
    description:
      'Generates a pre-merge checklist prompt: detects changes, scores risk, ' +
      'checks for dead code, and summarises impact for a human reviewer.',
    arguments: [
      { name: 'root', description: 'Absolute project root', required: true },
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
    '**Step 1** — Call `cgb_stats` for a bird\'s-eye view (file count, node count, edge count).',
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
    '**Step 3** — For every file with risk > 0.7, call `cgb_impact` to enumerate affected downstream consumers.',
    '**Step 4** — Call `cgb_dead_code` to ensure no dead code is being introduced.',
    '**Step 5** — Call `cgb_refactor_suggest` to flag any structural issues introduced by the changes.',
    '',
    'Produce a **Pre-Merge Checklist** with sections: Changed Files & Risk, Blast Radius, Dead Code Check, Structural Issues, and a Go/No-Go recommendation.',
  ].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'cgb', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {} } });

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // List available prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

  // Resolve a prompt by name
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: pArgs = {} } = request.params;
    const root: string = (pArgs['root'] as string) ?? '';
    const base: string = (pArgs['base'] as string) ?? 'main';

    switch (name) {
      case 'review_changes':
        return {
          description: 'Code-review prompt with cgb context',
          messages: [{ role: 'user', content: { type: 'text', text: buildReviewChangesPrompt(root, base) } }],
        };
      case 'architecture_map':
        return {
          description: 'Architecture mapping prompt',
          messages: [{ role: 'user', content: { type: 'text', text: buildArchitectureMapPrompt(root) } }],
        };
      case 'debug_issue': {
        const symptom: string = (pArgs['symptom'] as string) ?? 'unknown error';
        const entry: string | undefined = pArgs['entry'] as string | undefined;
        return {
          description: 'Debugging prompt with call-chain tracing',
          messages: [{ role: 'user', content: { type: 'text', text: buildDebugIssuePrompt(root, symptom, entry) } }],
        };
      }
      case 'onboard_developer':
        return {
          description: 'Developer onboarding guide',
          messages: [{ role: 'user', content: { type: 'text', text: buildOnboardDeveloperPrompt(root) } }],
        };
      case 'pre_merge_check':
        return {
          description: 'Pre-merge quality checklist',
          messages: [{ role: 'user', content: { type: 'text', text: buildPreMergeCheckPrompt(root, base) } }],
        };
      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case 'cgb_init':
          return await handleInit(args as Parameters<typeof handleInit>[0]);
        case 'cgb_deps':
          return await handleDeps(args as Parameters<typeof handleDeps>[0]);
        case 'cgb_impact':
          return await handleImpact(args as Parameters<typeof handleImpact>[0]);
        case 'cgb_search':
          return await handleSearch(args as Parameters<typeof handleSearch>[0]);
        case 'cgb_bundle':
          return await handleBundle(args as Parameters<typeof handleBundle>[0]);
        case 'cgb_stats':
          return await handleStats(args as Parameters<typeof handleStats>[0]);
        case 'cgb_path':
          return await handlePath(args as Parameters<typeof handlePath>[0]);
        case 'cgb_detect_changes':
          return await handleDetectChanges(args as Parameters<typeof handleDetectChanges>[0]);
        case 'cgb_review_context':
          return await handleReviewContext(args as Parameters<typeof handleReviewContext>[0]);
        // Flows
        case 'cgb_large_functions':
          return await handleLargeFunctions(args as Parameters<typeof handleLargeFunctions>[0]);
        case 'cgb_entry_points':
          return await handleEntryPoints(args as Parameters<typeof handleEntryPoints>[0]);
        case 'cgb_call_chain':
          return await handleCallChain(args as Parameters<typeof handleCallChain>[0]);
        case 'cgb_criticality':
          return await handleCriticality(args as Parameters<typeof handleCriticality>[0]);
        // Communities
        case 'cgb_communities':
          return await handleCommunities(args as Parameters<typeof handleCommunities>[0]);
        case 'cgb_architecture':
          return await handleArchitecture(args as Parameters<typeof handleArchitecture>[0]);
        // Refactor
        case 'cgb_dead_code':
          return await handleDeadCode(args as Parameters<typeof handleDeadCode>[0]);
        case 'cgb_rename_preview':
          return await handleRenamePreview(args as Parameters<typeof handleRenamePreview>[0]);
        case 'cgb_apply_refactor':
          return await handleApplyRefactor(args as Parameters<typeof handleApplyRefactor>[0]);
        case 'cgb_refactor_suggest':
          return await handleRefactorSuggest(args as Parameters<typeof handleRefactorSuggest>[0]);
        // Wiki
        case 'cgb_wiki_generate':
          return await handleWikiGenerate(args as Parameters<typeof handleWikiGenerate>[0]);
        case 'cgb_wiki_section':
          return await handleWikiSection(args as Parameters<typeof handleWikiSection>[0]);
        // Registry
        case 'cgb_registry_register':
          return await handleRegistryRegister(args as Parameters<typeof handleRegistryRegister>[0]);
        case 'cgb_registry_list':
          return await handleRegistryList();
        case 'cgb_registry_search':
          return await handleRegistrySearch(args as Parameters<typeof handleRegistrySearch>[0]);
        // Embed
        case 'cgb_embed_build':
          return await handleEmbedBuild(args as Parameters<typeof handleEmbedBuild>[0]);
        case 'cgb_embed_search':
          return await handleEmbedSearch(args as Parameters<typeof handleEmbedSearch>[0]);
        case 'cgb_embed_similar':
          return await handleEmbedSimilar(args as Parameters<typeof handleEmbedSimilar>[0]);
        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(`Tool ${name} failed: ${message}`);
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep running until stdin closes
  process.on('SIGINT', () => process.exit(0));
}
