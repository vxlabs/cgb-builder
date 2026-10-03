# Changelog

All notable changes to `cgb-builder` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.2] - 2026-10-03

### Fixed
- File-node `imports` / `reexports` meta is stored root-relative, so `graph.db` no longer leaks the project root
- `review-context` changed files were left absolute when the root's spelling differed from git's canonical path (Windows 8.3 short names such as `RUNNER~1`, symlinked directories); the repo root now keeps the caller's spelling

## [1.3.1] - 2026-10-03

Headless-use release (library, JSON CLIs, read-only MCP). Supersedes 1.3.0, whose tagged
commit does not compile (stray merge-conflict markers in `src/cli/index.ts`,
`src/mcp/server.ts` and `src/parser/index.ts`).

### Added
- `--db-dir <path>` on every graph command, `GraphDb` option `dbDir` and env `CGB_DB_DIR` (precedence: option > env > `<root>/.cgb`); `GraphDb` option `readOnly`
- Library exports: `openGraph`, `initGraph`, `CommunityDetector`, `FlowsAnalyzer`, `findLargeFunctions`, `WikiGenerator`, `buildReviewContext`, `formatReviewContext`, `relativizePaths` and their result types
- CLI: `cgb communities [--top N] [--overview] [--json]`, `cgb flows [--top N] [--chain <entry>] [--depth N] [--json]`, `cgb wiki --json`, `cgb init [path]`
- `cgb mcp --read-only [--db-dir] [--root]`: serves only non-mutating tools, skips auto-refresh, never writes, local embeddings only; `callTool` / `listTools` / `READ_ONLY_TOOLS` exported for embedding
- `hybridSearch` option `localOnly`
- `prepare` script so git-tag installs compile `dist`

### Changed
- Graph DB stores paths and node ids **root-relative with POSIX separators** (schema v3), so one cached DB serves every worktree (and OS) of a repository; the in-memory API still exposes absolute paths. Older DBs are rebuilt automatically; a read-only open of an older DB fails with a hint to run `cgb init`
- `review-context --format json` is deterministic: sorted arrays, no timestamps, root-relative `/` paths
- `ChangeAnalysis.changes` ties on risk score are ordered by path

### Fixed
- Build failure in 1.3.0 (merge-conflict markers)
- `cgb --version` reports the package version (was hard-coded `1.2.0`)

---

## [1.3.0] - 2026-10-02

### Added

#### Storage & Database
- **better-sqlite3** replaces sql.js for native performance (WAL mode, no FK cascades fixing stale edges)
- **Schema v2** — stores line ranges, signatures, docs, exported flag, and modifiers for all languages
- **FTS5 index** for full-text search with BM25 ranking
- Automatic database rebuild on upgrade (existing `graph.db` files rebuilt on first run)

#### Parser Improvements
- **TS/JS/TSX extraction rewritten** — functions, methods, types, enums, namespaces extracted consistently
- **Real exports edges** — re-exports now tracked across files
- **Import resolution** — tsconfig `paths`, re-exports, scoped packages, dynamic imports
- **Linker pass** adds TS/JS call edges and cross-file heritage resolution
- **Python relative imports** fixed
- **Metadata for all adapters** — line ranges, signatures, docs, exports now available for all languages

#### Analysis
- **Ranked search** — exact → prefix → BM25 (configurable via `cgb_search`)
- **Louvain actually runs** for real community detection
- **Bundles are symbol-scoped** and LOC-based for large functions
- **Safe rename apply** with drift detection
- **Real dead-code detection** (not heuristic-based)

#### MCP (30 tools, up from 27)
- **New:** `cgb_symbol` (lookup by name/id with callers/callees), `cgb_callers` (BFS), `cgb_callees` (BFS)
- **Unified search:** `cgb_search` with optional hybrid (lexical + vector); `cgb_embed_search` deprecated alias
- **Optional arguments:** `root`, `limit`, `offset` for pagination; `compact` output mode
- **Auto-freshness** — read tools re-parse changed files (disable with `CGB_NO_AUTOREFRESH`)

#### Claude Code Integration
- **`cgb install --platform claude-code`** writes `.mcp.json`, optional PostToolUse hook, CLAUDE.md block
- **`cgb update`** command for incremental re-indexing

#### Hardening
- **Stderr logging** (`CGB_DEBUG=1`)
- **Safe git exec** — working-tree diffs without shell injection
- **Viz on localhost** — binds 127.0.0.1 (configurable via `CGB_VIZ_HOST`)
- **Batched traversals** for performance
- **Lint/format enforced in CI**

### Changed
- `install --platform claude` now targets Claude Code (use `claude-desktop` for old behavior)
- MCP output is compact JSON with repo-relative paths (node IDs stay absolute)
- `cgb_detect_changes` with no base diffs working tree vs HEAD (previously HEAD~1..HEAD)

### Breaking
- Existing `.cgb/graph.db` files are automatically rebuilt on first run
- sql.js removed (was optional before)

### Fixed
- TS/JS/TSX extraction stability and signature accuracy
- Import cycle false positives in cross-file analysis
- Method scoping in TS call graphs

### Known Limitations
- **Ruby:** adapter cannot parse (tree-sitter-ruby.wasm external scanner incompatible with web-tree-sitter 0.20.8)
- **Call edges:** only TS/JS (C# same-class methods); instance calls like `obj.method()` unresolved (heuristic D7) causing dead-code false positives
- **Scoping:** non-TS method scoping, several heritage/import gaps — see [`docs/languages/README.md`](docs/languages/README.md)

---

## [1.2.0] - 2026-10-02

### Added

#### Visualization (`src/viz/index.ts`)
- **Three-tab UI** — Graph, Stats, and Tree views selectable from the header tab bar
- **File Explorer** — collapsible left sidebar showing the project file tree; click a file to highlight its nodes on the graph
- **Detail Panel** — right sidebar opens on node click, showing kind badge, file path, description, fan-in/fan-out metrics, community membership, and grouped in/out edge lists with clickable links
- **Stats view** — summary cards (nodes, edges, files), bar charts for nodes-by-kind and edges-by-kind, language breakdown, top-10 most-connected nodes table, and health badges (cycle count, orphan count)
- **Tree view** — D3 collapsible tree layout rendering the file hierarchy; searchable with a filter input
- **Edge-kind filter checkboxes** — toggle individual edge kinds (imports, calls, contains, etc.) in the Graph toolbar
- **Extended `VizNode`** — now carries `description`, `language`, `isExternal`, `fanIn`, `fanOut`, `communityId`, and `meta`
- **Extended `VizEdge`** — now carries `reason`
- **New types** — `FileTreeNode`, `VizStats`, `VizCommunity`, `VizData`; `VizGraph` kept as a deprecated alias for `VizData`
- `buildVizGraph` accepts an optional `GraphEngine` to populate `cycleCount` and `orphanCount` in stats

#### C# Adapter
- Methods and constructors are now extracted per class (qualified as `Class.Method`) with `contains` edges from their class
- Method invocations inside method bodies produce `calls` edges
- File-scoped namespace declarations (`namespace Foo;`) are now recognised

#### Graph & Database
- `getEdgeCountByKind()` helper in `src/graph/db.ts`

### Changed
- C# file → class edges now use kind `contains` instead of `exports`
- `cgb viz` now passes `GraphEngine` to `generateVisualization` / `serveVisualization` for richer stats
- `cgb --version` now reports the correct package version

---

## [1.1.0] - 2026-04-05

### Added

#### Language Support
- **Rust** adapter — extracts functions, structs, impl blocks, traits, modules, `use` declarations
- **Ruby** adapter — extracts classes, modules, methods, `require`/`require_relative` calls
- **PHP** adapter — extracts classes, interfaces, functions, `use`/`require`/`include` statements
- **C** adapter — extracts functions, struct/union/enum declarations, `#include` directives
- **Kotlin** adapter — extracts classes, objects, functions, `import` declarations
- Full language coverage now: TypeScript, JavaScript, C#, Python, Go, Java, Rust, Ruby, PHP, C, C++, Kotlin (12 languages)

#### MCP Tools (26 tools total)
New tools added to the MCP server:
- `cgb_detect_changes` — detect git changes with risk scoring and blast-radius analysis
- `cgb_review_context` — build a focused AI code-review context (changed files, affected files, tests, risk)
- `cgb_large_functions` — find large / complex functions ranked by connectivity
- `cgb_entry_points` — discover call-chain entry points in the graph
- `cgb_call_chain` — trace a full call chain from any node
- `cgb_criticality` — score every node by criticality (fan-in, fan-out, centrality)
- `cgb_communities` — detect communities / module clusters using Louvain algorithm
- `cgb_architecture` — generate a high-level architecture overview of the project
- `cgb_dead_code` — detect unreachable / dead code (zero inbound references)
- `cgb_rename_preview` — preview the full impact of renaming a symbol before applying
- `cgb_apply_refactor` — apply a stored rename preview to disk
- `cgb_refactor_suggest` — suggest structural refactoring opportunities
- `cgb_wiki_generate` — generate a complete Markdown wiki from graph communities
- `cgb_wiki_section` — generate a wiki section for a single community
- `cgb_registry_register` — register a repo in the global multi-repo registry
- `cgb_registry_list` — list all registered repos
- `cgb_registry_search` — search across all registered project graphs
- `cgb_embed_build` — compute and store BM25/vector embeddings for all nodes
- `cgb_embed_search` — hybrid search (BM25 + vector + LIKE → Reciprocal Rank Fusion)

#### MCP Prompts
- Built-in prompt library with predefined AI reviewer and architecture prompts accessible via `ListPrompts` / `GetPrompt`

#### CLI Commands
- `cgb callers <nodeId>` — find all nodes that call a given function or method
- `cgb detect-changes` — detect git changes with risk scoring from the CLI
- `cgb review-context` — build a focused code-review context from the CLI
- `cgb watch` — watch for file changes and keep the graph up to date incrementally
- `cgb install` — auto-configure MCP for Cursor, Claude Code, or a custom config path
- `cgb wiki` — generate a full Markdown wiki from the code graph
- `cgb registry register|unregister|list|search` — manage the global multi-repo registry
- `cgb refactor dead-code` — list functions/classes with zero inbound references

#### Modules
- **`src/communities/`** — Louvain community detection on the dependency graph
- **`src/embed/`** — BM25 + vector embedding engine with hybrid RRF search and multiple embedding providers
- **`src/flows/`** — flow analysis utilities
- **`src/git/`** — git diff integration with risk scoring (`changes.ts`, `diff.ts`, `review-context.ts`, `risk.ts`)
- **`src/wiki/`** — Markdown wiki generation from graph communities
- **`src/viz/`** — graph visualisation utilities
- **`src/refactor/`** — rename preview, apply-refactor, dead-code detection, and refactor suggestions
- **`src/registry/`** — global multi-repo registry with cross-project search

#### Graph & Database
- Incremental graph updates — only re-parses changed files (content-hashed)
- Criticality scoring stored per node (fan-in, fan-out, betweenness)
- Community ID stored per node after Louvain clustering
- BM25 tokens and vector embedding columns in SQLite schema
- New query helpers: `getNodesByLanguage`, `getNodesByCommunity`, `getCriticalNodes`, `getDeadCode`, `getEntryPoints`, `getCallChain`, `getShortestPath`

#### Types
- Extended `GraphNode` with `criticality`, `communityId`, `embedding`, `bm25Tokens`
- New `GitChange`, `RiskScore`, `ReviewContext`, `RefactorPreview`, `RegistryEntry` types
- New `EmbedProvider`, `SearchResult`, `WikiSection` types

### Changed
- MCP server rebuilt with full tool suite (26 tools) and prompt support
- CLI rebuilt with `commander` sub-command groups (`registry`, `refactor`)
- `src/parser/index.ts` — incremental parse dispatch with content-hash caching
- `src/parser/tree-sitter-engine.ts` — lazy WASM loading improvements
- `src/parser/utils.ts` — extended language detection for all 12 supported languages
- `src/graph/db.ts` — schema migrations, new indices, extended query API

---

## [1.0.0] - 2026-03-01

### Added
- Initial release of `cgb-builder`
- Core dependency graph builder using Tree-sitter WASM parsers
- Language adapters for TypeScript, JavaScript, C#, Python, Go, Java
- SQLite-backed graph storage via `sql.js`
- Basic MCP server with `cgb_init`, `cgb_deps`, `cgb_impact`, `cgb_search`, `cgb_bundle`, `cgb_stats`, `cgb_path`
- CLI with `init`, `deps`, `impact`, `search`, `path`, `bundle`, `stats` commands
- Graphology integration for in-memory graph operations
