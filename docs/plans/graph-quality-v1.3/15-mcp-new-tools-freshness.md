# Slice 15: MCP new tools (`cgb_symbol`, `cgb_callers`, `cgb_callees`) and auto-freshness

## Goal
Add the tools that directly replace grep/read loops, consolidate overlapping search tools, and keep the graph fresh automatically, so Claude never answers from a stale graph after editing files.

## Prerequisites
- 05: TS `calls` edges.
- 07: line ranges, signature and doc fields.
- 10: ranked `searchNodes` / `searchNodesRanked` with `SearchOptions`.
- 14: `src/mcp/format.ts` helpers and refactored handlers.
- Optional: 12 and 13. If they have landed, expose any new bundle or refactor options they reported.

## Files touched
- `src/mcp/server.ts`
- `src/mcp/freshness.ts` (new)
- `src/mcp/__tests__/tools.test.ts` (new)
- `src/mcp/__tests__/freshness.test.ts` (new)
- `docs/MCP_TOOLS.md`

## Suggested model
Sonnet

## Read only these files
- `src/mcp/server.ts`, `src/mcp/format.ts`
- `src/graph/engine.ts`: `callers`, `callees` and `impact` signatures (read only; owned by slice 17)
- `src/graph/db.ts` public signatures (read only)
- `src/parser/index.ts`: `Parser` constructor, `parseFiles` and `scanAll` signatures (read only)
- `docs/MCP_TOOLS.md`

## Background
Format helpers (slice 14): `resolveRoot`, `rel`, `compactNode` (`{id, kind, name, file, lines?, sig?, doc?, exported?}`), `expandId`, `page`, `ok`, `err`. Conventions: D8 compact paginated output, D9 optional root, D12 stderr logs.

Search contract (slice 10):
```ts
searchNodes(query, opts?: { limit?, kinds?, includeExternal? }): GraphNode[];
searchNodesRanked(query, opts?) → { id, score, matchedBy: 'exact'|'prefix'|'fts' }[]
```
`hybridSearch` in `src/embed/index.ts` adds vectors only when embeddings exist (D10).

New and changed tools:
- **`cgb_symbol`** `{ name?: string, id?: string, kind?: NodeKind, file?: string, limit? }`. Exact-name or ID lookup, falling back to ranked search. Each match returns `compactNode` plus:
  - `callers: number`, `callees: number`
  - `topCallers` / `topCallees`: up to 5 compact nodes each
  - `container` (the class for methods)
  - `readHint: "Read <file> lines <a>-<b>"`

  The description must say it is *the first tool to use when you know a name*.
- **`cgb_callers`** / **`cgb_callees`** `{ id, depth = 1 (max 5), limit?, offset? }`. BFS over `calls` edges using `engine.callers` / `engine.callees` per hop, with a visited set. Items are `{ ...compactNode, depth, via }`.
- **`cgb_search`** becomes the single search entry point: `{ query, kinds?, includeExternal?, semantic?: boolean, limit?, offset? }`.
  - It uses `searchNodesRanked`. When `semantic` is true, or embeddings exist and the query has spaces, it uses `hybridSearch`.
  - Each item carries `matchedBy` and `score`.
  - `cgb_embed_search` stays as a **deprecated alias** that calls the same handler; say so in its description. Fix its false BM25/FTS5 claims.
- `cgb_bundle`: expose any new options slice 12 reported.

Auto-freshness (`src/mcp/freshness.ts`):
```ts
export async function ensureFresh(root: string, db: GraphDb, opts?: { maxFiles?: number /*200*/; budgetMs?: number /*1500*/ }): Promise<{ reparsed: number; removed: number; skipped: boolean }>;
```
- It compares on-disk mtime to `files.mtime` for known files, and discovers new files only if the cheap path allows it. A cheap path is `git ls-files -m -o --exclude-standard` via `execFileSync` (when `.git` exists), filtered to supported extensions. Otherwise it falls back to stat-ing known files.
- It re-parses changed and new files with `Parser.parseFiles(files)`, which runs the linker (slice 05), and removes deleted files.
- It respects the budget. If it is exceeded, it returns `skipped: true`, and the tool response includes `"stale": true` with a hint to run `cgb_init`.
- Throttle to at most once per 2 s per root (a module-level map).
- Call `ensureFresh` at the start of every **read** tool handler. Skip it for `cgb_init`, which already scans, and for registry tools.
- Opt out with env `CGB_NO_AUTOREFRESH=1`.

## Tasks
1. Implement `freshness.ts` with tests on a temp git repo: modify a file and the next call reflects the change, delete a file and its nodes disappear, a slow-path budget overrun sets `skipped`, and the throttle holds.
2. Add `cgb_symbol`, `cgb_callers` and `cgb_callees`. Consolidate `cgb_search` and alias `cgb_embed_search`. Wire in `ensureFresh`.
3. Write `tools.test.ts`, seeding a temp TS project, then running `Parser.scanAll`, then calling the handlers:
   - `cgb_symbol` by name returns lines and signature
   - `cgb_callers` with depth 2
   - `cgb_search` puts the exact match first
   - the alias returns the same result
4. Update `docs/MCP_TOOLS.md`: the new tools, the deprecation, the freshness behaviour and env flags. Rewrite the "which tool when" guide as: symbol → callers/callees → impact → bundle → search.

## Out of scope
- `engine.ts` changes (slice 17 batches it; use its public methods as they are).
- CLI and install (16), README (19).

## Done when
```
npx tsc --noEmit
npx jest src/mcp
npx jest
npm run build
```
All pass. A manual MCP smoke on this repo (`CGB_ROOT=$PWD`) works: `cgb_symbol {"name":"GraphDb"}` returns the class with `lines` and `topCallers`. Then edit a file, and the next `cgb_symbol` reflects the edit without calling `cgb_init`.

## Finish
1. Tick `- [x] 15` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-15): cgb_symbol/callers/callees, unified search, auto-freshness`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, the final tool list (for slices 16 and 19), and freshness timing on this repo.
