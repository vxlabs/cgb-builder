# Technical Context

## Tech Stack

### Runtime & Language
- **Node.js** ≥ 20 (required for native fetch, modern ESM support)
- **TypeScript** 5.4 — strict mode, compiled to CommonJS (`module: "CommonJS"`)
- **tsconfig** — `target: ES2022`, `esModuleInterop: true`, `noUnusedLocals: true`

### Core Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `web-tree-sitter` | **0.20.8** | WASM-based Tree-sitter parser runtime |
| `tree-sitter-wasms` | 0.1.13 | Pre-compiled WASM grammar files for all supported languages |
| `sql.js` | 1.12.0 | Pure WASM SQLite — no native compilation needed |
| `chokidar` | 3.6.0 | Cross-platform file system watcher |
| `commander` | 12.0.0 | CLI argument parsing |
| `glob` | 10.3.12 | File discovery with ignore patterns |
| `chalk` | 5.3.0 | Terminal colour output |
| `@modelcontextprotocol/sdk` | latest | MCP stdio server (AI agent integration) |

### Dev Dependencies
- `jest` + `ts-jest` — test framework
- `eslint` + `@typescript-eslint/*` — linting with Prettier integration
- `prettier` — code formatting
- `ts-node` — for `npm run dev` (direct source execution)

## Critical Version Constraints

### web-tree-sitter must be exactly 0.20.8
`web-tree-sitter` v0.26.x uses a **newer WASM ABI** that is incompatible with `tree-sitter-wasms` pre-compiled grammars. v0.20.8 is the last version with compatible ABI.

**Symptom if wrong version:** `Error at failIf (getDylinkMetadata)` when calling `Parser.Language.load()`.

**API differences by version:**
```
v0.20.8 (in use):
  import Parser from 'web-tree-sitter'   // default export
  await Parser.init()                     // no args needed; auto-locates tree-sitter.wasm
  const lang = await Parser.Language.load(wasmPath)
  const q = lang.query('...')             // query() is on Language
  q.captures(node)                        // returns QueryCapture[]

v0.26.x (DO NOT USE — ABI mismatch):
  import { Parser, Language, Query } from 'web-tree-sitter'
  const q = new Query(lang, '...')        // separate Query class
```

### sql.js (not better-sqlite3)
`better-sqlite3` requires native compilation via `node-gyp` and Visual Studio on Windows. `sql.js` is pure WASM — works everywhere. The GraphDb handles in-memory Database object and persists the binary to disk on every write.

## Tree-sitter WASM Grammar Paths

Grammar files are at:
```
node_modules/tree-sitter-wasms/out/
  tree-sitter-typescript.wasm
  tree-sitter-javascript.wasm
  tree-sitter-c_sharp.wasm
  tree-sitter-python.wasm
  tree-sitter-go.wasm
  tree-sitter-java.wasm
  ... (many more)
```

`TreeSitterEngine` lazily loads and caches each grammar — it is a singleton (`treeSitterEngine`) shared across all adapters.

## Build & Dev Commands

```bash
npm run build        # tsc → dist/
npm run dev          # ts-node src/cli/index.ts (source, no build)
npm run lint         # eslint src/
npm run lint:fix     # eslint --fix
npm run format       # prettier --write
npm test             # jest (39 tests)
cgb mcp              # start MCP server on stdio (after npm run build)
```

## MCP Server Integration

Start MCP server for Cursor / Claude Code:

```json
{
  "mcpServers": {
    "cgb": {
      "command": "node",
      "args": ["<projectRoot>/dist/cli/index.js", "mcp"]
    }
  }
}
```

Tools exposed: `cgb_init`, `cgb_deps`, `cgb_impact`, `cgb_search`, `cgb_bundle`, `cgb_stats`, `cgb_path`.

## Environment Constraints

- **Windows / PowerShell** — the project was developed on Windows. No Unix-specific tooling required.
- **No native compilation** — both sql.js and web-tree-sitter are WASM; `npm install` works without build tools.
- **Node ≥ 20** required (for stable WASM performance and modern API usage).

## Graph Database Location

`cgb` stores the graph at `<projectRoot>/.cgb/graph.db`. This is auto-created on first `cgb init`.
Add `.cgb/` to `.gitignore` (already included in the project's own `.gitignore`).

## Import Conventions (source files)

All source imports use **`.js` extensions** (e.g. `import { GraphDb } from '../graph/db.js'`). This is correct for TypeScript CommonJS projects — TypeScript resolves `.js` → `.ts` during compilation. Do **not** change to `.ts` extensions.
