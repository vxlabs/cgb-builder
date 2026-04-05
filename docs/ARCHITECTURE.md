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
├── mcp/          MCP server (30+ tools + 5 prompt templates)
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

### Single-file SQLite database

All graph data lives in one `.cgb/graph.db` file inside the project root.
This makes the tool zero-infra — no daemon, no port, git-ignorable.

### Incremental re-scan

`parser` tracks a content hash per file. On `cgb init` only changed files
are re-parsed, keeping re-scans fast even for large repos.

### FTS5 for search

Node names and file paths are mirrored into an FTS5 virtual table.
This gives sub-millisecond full-text search without an external index.

### TF-IDF embeddings

`embed/` computes TF-IDF vectors over node name tokens and ranks by cosine
similarity. This provides semantic "similar code" search without an LLM call.

### MCP-first API surface

Every analysis capability is exposed as an MCP tool so AI agents can
call them without any shell access. The CLI is a thin wrapper around the
same services.

### No runtime daemon

`cgb mcp` runs the MCP server on demand (stdio transport by default).
Cursor / Claude Code spawn it automatically when the workspace opens.
