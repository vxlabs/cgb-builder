# cgb-builder

**Automated polyglot code graph builder for AI-ready context bundles.**

`cgb-builder` scans your codebase, builds a persistent dependency/call/inheritance graph, and generates compact Markdown context bundles (1 000–5 000 tokens) that give AI coding assistants exactly the structural context they need — instead of dumping entire files.

[![npm version](https://img.shields.io/npm/v/cgb-builder.svg)](https://www.npmjs.com/package/cgb-builder)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 20](https://img.shields.io/node/v/cgb-builder)](https://nodejs.org)

---

## Why?

AI coding assistants (Cursor, Claude Code, GitHub Copilot) spend enormous context budgets loading whole files. A large project can burn 50–100 K tokens per session just on file reads, most of which is irrelevant.

`cgb` answers structural questions instantly:

- What does `UserService` import?
- If I change `auth/middleware.ts`, which files break?
- How does `StripeWebhook` transitively depend on `DatabasePool`?
- Generate a compact bundle of everything touching `PaymentService` for my AI agent.

---

## Supported Languages

| Language   | Parser                     |
|------------|----------------------------|
| TypeScript | Tree-sitter (WASM)         |
| JavaScript | Tree-sitter (WASM)         |
| Python     | Tree-sitter (WASM)         |
| C#         | Tree-sitter (WASM)         |
| Java       | Tree-sitter (WASM)         |
| Go         | Tree-sitter (WASM)         |

No native compilation required — runs on any OS.

---

## Installation

### Global CLI

```bash
npm install -g cgb-builder
```

### Project dependency (API usage)

```bash
npm install cgb-builder
```

### npx (no install)

```bash
npx cgb-builder init
```

---

## CLI Quick Start

```bash
# 1. Build the graph for your project
cgb init

# 2. See what a file imports (direct + transitive)
cgb deps src/services/UserService.ts

# 3. Impact analysis — what breaks if this file changes?
cgb impact src/db/connection.ts

# 4. Generate an AI context bundle (~2 000 tokens)
cgb bundle src/api/payments.ts

# 5. Find shortest dependency path between two files
cgb path src/routes/checkout.ts src/db/pool.ts

# 6. Search for any class, function, or file
cgb search "PaymentService"

# 7. Watch for file changes and keep the graph up to date
cgb watch
```

---

## CLI Reference

### `cgb init`

Scan all source files and build the initial graph. Run this once before any other command.

```
cgb init [options]

Options:
  -r, --root <path>   Project root directory (default: cwd)
  -f, --force         Force re-parse all files even if unchanged
      --watch         Keep watching for file changes after initial scan
```

### `cgb deps <target>`

Show what a file depends on (direct and transitive).

```
cgb deps src/services/auth.ts [options]

Options:
  -r, --root <path>   Project root directory
  -d, --depth <n>     Traversal depth for transitive deps (default: 3)
      --json          Output as JSON
```

### `cgb impact <target>`

Show which files would be affected if the given file changes.

```
cgb impact src/db/pool.ts [options]

Options:
  -r, --root <path>   Project root directory
  -d, --depth <n>     Maximum traversal depth (default: 10)
      --json          Output as JSON
```

### `cgb bundle <target>`

Generate an AI-optimised context bundle (Markdown) for a file. Contains: summary, direct deps, reverse deps, class hierarchy, and optionally the full source.

```
cgb bundle src/services/payments.ts [options]

Options:
  -r, --root <path>       Project root directory
  -d, --depth <n>         Dependency traversal depth (default: 2)
      --no-source         Exclude source file from the bundle
  -o, --output <file>     Write bundle to a file
      --json              Output bundle structure as JSON
```

### `cgb search <query>`

Find nodes by name, description, or file path.

```
cgb search "UserService" [options]

Options:
  -r, --root <path>   Project root directory
      --json          Output as JSON
```

### `cgb path <from> <to>`

Find the shortest dependency path between two files.

```
cgb path src/routes/checkout.ts src/db/pool.ts [options]

Options:
  -r, --root <path>   Project root directory
      --json          Output as JSON
```

### `cgb stats`

Show graph statistics: file count, node types, cycles, orphan nodes, and architectural layers.

```
cgb stats [options]

Options:
  -r, --root <path>   Project root directory
      --json          Output as JSON
```

### `cgb watch`

Watch for file changes and keep the graph incrementally updated.

```
cgb watch [options]

Options:
  -r, --root <path>   Project root directory
```

### `cgb mcp`

Start the MCP server so Cursor / Claude Code can call `cgb` tools directly.

```
cgb mcp [options]

Options:
  -r, --root <path>   Default project root
```

---

## MCP Server (Cursor / Claude Code Integration)

`cgb-builder` ships a [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes all graph tools to your AI coding assistant.

### Setup in Cursor

Add to your MCP config (`.cursor/mcp.json` or global `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cgb": {
      "command": "cgb",
      "args": ["mcp"],
      "env": {}
    }
  }
}
```

### Setup in Claude Code (global)

```bash
claude mcp add cgb -- cgb mcp
```

### Available MCP Tools

| Tool         | Description                                                                 |
|--------------|-----------------------------------------------------------------------------|
| `cgb_init`   | Scan a project and build/refresh the code graph                            |
| `cgb_deps`   | Get dependencies of a file (direct + transitive)                           |
| `cgb_impact` | Which files would be affected if a given file changes                      |
| `cgb_search` | Search nodes by name, description, or file path                            |
| `cgb_bundle` | Generate a compact AI context bundle (Markdown, ~1 000–5 000 tokens)       |
| `cgb_stats`  | Graph statistics: counts, cycles, layers                                   |
| `cgb_path`   | Shortest dependency path between two files                                 |

---

## Programmatic API

```typescript
import { GraphDb, GraphEngine, Parser, BundleGenerator } from 'cgb-builder';

const root = '/path/to/your/project';

// 1. Initialise the database
const db = new GraphDb(root);
await db.init();

// 2. Parse all source files
const parser = new Parser(db, root);
await parser.scanAll();

// 3. Query the graph
const engine = new GraphEngine(db);

// Dependencies of a file
const deps = engine.deps('file:/path/to/your/project/src/index.ts', 3);

// Impact analysis
const impact = engine.impact('file:/path/to/your/project/src/db.ts');

// Search
const results = engine.search('UserService');

// Shortest path
const p = engine.path(
  'file:/path/to/your/project/src/routes/api.ts',
  'file:/path/to/your/project/src/db/pool.ts'
);

// 4. Generate an AI context bundle
const bundleGen = new BundleGenerator(db, engine, root);
const bundle = bundleGen.generate('/path/to/your/project/src/payments.ts', {
  depth: 2,
  includeSource: true,
});
const markdown = bundleGen.render(bundle);
console.log(`~${bundle.totalTokenEstimate} tokens`);

db.close();
```

### API Reference

#### `GraphDb`

| Method | Description |
|--------|-------------|
| `new GraphDb(root)` | Create instance; stores graph in `<root>/.cgb/graph.db` |
| `init()` | Initialise (async, must be called before use) |
| `getStats()` | `{ files, nodes, edges }` |
| `getNodeCountByKind()` | Node count broken down by kind |
| `close()` | Release the database |

#### `Parser`

| Method | Description |
|--------|-------------|
| `new Parser(db, root)` | Create instance |
| `scanAll(force?)` | Parse all supported source files; returns `{ parsed, skipped, errors, durationMs }` |

#### `GraphEngine`

| Method | Description |
|--------|-------------|
| `new GraphEngine(db)` | Create instance |
| `deps(nodeId, depth?)` | `DepsResult \| null` |
| `impact(nodeId, depth?)` | `ImpactResult \| null` |
| `search(query)` | `GraphNode[]` |
| `path(fromId, toId)` | `PathResult \| null` |
| `callers(nodeId)` | `CallersResult \| null` |
| `layers()` | Architectural layer summary |
| `detectCycles()` | Circular dependency chains |
| `orphans()` | Nodes with no edges |

#### `BundleGenerator`

| Method | Description |
|--------|-------------|
| `new BundleGenerator(db, engine, root)` | Create instance |
| `generate(filePath, options?)` | `ContextBundle` |
| `render(bundle)` | Render to Markdown string |

#### `Watcher`

```typescript
import { Watcher } from 'cgb-builder';

const watcher = new Watcher(root, parser, {
  onUpdate: ({ parsed, errors, files }) => console.log('Updated:', files),
  onError: (err) => console.error(err),
});

watcher.start();
// ... later ...
await watcher.stop();
```

---

## How It Works

1. **Parse** — Tree-sitter WASM grammars extract imports, exports, classes, functions, and calls from each file.
2. **Store** — Results are persisted in a local SQLite database (`.cgb/graph.db`) via `sql.js`.
3. **Query** — Graph traversal algorithms answer dependency, impact, and path queries in milliseconds.
4. **Bundle** — The bundle generator compiles a compact Markdown document with only the structural context an AI agent needs.

Incremental updates: only re-parses files whose content hash has changed since the last run.

---

## Requirements

- **Node.js** >= 20.0.0
- No native build tools required (all Tree-sitter grammars ship as WASM)

---

## License

MIT — see [LICENSE](./LICENSE)
