# MCP tools

`cgb mcp` serves these tools over stdio. This page covers conventions first, then every tool, then a "which tool when" guide.

## Conventions

**Root resolution.** `root` is optional on every project tool. It resolves as `args.root`, then the `CGB_ROOT` environment variable (set by `cgb mcp --root X`), then the server's working directory. `cgb_registry_list` and `cgb_registry_search` are global and take no root.

**Auto-refresh.** Read tools re-parse edited files first (see Freshness below); results may carry `stale: true`.

**Graph must exist.** Tools other than `cgb_init` and the registry tools return `Graph not built for <root>` with the hint `Call cgb_init first` when the graph is empty.

**Output.** Compact JSON (no indentation). File paths are repo-relative with forward slashes. Paths outside the root, and external package names, are left as is.

**Node IDs.** IDs have the form `<kind>:<path>#<symbol>` (for example `function:/abs/src/a.ts#foo`) and stay absolute in output because they are lookup keys. Anywhere a tool takes a node ID you may pass a repo-relative one such as `function:src/a.ts#foo`; it is expanded against the root.

**Pagination.** List tools accept `limit` (default 50, max 500) and `offset` (default 0) and return:

```json
{ "total": 120, "returned": 50, "offset": 0, "truncated": true, "items": [ ... ] }
```

Request the next page with `offset = offset + returned` while `truncated` is true.

**Compact node.** Wherever a node appears: `{ id, kind, name, file, lines?, sig?, doc?, exported? }`. Empty fields are omitted. `lines` is `"12-40"`.

## Tools

| Tool | Purpose | Key inputs | Output |
|---|---|---|---|
| `cgb_init` | Build or refresh the graph | `force` | `{ success, durationMs, parsed, skipped, errors, graph, layers }` |
| `cgb_stats` | Cheap graph summary | none | `{ files, nodes, edges, byKind, layers, cycleCount, cycles, orphanCount }` |
| `cgb_symbol` | **First tool when you know a name.** Lookup by name or id with callers, callees and a read hint | `name` or `id`, `kind`, `file`, `limit` (default 5) | `{ query, total, returned, truncated, items }`; each item is a compact node plus `matchedBy`, `callers`, `callees`, `topCallers[5]`, `topCallees[5]`, `container?`, `readHint` |
| `cgb_callers` | Who calls a symbol (BFS over `calls` edges) | `id`, `depth` (default 1, max 5), paging | `{ target, depth, ...page of { ...compact node, depth, via } }` |
| `cgb_callees` | What a symbol calls (BFS over `calls` edges) | `id`, `depth` (default 1, max 5), paging | same shape as `cgb_callers` |
| `cgb_search` | Single search entry point: exact, then prefix, then full-text; optional vectors | `query`, `kinds`, `includeExternal`, `semantic`, `contextFiles`, paging | `{ query, ...page of { ...compact node, matchedBy, score } }` |
| `cgb_embed_search` | **Deprecated alias** of `cgb_search` (same handler, same output) | same as `cgb_search` | same as `cgb_search` |
| `cgb_embed_similar` | Nodes similar to a node | `nodeId`, paging | `{ nodeId, ...page }` |
| `cgb_embed_build` | Compute embeddings | `provider` | `{ provider, ...counts }` |
| `cgb_deps` | What a file imports | `target`, `depth`, paging | `{ target, direct: page, transitive: page }` of compact nodes |
| `cgb_impact` | Files affected by changing a file | `target`, `depth`, paging | `{ target, ...page of { depth, ...compact node } }` |
| `cgb_path` | Shortest dependency path | `from`, `to` | `{ found, length, path: [compact nodes], edges }` |
| `cgb_bundle` | Markdown context for a file or symbol (`target` may be a file path or a node id) | `target`, `depth`, `includeSource`, `maxTargetLines` (200), `includeDependencySource` (false) | `{ target, tokenEstimate, bundle }` |
| `cgb_call_chain` | Outgoing call trace | `nodeId`, `maxDepth`, paging | `{ nodeId, ...page of { id, name, filePath, kind, depth } }` |
| `cgb_entry_points` | Functions with no inbound calls | paging | page of `{ id, name, filePath, kind, fanIn, fanOut }` |
| `cgb_large_functions` | Most connected functions | paging | page with `complexityScore` |
| `cgb_criticality` | Criticality scores and labels | paging | page with `score`, `label` |
| `cgb_communities` | Module clusters (persists community ids) | paging | page of clusters with up to 15 files, `fileCount`, `algorithm` |
| `cgb_architecture` | Architecture overview | paging (for clusters) | `{ algorithm, totalFiles, totalNodes, communities: page, layers, cycleCount, cycles, orphanCount, orphans, healthScore, healthNotes }` |
| `cgb_dead_code` | Symbols with no inbound references | paging, `includeUnusedExports` (false) | page of `{ id, name, filePath, kind, reason }`; with `includeUnusedExports` also `unusedExports` (page of exported symbols nobody references or imports) |
| `cgb_refactor_suggest` | Structural refactor suggestions | paging | page of suggestions |
| `cgb_rename_preview` | Preview a rename | `nodeId`, `newName` | preview; with `newName` includes `refactorId`, `items` (`file`, `line`, `column`, `before`, `after`, `confidence` high/low) and `warnings`; an invalid identifier returns an error |
| `cgb_apply_refactor` | Apply a stored rename preview, then re-index the touched files | `refactorId` | `{ status, files, filesModified, editsApplied, reparsed }`; on drift `status: "error"` with `conflicts` (nothing written); `expired` after 10 minutes |
| `cgb_detect_changes` | Risk-scored git diff analysis (risk is 0-100) | `base` | per-file analysis |
| `cgb_review_context` | Review brief for a git diff | `base`, `format` | markdown brief or JSON |
| `cgb_wiki_generate` | Generate a Markdown wiki | `outputDir`, paging | page list, or written file list |
| `cgb_wiki_section` | Wiki page for one community | `communityIndex` | `{ title, slug, content, ... }` |
| `cgb_registry_register` | Add a project to the global registry | `root`, `name` | `{ registered }` |
| `cgb_registry_list` | List registered projects | paging | page of registry entries |
| `cgb_registry_search` | Search all registered projects | `query`, `maxPerRepo`, paging | `{ query, ...page }` |

All tools except the registry pair also accept `root`. Errors come back as `isError: true` with a one-line message and, where useful, a `Hint:` line.

## Search and symbol lookup

`cgb_search` uses the ranked search from the graph database: exact name first, then prefix, then FTS5 BM25 over name, description and path. `matchedBy` is `exact`, `prefix` or `fts`. When `semantic` is true, or embeddings exist (`cgb_embed_build`) and the query has spaces, it switches to hybrid search, which fuses the lexical ranking with vector similarity (RRF) and reports `matchedBy: "hybrid"`. Without embeddings, hybrid is lexical only. Externals are hidden unless `includeExternal` is true.

`cgb_symbol` tries an exact name match first (class, interface, function, method, type, then file), and falls back to ranked search if nothing matches. `id` takes precedence over `name`. `file` restricts to paths containing that text. `callers` and `callees` count distinct nodes over `calls` edges; `container` is the owning class for methods; `readHint` is `Read <file> lines <a>-<b>`.

`cgb_callers` and `cgb_callees` walk `calls` edges breadth-first with a visited set (so cycles are safe, and each node appears once at its nearest depth). `via` is the edge reason (`call`, `new`, `call via this`, ...); at depth 2 and beyond it also names the intermediate node. Traversal stops at 5000 nodes and sets `capped: true`.

## Freshness

Read tools check for edited files before answering, so the graph is never stale after you change code. Per call (at most once every 2 seconds per root):

- Known files are compared by modification time against the graph; deleted files are removed.
- In a git repository, `git ls-files --cached --others --exclude-standard` finds new files (supported extensions only, ignoring `node_modules`, `dist`, `build`, `vendor` and similar). Without git, only already-known files are refreshed.
- Changed and new files are re-parsed together and cross-file links are rebuilt. Files whose content did not change are skipped by hash.
- A budget of 1500 ms and 200 files applies. If it is exceeded the tool still answers from the current graph and adds `"stale": true` and a `staleHint` to the result; run `cgb_init` to catch up.

`cgb_init` and the registry tools do not auto-refresh. Set `CGB_NO_AUTOREFRESH=1` to turn the whole mechanism off.

## Which tool when

Work down this list and stop as soon as you have the answer: symbol, then callers/callees, then impact, then bundle, then search.

- **Know a name:** `cgb_symbol`. It gives location, signature, line range and the main callers and callees; read only the lines it points at.
- **Who uses it / what does it use:** `cgb_callers` and `cgb_callees` (use `depth` 2 or 3 to follow chains).
- **Blast radius of editing a file:** `cgb_impact`; what it relies on: `cgb_deps`.
- **Full structural context for a file:** `cgb_bundle`.
- **Do not know the name:** `cgb_search` (add `kinds` to narrow; multi-word queries use vectors when embeddings exist).
- **Orient in a new repo:** `cgb_init`, then `cgb_stats`, then `cgb_architecture`, then `cgb_entry_points`.
- **Understand a flow:** `cgb_entry_points`, then `cgb_call_chain` or `cgb_callees` with a depth.
- **Review a change set:** `cgb_detect_changes` for risk scores, `cgb_review_context` for a brief.
- **Clean up:** `cgb_dead_code`, `cgb_large_functions`, `cgb_refactor_suggest`.
- **Rename safely:** `cgb_rename_preview` with `newName`, inspect the edits, then `cgb_apply_refactor`.
- **Docs:** `cgb_wiki_generate`, or `cgb_wiki_section` for one community.
