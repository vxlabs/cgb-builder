/**
 * Code Graph Builder — MCP Server
 *
 * Exposes cgb capabilities to AI agents (Cursor, Claude Code, etc.)
 * via the Model Context Protocol over stdio transport.
 *
 * Tools exposed:
 *   cgb_init    — scan a project and build / refresh the graph
 *   cgb_deps    — get dependencies of a file
 *   cgb_impact  — impact analysis for a file
 *   cgb_search  — search nodes by name / path
 *   cgb_bundle  — generate AI context bundle (Markdown)
 *   cgb_stats   — get graph statistics
 *   cgb_path    — shortest dependency path between two files
 */

import * as path from 'path';
import * as fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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
        root: {
          type: 'string',
          description: 'Absolute path to the project root directory',
        },
        force: {
          type: 'boolean',
          description: 'Re-parse all files even if unchanged (default: false)',
        },
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
        root: {
          type: 'string',
          description: 'Project root directory (must have been initialized with cgb_init)',
        },
        target: {
          type: 'string',
          description: 'Relative or absolute path to the file',
        },
        depth: {
          type: 'number',
          description: 'How many levels of transitive deps to include (default: 3)',
        },
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
        root: {
          type: 'string',
          description: 'Project root directory',
        },
        target: {
          type: 'string',
          description: 'Relative or absolute path to the file being changed',
        },
        depth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 10)',
        },
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
        root: {
          type: 'string',
          description: 'Project root directory',
        },
        query: {
          type: 'string',
          description: 'Search term (matches node name, description, and file path)',
        },
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
        root: {
          type: 'string',
          description: 'Project root directory',
        },
        target: {
          type: 'string',
          description: 'Relative or absolute path to the file to bundle',
        },
        depth: {
          type: 'number',
          description: 'Dependency traversal depth (default: 2)',
        },
        includeSource: {
          type: 'boolean',
          description: 'Include the full source of the target file in the bundle (default: true)',
        },
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
        root: {
          type: 'string',
          description: 'Project root directory',
        },
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
        root: {
          type: 'string',
          description: 'Project root directory',
        },
        from: {
          type: 'string',
          description: 'Relative or absolute path to the source file',
        },
        to: {
          type: 'string',
          description: 'Relative or absolute path to the target file',
        },
      },
      required: ['root', 'from', 'to'],
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
    // Simplify the result for AI consumption
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

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'cgb', version: '1.0.0' }, { capabilities: { tools: {} } });

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
