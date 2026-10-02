# CGB Roadmap

## Shipped (v1.3.0)

- ✓ **Storage migration** — sql.js → better-sqlite3 (WAL, FTS5, schema v2)
- ✓ **Parser improvements** — TS/JS/TSX extraction rewritten, real exports edges, import resolution
- ✓ **Linker pass** — cross-file call edges for TS/JS, heritage resolution
- ✓ **Ranked search** — exact → prefix → BM25 (FTS5)
- ✓ **Auto-freshness** — read tools re-parse changed files automatically
- ✓ **MCP expansion** — +3 tools (cgb_symbol, cgb_callers, cgb_callees); 30 total
- ✓ **Claude Code integration** — `cgb install --platform claude-code` writes .mcp.json + hooks

## Remaining Language Gaps (from v1.3.0 audit)

- **Ruby:** adapter cannot parse (tree-sitter-ruby.wasm external scanner incompatible)
- **Call edges:** only TS/JS; C# same-class only; instance calls (obj.method()) unresolved
- **Method scoping:** non-TS method scoping incomplete; several heritage/import gaps per language
- **32 language-specific todos:** see [`docs/languages/README.md`](docs/languages/README.md)

## Near-term (v1.4 / next minor)

- **DB migrations** — versioned schema evolution via a `migrations/` module
- **Session hints** — MCP responses include `hints` array suggesting related tools
- **Security keyword scoring** — flag high-risk patterns (SQL injection sinks, `eval`, etc.)
- **`cgb status` command** — quick DB health check (file count, last scan time, stale files)
- **Python call edges** — extend linker to Python (fn calls, method calls)
- **C# call edges** — expand beyond same-class methods

## Medium-term

- **Incremental MCP push** — server notifies clients when the graph changes
- **Blame / git author attribution** — link nodes to their last committer
- **Test coverage overlay** — map coverage reports onto the graph
- **WASM builds** — self-contained binary with bundled SQLite (no node-gyp)
- **Java / Go call edges** — extend linker to more languages

## Long-term

- **Cloud sync** — optional hosted graph for teams
- **Language server integration** — serve go-to-definition / find-references via the graph
- **AI-assisted refactor execution** — auto-apply rename / dead-code removal suggestions
- **Diff-aware CI bot** — GitHub Action that comments impact analysis on pull requests
- **Ruby parsing fix** — unblock tree-sitter-ruby.wasm with web-tree-sitter 0.21+
