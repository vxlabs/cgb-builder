# Slice 14: MCP core ergonomics (optional root, compact output, pagination)

## Goal
Make every MCP tool cheap to call and cheap to read for Claude Code. Today:
- every one of the 27 tools *requires* `root`, and `--root` / `CGB_ROOT` are ignored
- responses are pretty-printed JSON with absolute paths repeated in `id` and `filePath`
- lists have no limits; `cgb_communities` and `cgb_impact` can return thousands of entries
- several descriptions are wrong

## Prerequisites
- 01: `src/util/log.ts`.
- 06: the better-sqlite3 `GraphDb`. Every handler must `close()` its DB.

## Files touched
- `src/mcp/server.ts`
- `src/mcp/format.ts` (new): output helpers
- `src/mcp/__tests__/format.test.ts` (new)
- `src/mcp/__tests__/server.test.ts` (new): handler-level tests
- `docs/MCP_TOOLS.md` (new; owned by track D)

## Suggested model
Sonnet

## Read only these files
- `src/mcp/server.ts` (about 1260 lines). The tool definitions are around 87-504, the handlers in between, the dispatch around 1183-1255, and the startup at 1133.
- `src/types.ts` `GraphNode` (read only)
- `src/graph/db.ts` public signatures (read only)

## Background
Decisions (final):
- **D8**: compact JSON (no indentation), repo-relative paths. List tools accept `limit` (default 50, max 500) and `offset`. List responses are shaped `{ total, returned, offset, truncated, items: [...] }`.
- **D9**: `root` is optional everywhere. Resolve it as `args.root ?? process.env.CGB_ROOT ?? process.cwd()`. Slice 16 makes `cgb mcp --root X` set `process.env.CGB_ROOT`. **Don't edit `src/cli/index.ts`.**
- **D12**: never write to stdout outside the MCP transport. Diagnostics use `log.ts`.

Format contract (`src/mcp/format.ts`; slice 15 reuses it):
```ts
export function resolveRoot(args: { root?: string }): string;     // D9, path.resolve'd
export function rel(root: string, p: string): string;              // repo-relative with forward slashes; externals unchanged
export function compactNode(root: string, n: GraphNode): CompactNode;
// CompactNode = { id, kind, name, file /*rel*/, lines? /* "12-40" */, sig?, doc?, exported? } — omit undefined/empty fields
export function page<T>(items: T[], args: { limit?: number; offset?: number }, defLimit = 50): { total: number; returned: number; offset: number; truncated: boolean; items: T[] };
export function ok(data: unknown): ToolResult;   // JSON.stringify(data) — no indentation
export function err(message: string, hint?: string): ToolResult; // isError: true
```
- Node IDs in output stay **absolute**. They are the lookup keys, and `kind:<absPath>#sym` is the format accepted as input.
- Add an `idHint` input convenience: any tool taking a node ID also accepts a repo-relative ID such as `function:src/a.ts#foo`, which is expanded against the root before lookup. Implement that in `format.ts` as `expandId(root, id)`.

Known description and behaviour fixes:
- The `cgb_call_chain` description shows the ID example `function:path/to/file.ts:myFunc`. The correct format is `function:<path>#myFunc`.
- The `pre_merge_check` prompt says "risk > 0.7". Scores are 0–100, so it should say "risk > 70".
- The server reports version `1.0.0`. Read the version from `package.json`: `createRequire(import.meta.url)` or `require('../../package.json')`, whichever this tsconfig allows.
- `handleEmbedSimilar` never closes the DB. Fix it with `try/finally`, and audit every handler for the same leak.
- If the DB has no nodes, return `err('Graph not built for <root>', 'Call cgb_init first')`.
- Write every description for an LLM reader: one line saying what it returns, then when to use it versus its neighbours. Don't change tool **names** in this slice (slice 15 merges and adds tools).

## Tasks
1. Create `format.ts` with tests.
2. Refactor every handler to use `resolveRoot`, `expandId`, `compactNode`, `page` and `ok`/`err`. Remove `root` from every `required` array. Add `limit`/`offset` to every list-returning tool's input schema.
3. Apply the fixes listed above.
4. Write `server.test.ts`. Export the dispatch function, or a `handleTool(name, args)`, from `server.ts` for testing. Seed a temp `GraphDb` and assert:
   - a call without `root` uses `CGB_ROOT`
   - paths are relative
   - pagination fields are present and correct
   - no DB handle leaks: call 50 times and check open handles don't grow, or spy on `close`
   - an empty graph produces the error hint
5. Write `docs/MCP_TOOLS.md`:
   - a table of every tool: name, purpose, key inputs, output shape
   - the conventions: root resolution, IDs, pagination, compact nodes
   - a "which tool when" guide

## Out of scope
- New tools, merging search tools, auto-freshness (15).
- CLI and install changes (16).

## Done when
```
npx tsc --noEmit
npx jest src/mcp
npx jest
npm run build
```
All pass. A manual stdio smoke works: `printf '<initialize + tools/call cgb_stats {}>' | CGB_ROOT=$PWD node dist/cli/index.js mcp`, or the MCP inspector, returns compact stats without `root`.

## Finish
1. Tick `- [x] 14` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-14): optional root, compact paginated MCP output, description fixes`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, and the response size in chars before and after for `cgb_stats`, `cgb_search` and `cgb_impact` on this repo.
