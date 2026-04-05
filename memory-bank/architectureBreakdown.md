# Architecture Breakdown

## Project Identity

- **Name:** `code-graph-builder` (`cgb` CLI)
- **Language:** TypeScript, compiled to CommonJS (`dist/`)
- **Runtime:** Node.js ≥ 20
- **Entry points:** `dist/cli/index.js` (CLI), `dist/index.js` (library API)

## Source Tree

```
src/
├── types.ts                         # All domain types (GraphNode, GraphEdge, FileRecord, etc.)
├── index.ts                         # Public library API re-exports
│
├── graph/
│   ├── db.ts                        # SQLite persistence via sql.js (WASM, no native)
│   ├── engine.ts                    # Graph traversal: deps, callers, impact, path, cycles
│   └── __tests__/
│       ├── db.test.ts               # Unit tests for GraphDb (19 tests)
│       └── engine.test.ts           # Unit tests for GraphEngine (20 tests)
│
├── parser/
│   ├── adapter.ts                   # LanguageAdapter interface
│   ├── tree-sitter-engine.ts        # web-tree-sitter WASM orchestrator + lang cache
│   ├── index.ts                     # Parser: file discovery (glob), hash-based incremental
│   ├── utils.ts                     # makeNodeId, makeEdgeId, hashContent, detectLanguage
│   └── adapters/
│       ├── typescript.ts            # TS/JS: imports, classes, interfaces, functions
│       ├── csharp.ts                # C#: using, namespace, class/record, interface, method
│       ├── python.ts                # Python: import, class, function
│       ├── go.ts                    # Go: import, type (struct/interface), function/method
│       └── java.ts                  # Java: import, class/enum, interface, method
│
├── bundle/
│   └── generator.ts                 # AI context bundle generator (Markdown output)
│
├── mcp/
│   └── server.ts                    # MCP server (stdio transport) — 7 tools for AI agents
│
├── watcher/
│   └── index.ts                     # chokidar file watcher → incremental re-parse
│
└── cli/
    └── index.ts                     # commander.js CLI: init, deps, callers, impact, bundle, stats, watch, mcp
```

## Architecture Layers

```
┌─────────────────────────────────────────────────────┐
│  CLI (commander.js)         src/cli/index.ts         │
│  MCP Server                 src/mcp/server.ts        │
│  Library API                src/index.ts             │
├─────────────────────────────────────────────────────┤
│  BundleGenerator            src/bundle/generator.ts  │
│  GraphEngine                src/graph/engine.ts      │
│  Watcher                    src/watcher/index.ts     │
├─────────────────────────────────────────────────────┤
│  Parser (orchestrator)      src/parser/index.ts      │
│  TreeSitterEngine           src/parser/tree-sitter-engine.ts │
│  Language Adapters          src/parser/adapters/     │
├─────────────────────────────────────────────────────┤
│  GraphDb (sql.js SQLite)    src/graph/db.ts          │
│  Domain Types               src/types.ts             │
└─────────────────────────────────────────────────────┘
```

## Key Data Flow

1. **Init/Scan:** `CLI → Parser.scanAll() → glob finds source files → TreeSitterEngine parses each file → LanguageAdapter extracts nodes/edges → GraphDb.upsertNode/upsertEdge`
2. **Watch:** `Watcher (chokidar) detects change → Parser.parseFile(changed) → GraphDb update`
3. **Query:** `CLI → GraphEngine.deps(nodeId) → GraphDb SQL queries → returns GraphNode[]`
4. **Bundle:** `CLI → BundleGenerator.generate(filePath) → GraphEngine queries → Markdown rendered`

## SQLite Schema

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  filePath TEXT NOT NULL,
  description TEXT,
  isExternal INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  meta TEXT DEFAULT '{}',
  updatedAt INTEGER NOT NULL
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  fromId TEXT NOT NULL,
  toId TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE files (
  filePath TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  mtime REAL NOT NULL,
  nodeCount INTEGER DEFAULT 0,
  edgeCount INTEGER DEFAULT 0,
  parsedAt INTEGER NOT NULL
);
```

Database is persisted to `.cgb/graph.db` in the project root.

## Graph Database (`.cgb/` directory)

```
.cgb/
└── graph.db    ← binary SQLite file, auto-created by `cgb init`
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `cgb init [--root <path>] [--force] [--watch]` | Scan all files and build the graph |
| `cgb deps <target>` | Show direct + transitive dependencies |
| `cgb callers <nodeId>` | Find all callers of a function/method |
| `cgb impact <target>` | Show what files are affected if target changes |
| `cgb search <query>` | Search nodes by name/description/path |
| `cgb path <from> <to>` | Shortest dependency path between two files |
| `cgb bundle <target>` | Generate AI context bundle Markdown |
| `cgb stats` | Show graph statistics and layer overview |
| `cgb watch` | Keep graph live with file watching |
