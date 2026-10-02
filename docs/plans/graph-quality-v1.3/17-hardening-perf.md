# Slice 17: Hardening and perf (N+1 batching, git working tree, viz bind)

## Goal
Remove the per-edge query loops that make impact, path, deps and change analysis slow on real repos, include uncommitted changes in change detection (the most common state while Claude is editing), and stop the viz server from listening on all network interfaces.

## Prerequisites
- 01: `src/util/log.ts`, and `git/diff.ts` already uses `execFileSync`.
- 06: `GraphDb.getNodesByIds`, `transaction`, prepared statements.

## Files touched
- `src/graph/engine.ts`
- `src/graph/__tests__/engine.test.ts`
- `src/git/changes.ts`
- `src/git/diff.ts`
- `src/git/__tests__/changes.test.ts`, `src/git/__tests__/diff.test.ts`
- `src/viz/index.ts`: the listen call only
- `docs/TROUBLESHOOTING.md`

## Suggested model
Sonnet

## Read only these files
- `src/graph/engine.ts`, `src/graph/__tests__/engine.test.ts`
- `src/git/changes.ts`, `src/git/diff.ts`, `src/git/risk.ts` (read only)
- `src/git/__tests__/*.test.ts`
- `src/graph/db.ts` public signatures (read only)
- `src/viz/index.ts`, around the `server.listen` call near the end of the file
- `docs/TROUBLESHOOTING.md`

## Background
- New DB API (slice 06): `getNodesByIds(ids: string[]): GraphNode[]` (chunked, unordered), `getNodesByName`, `transaction(fn)`. All existing methods are unchanged.
- **D12**: stderr logs only.

Hotspots found in the 2026-10-02 audit:
- `engine.impact`, `engine.path` and the transitive part of `engine.deps` call `getNode` once per edge. Change them to a BFS **per level**: collect the frontier IDs, then `getEdgesTo/From` per ID, which is acceptable because statements are prepared, then one `getNodesByIds` per level. Add a `maxNodes` safety cap (default 5000) and report truncation in the result: add an optional `truncated?: boolean` field locally to the result object. `types.ts` is owned by slice 07, which is done by now, so a one-field optional addition to `ImpactResult` / `DepsResult` in `types.ts` **is allowed in this slice**.
- `engine.layers()` calls `getNodesByFile` per file. Use one `getAllNodes()` and group in memory.
- `analyzeChanges` in `git/changes.ts` runs a full impact BFS for every node in every changed file. Change it to one **multi-source** BFS seeded with all changed nodes, tracking depth per node.
- `git/diff.ts`:
  - When no `base` is given, diff against `HEAD`, **including** staged and unstaged working-tree changes (`git diff HEAD`) plus untracked files (`git ls-files -o --exclude-standard`, treated as fully added).
  - When `base` is given, keep the current `base..HEAD` semantics, and add `includeWorkingTree?: boolean` (default true) to also merge working-tree changes.
  - Keep the exported signatures backward compatible by adding only optional params.
- `viz/index.ts`: `server.listen(port)` binds `0.0.0.0`. Use `server.listen(port, host)` with `host = process.env.CGB_VIZ_HOST ?? '127.0.0.1'`. Print the URL using that host.

## Tasks
1. Rewrite the engine traversals as described. Results must be **identical** to before on the existing fixture, apart from the new optional fields. The existing 21 engine tests must pass unchanged. Add tests: the `maxNodes` cap sets `truncated`, and `layers` output is unchanged.
2. Implement the multi-source BFS in `analyzeChanges`. The existing changes tests must pass. Add a test with 3 changed files sharing dependents, where each dependent appears once at its minimum depth.
3. Add working-tree support to `diff.ts`. Test it on a temp git repo (`git init`, commit, then modify and add an untracked file). The diff must include both.
4. Apply the viz host fix.
5. Add to `docs/TROUBLESHOOTING.md`: viz is localhost-only by default (`CGB_VIZ_HOST` overrides it), and detect-changes now includes uncommitted work.
6. Perf check: time `impact` on the most-imported file in this repo, before and after (use `node -e` against `dist/`). Report both numbers.

## Out of scope
- MCP handler code (`server.ts`). The handlers keep calling the same engine and git functions.
- CI and lint (18).

## Done when
```
npx tsc --noEmit
npx jest src/graph src/git
npx jest
npm run build
```
All pass, and the before/after timings are in the report.

## Finish
1. Tick `- [x] 17` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above (plus `src/types.ts` if you used the allowed optional field) and that README: `perf(slice-17): batched graph traversals, multi-source change impact, working-tree diffs, localhost viz`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count and the timings.
