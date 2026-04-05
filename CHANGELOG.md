# Changelog

All notable changes to `cgb-builder` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
