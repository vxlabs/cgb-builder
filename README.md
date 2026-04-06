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
- Which functions are dead code? What communities does this codebase form?

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
| Rust       | Tree-sitter (WASM)         |
| Ruby       | Tree-sitter (WASM)         |
| PHP        | Tree-sitter (WASM)         |
| C / C++    | Tree-sitter (WASM)         |
| Kotlin     | Tree-sitter (WASM)         |

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

# 7. Detect git changes with risk scoring
cgb detect-changes

# 8. Build a focused AI code-review context
cgb review-context

# 9. Find all callers of a function
cgb callers src/services/auth.ts::validateToken

# 10. Detect communities / module clusters
cgb communities

# 11. Generate a Markdown wiki from the graph
cgb wiki --out docs/wiki

# 12. Watch for file changes and keep the graph up to date
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

### `cgb callers <nodeId>`

Find all nodes that call a given function or method.

```
cgb callers src/services/auth.ts::validateToken [options]

Options:
  -r, --root <path>   Project root directory
      --json          Output as JSON
```

### `cgb detect-changes`

Detect git changes with risk scoring and blast-radius analysis.

```
cgb detect-changes [options]

Options:
  -r, --root <path>   Project root directory
      --json          Output as JSON
```

### `cgb review-context`

Build a focused code-review context for AI reviewers (changed files, affected files, tests, risk).

```
cgb review-context [options]

Options:
  -r, --root <path>   Project root directory
      --json          Output as JSON
```

### `cgb communities`

Detect communities / module clusters using the Louvain algorithm.

```
cgb communities [options]

Options:
  -r, --root <path>   Project root directory
      --json          Output as JSON
```

### `cgb wiki`

Generate a full Markdown wiki from the code graph, organised by community.

```
cgb wiki [options]

Options:
  -r, --root <path>     Project root directory
  -o, --out <dir>       Output directory for wiki files (default: ./wiki)
```

### `cgb registry`

Manage a global multi-repo registry for cross-project search.

```
cgb registry register <path> <name>   Register a repo
cgb registry unregister <name>         Remove a repo from the registry
cgb registry list                      List all registered repos
cgb registry search <query>            Search across all registered repos
```

### `cgb refactor`

Refactoring utilities.

```
cgb refactor dead-code                        List functions/classes with zero inbound references
cgb refactor suggestions                      Show high-impact structural improvement hints
cgb refactor rename <target> <newName>        Preview the full impact of renaming a symbol
```

### `cgb install`

Auto-configure the MCP server for your AI coding assistant.

```
cgb install cursor        Configure Cursor (.cursor/mcp.json)
cgb install claude        Configure Claude Code
cgb install vscode        Generate VS Code settings
cgb install <config>      Write to a custom config path
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

`cgb-builder` ships a [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes 26 graph tools to your AI coding assistant.

### Quick setup

```bash
# Claude Code
cgb install claude

# Cursor
cgb install cursor
```

Or configure manually:

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

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

**Claude Code** (global):

```bash
claude mcp add cgb -- cgb mcp
```

### Available MCP Tools (26 tools)

| Tool                    | Description                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| `cgb_init`              | Scan a project and build/refresh the code graph                            |
| `cgb_deps`              | Get dependencies of a file (direct + transitive)                           |
| `cgb_impact`            | Which files would be affected if a given file changes                      |
| `cgb_search`            | Search nodes by name, description, or file path                            |
| `cgb_bundle`            | Generate a compact AI context bundle (Markdown, ~1 000–5 000 tokens)       |
| `cgb_stats`             | Graph statistics: counts, cycles, layers                                   |
| `cgb_path`              | Shortest dependency path between two files                                 |
| `cgb_detect_changes`    | Detect git changes with risk scoring and blast-radius analysis             |
| `cgb_review_context`    | Build a focused AI code-review context (changed files, risk, tests)        |
| `cgb_large_functions`   | Find large / complex functions ranked by connectivity                      |
| `cgb_entry_points`      | Discover call-chain entry points in the graph                              |
| `cgb_call_chain`        | Trace a full call chain from any node                                      |
| `cgb_criticality`       | Score every node by criticality (fan-in, fan-out, centrality)              |
| `cgb_communities`       | Detect communities / module clusters using Louvain algorithm               |
| `cgb_architecture`      | Generate a high-level architecture overview of the project                 |
| `cgb_dead_code`         | Detect unreachable / dead code (zero inbound references)                   |
| `cgb_rename_preview`    | Preview the full impact of renaming a symbol before applying               |
| `cgb_apply_refactor`    | Apply a stored rename preview to disk                                      |
| `cgb_refactor_suggest`  | Suggest structural refactoring opportunities                               |
| `cgb_wiki_generate`     | Generate a complete Markdown wiki from graph communities                   |
| `cgb_wiki_section`      | Generate a wiki section for a single community                             |
| `cgb_registry_register` | Register a repo in the global multi-repo registry                         |
| `cgb_registry_list`     | List all registered repos                                                  |
| `cgb_registry_search`   | Search across all registered project graphs                                |
| `cgb_embed_build`       | Compute and store BM25/vector embeddings for all nodes                     |
| `cgb_embed_search`      | Hybrid search (BM25 + vector + LIKE → Reciprocal Rank Fusion)              |

### Built-in MCP Prompts

The server also exposes a prompt library (`ListPrompts` / `GetPrompt`) with predefined AI reviewer and architecture prompts.

---

## VS Code Extension

A VS Code extension is included under `vscode-extension/`. It exposes the same cgb capabilities directly inside the editor — no CLI required.

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
| `getNodesByLanguage(lang)` | All nodes for a given language |
| `getNodesByCommunity(id)` | Nodes belonging to a community cluster |
| `getCriticalNodes(limit?)` | Nodes ranked by criticality score |
| `getDeadCode()` | Nodes with zero inbound references |
| `getEntryPoints()` | Call-chain entry points |
| `getCallChain(nodeId)` | Full call chain from a node |
| `getShortestPath(from, to)` | Shortest dependency path |
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

1. **Parse** — Tree-sitter WASM grammars extract imports, exports, classes, functions, and calls from each file across 12 languages.
2. **Store** — Results are persisted in a local SQLite database (`.cgb/graph.db`) via `sql.js`, including criticality scores, community IDs, and optional embeddings.
3. **Query** — Graph traversal algorithms answer dependency, impact, path, and call-chain queries in milliseconds.
4. **Bundle** — The bundle generator compiles a compact Markdown document with only the structural context an AI agent needs.
5. **Communities** — Louvain clustering groups files into architectural modules automatically.
6. **Embeddings** — BM25 tokens and vector embeddings enable hybrid semantic search via Reciprocal Rank Fusion.
7. **Git integration** — Risk scoring and blast-radius analysis are layered on top of `git diff` output.

Incremental updates: only re-parses files whose content hash has changed since the last run.

---

## Requirements

- **Node.js** >= 20.0.0
- No native build tools required (all Tree-sitter grammars ship as WASM)

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a full version history.

---

## License

MIT — see [LICENSE](./LICENSE)
