# CGB Feature Catalogue

## Core Graph

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Build/refresh graph | `cgb init` | `cgb_init` |
| File dependencies | `cgb deps` | `cgb_deps` |
| Reverse dependencies | — | `cgb_callers` |
| Impact analysis | `cgb impact` | `cgb_impact` |
| Shortest path | `cgb path` | `cgb_path` |
| Full-text search | `cgb search` | `cgb_search` |
| Semantic similarity | — | `cgb_embed_search` |
| Similar files | — | `cgb_embed_similar` |
| Graph statistics | `cgb stats` | `cgb_stats` |
| Cycle detection | — | `cgb_stats` |
| Orphan detection | — | `cgb_stats` |

## AI Context

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Context bundle | `cgb bundle` | `cgb_bundle` |
| Review context | — | `cgb_review_context` |
| Change detection | — | `cgb_detect_changes` |

**Symbol-scoped bundles.** Passing a function, method, class or interface node id to `cgb bundle` / `cgb_bundle` returns just that symbol: its own lines (`startLine..endLine`, capped at `maxTargetLines`, default 200, with a `… (N more lines)` marker), then one-hop callers and callees as signature + `path:start-end` + doc (no bodies), then the file's imports. A file target returns an outline (signature, range and doc per symbol, nested by range) and the source: whole when it fits in `maxTargetLines`, otherwise only the first `maxTargetLines` lines. Dependencies show signature and range only; set `includeDependencySource` to add snippets capped by `maxDependencyLines` (default 30). Every bundle ends with a `≈ N lines, M chars` size line and uses project-relative paths. Nodes without line ranges fall back to the whole-file bundle.

## Architecture Analysis

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Entry points | `cgb flows` | `cgb_entry_points` |
| Critical nodes | `cgb flows --top N` | `cgb_critical_nodes` |
| Call chain trace | `cgb flows --chain X` | `cgb_trace_flow` |
| Community detection | `cgb communities` | `cgb_communities` |
| Architecture overview | `cgb communities --overview` | `cgb_architecture_overview` |
| Large functions | — | `cgb_large_functions` |

**Large functions and entry points.** Large functions are ranked by real lines of code (`endLine - startLine + 1`); each item carries `loc`, `signature`, `startLine` and `endLine`. Functions without ranges rank after ranged ones by connectivity (fan-in + 2 x fan-out). Entry points are exported functions/methods with no incoming `calls` edges, listed first; other no-caller nodes (including files) follow, each group by fan-out. Entry points, call-chain steps and large functions include `signature` and `startLine` when known.

**Community detection.** Communities are found with weighted Louvain (graphology, resolution 1, deterministic seeded RNG) over an undirected graph of non-external nodes. Parallel edges are merged by summing weights. Edge weights: `calls` 1.0, `inherits` 0.8, `implements` 0.7, `depends_on` 0.6, `imports` 0.5, `tested_by` 0.4, `contains` 0.3 (others 0.3). Communities over 50 nodes are split with a second Louvain pass. If graphology cannot be loaded or Louvain fails, detection falls back to connected components over file imports and logs a one-time warning to stderr. Every community, and the architecture overview, carries an `algorithm` field (`louvain` or `connected-components`) showing which ran.

## Refactoring

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Dead code detection | `cgb refactor dead-code` | `cgb_dead_code` |
| Refactoring suggestions | `cgb refactor suggestions` | `cgb_refactor_suggestions` |
| Rename preview | `cgb refactor rename` | — |

**Dead code** lists unexported functions, methods and classes with no incoming `calls`, `inherits` or `implements` edges (skipping `main`, constructors, test files, and languages with no call edges). Exported symbols nobody calls, whose file nobody imports, are reported separately as unused exports.

**Rename** is range-scoped. The preview lists one item per occurrence (`file`, `line`, `column`, `before`, `after`, `confidence`) in the declaration, in the ranges of symbols that call, extend or implement the target, and in import specifier lines of importing files. Occurrences inside strings and comments are skipped. Without a line range, or outside TypeScript/JavaScript, items are low confidence and never fall back to whole-file replacement. Apply checks every line still equals `before`; if any drifted, nothing is written. Paths are checked against the project root (including symlinks), and touched files are re-parsed afterwards. Previews expire after 10 minutes.

## Documentation

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Wiki generation | `cgb wiki` | `cgb_generate_wiki` |
| Page for file | — | `cgb_wiki_page` |

## Multi-repo

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Register repo | `cgb registry register` | — |
| Unregister repo | `cgb registry unregister` | — |
| List repos | `cgb registry list` | — |
| Cross-repo search | `cgb registry search` | `cgb_registry_search` |
| Registry info | — | `cgb_registry_list` |

## Languages Supported

TypeScript · JavaScript · Python · Rust · Go · Ruby · PHP · C · C++ · Kotlin · Jupyter Notebooks

## MCP Prompt Templates

| Prompt | Description |
|--------|-------------|
| `review_changes` | Review staged changes with impact context |
| `architecture_map` | Summarise project architecture |
| `debug_issue` | Debug an issue with graph context |
| `onboard_developer` | Onboard a new developer to the codebase |
| `pre_merge_check` | Pre-merge safety checklist |
