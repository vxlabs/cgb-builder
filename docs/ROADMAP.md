# CGB Roadmap

## Near-term (next minor)

- **DB migrations** — versioned schema evolution via a `migrations/` module
- **Session hints** — MCP responses include `hints` array suggesting related tools
- **Security keyword scoring** — flag high-risk patterns (SQL injection sinks, `eval`, etc.)
- **`cgb status` command** — quick DB health check (file count, last scan time, stale files)

## Medium-term

- **Incremental MCP push** — server notifies clients when the graph changes
- **Blame / git author attribution** — link nodes to their last committer
- **Test coverage overlay** — map coverage reports onto the graph
- **WASM builds** — self-contained binary with bundled SQLite (no node-gyp)

## Long-term

- **Cloud sync** — optional hosted graph for teams
- **Language server integration** — serve go-to-definition / find-references via the graph
- **AI-assisted refactor execution** — auto-apply rename / dead-code removal suggestions
- **Diff-aware CI bot** — GitHub Action that comments impact analysis on pull requests
