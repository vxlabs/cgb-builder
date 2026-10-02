# Slice 11: Communities (working Louvain, perf)

## Goal
Make community detection actually use weighted Louvain, and make it fast. Today `require('graphology').default` and `require('graphology-communities-louvain').default` are both `undefined`, so `new Graph` throws. A `catch` then silently falls back to Union-Find connected components over imports, and `cgb_communities` / `cgb_architecture` report garbage clusters.

## Prerequisites
- 01: `src/util/log.ts`.

## Files touched
- `src/communities/index.ts`
- `src/communities/__tests__/communities.test.ts` (new)
- `docs/FEATURES.md`: the "Architecture Analysis" section (owned by track C)

## Suggested model
Sonnet

## Read only these files
- `src/communities/index.ts` (whole file, about 540 lines)
- `src/graph/db.ts`: public method signatures only (read only; owned by track B)
- `src/types.ts`: `CommunityRecord` and related types (read only)
- `node_modules/graphology/package.json` and `node_modules/graphology-communities-louvain/package.json` (check `main`/`exports` and the export shape)
- `docs/FEATURES.md`

## Background
- The bug is at `src/communities/index.ts:174-177` and `:263-266`, written as `const { default: Graph } = require('graphology')`. Under CommonJS, `require('graphology')` returns the constructor itself, and the louvain package returns a function with `.assign` / `.detailed`. Use a tolerant loader: `const mod = require('graphology'); const Graph = mod.default ?? mod.Graph ?? mod;`, and the same for louvain. Prefer typed `import` statements if `tsconfig` module settings allow. Check `tsconfig.json` `module` / `esModuleInterop`.
- Edge weights for the community graph, between file-level or symbol-level nodes as the code does today: `calls` 3, `inherits`/`implements` 2, `imports` 1. `contains` and `exports` are excluded, since they are structural. **Read the existing weighting first and keep it if it's already defined.**
- Use louvain options `{ resolution: 1, getEdgeWeight: 'weight', randomWalk: false }` and a seeded `rng` if supported, so results are deterministic and tests stay stable.
- Keep the Union-Find fallback, but it must log `warnOnce('communities', 'fallback', ...)`. The result must carry `algorithm: 'louvain' | 'connected-components'` so callers can see which one ran. Add the field to the returned objects if absent. If a shared type in `types.ts` would need a change, return it on the local result type instead (`types.ts` is owned by slice 07).
- Perf problems to fix (all inside this file):
  - The persist path calls `db.getAllNodes()` once per community (around line 95). Load it once.
  - `findHubs` scans every node for every community (around 428-440). Precompute degree per node once.
  - `computeCoupling` calls `getAllNodes` per community (around 445). Build `nodeId → communityId` once.
  - Wrap persistence in `db.transaction(() => ...)` if it exists (slice 06). Otherwise call methods directly.

## Tasks
1. Fix the module loading. Log the fallback and set `algorithm`.
2. Remove the per-community full scans listed above.
3. Write `communities.test.ts` with a real `GraphDb` in a temp dir. Seed two dense clusters (5 files each, many intra-cluster `calls`/`imports`) joined by one edge. Assert:
   - `algorithm === 'louvain'`
   - exactly 2 communities, each containing the expected members
   - hubs are the highest-degree nodes
   - coupling between the clusters is > 0 and small
   - a forced loader failure (jest module mock) yields `connected-components` and still returns results
4. Update `docs/FEATURES.md` "Architecture Analysis": the algorithm, weights, fallback and the `algorithm` field.

## Out of scope
- MCP output shape changes (14).
- `db.ts` changes.

## Done when
```
npx tsc --noEmit
npx jest src/communities
npx jest
npm run build
node dist/cli/index.js init -r .
```
All pass. After init, running communities via the CLI or MCP on this repo reports `louvain`. If there is no CLI command for it, call the module in a short `node -e` script against `dist/` and paste the output.

## Finish
1. Tick `- [x] 11` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `fix(slice-11): load graphology correctly so Louvain runs; remove N+1 scans`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, and the community count and runtime on this repo.
