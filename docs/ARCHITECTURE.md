# CGB Architecture

## High-Level Module Map

```
src/
├── cli/          CLI entry point (Commander.js)
├── parser/       Language parsers → GraphDb writes
├── graph/
│   ├── db.ts     SQLite CRUD + FTS5 search
│   └── engine.ts Graph traversal (deps, impact, path, cycles…)
├── bundle/       AI context bundle generator
├── flows/        Entry-point detection + criticality scoring
├── communities/  Louvain-style community detection
├── refactor/     Dead code, rename preview, suggestions
├── wiki/         Markdown doc generator
├── registry/     Multi-repo global registry
├── embed/        TF-IDF cosine-similarity search
├── mcp/          MCP server (30 tools + 5 prompt templates)
├── viz/          D3 HTML graph renderer + HTTP serve
├── install/      Platform installer (Cursor, Claude, VS Code)
└── eval/         Benchmark harness (5 benchmark types)

vscode-extension/
└── src/extension.ts  VS Code WebView + D3 panel + DB reader
```

## Data Flow

```
Source files
    │  parser/index.ts  (TreeSitter / heuristic per language)
    ▼
GraphDb  (.cgb/graph.db)
    │  graph/engine.ts  (traversal algorithms)
    ▼
Results  ────► CLI output
         ├──► MCP tool responses (JSON)
         ├──► D3 HTML visualization
         ├──► Markdown wiki pages
         └──► AI context bundles
```

## Key Design Decisions

### better-sqlite3 + WAL mode

All graph data lives in one `.cgb/graph.db` file inside the project root (native SQLite, no sql.js).
WAL (write-ahead logging) enables concurrent reads while writes are in flight.
No FK cascades, fixing stale edges during incremental updates.
This makes the tool zero-infra — no daemon, no port, git-ignorable.

### Schema v2 (FTS5 + metadata)

The database stores line ranges, function signatures, docstrings, `exported` flag, and modifiers
for all languages. FTS5 index on name + description + path enables ranked full-text search.

### Incremental re-scan

`parser` tracks a content hash per file. On `cgb init` only changed files
are re-parsed, keeping re-scans fast even for large repos.

### Linker pass

After parsing, a cross-file linker resolves imports, re-exports, and scoped packages,
then walks call chains to produce real call edges for TS/JS.
This replaces regex-based heuristics and fixes false negatives in call graphs.

### Ranked search

Search ranks exact name, then prefix, then BM25 (FTS5).
When embeddings exist (`cgb_embed_build`), hybrid search fuses lexical and vector ranks via RRF.

### Auto-freshness

Read tools (`cgb_symbol`, `cgb_search`, etc.) automatically re-parse changed files before answering.
This keeps the graph in sync with edits without explicit `cgb update` calls (disable with `CGB_NO_AUTOREFRESH`).

### MCP-first API surface

Every analysis capability is exposed as an MCP tool so AI agents can
call them without any shell access. The CLI is a thin wrapper around the
same services.

### No runtime daemon

`cgb mcp` runs the MCP server on demand (stdio transport by default).
Cursor / Claude Code spawn it automatically when the workspace opens.
