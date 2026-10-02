# Slice 12: Line-range consumers (bundle snippets, real LOC, entry points)

## Goal
Use the new line ranges so context bundles return **just the relevant code** instead of whole files, and so "large functions" means large by lines. Today `cgb_bundle` embeds full file sources with no cap (`maxDependencyLines` is never used), and `findLargeFunctions` only counts `calls` fan-in/fan-out.

## Prerequisites
- 08: TS nodes have `startLine`, `endLine`, `signature`, `doc` and `exported`.
- 11: track C doc ownership. `docs/FEATURES.md` was last edited by 11.

## Files touched
- `src/bundle/generator.ts`
- `src/flows/index.ts`
- `src/bundle/__tests__/generator.test.ts` (new)
- `src/flows/__tests__/flows.test.ts` (new)
- `docs/FEATURES.md`: the "AI Context" and "Architecture Analysis" (large functions, entry points) entries

## Suggested model
Sonnet

## Read only these files
- `src/bundle/generator.ts`, `src/flows/index.ts`
- `src/types.ts` `GraphNode` (read only)
- `src/graph/db.ts` public signatures (read only)
- `src/graph/engine.ts`: `callers`, `callees`, `deps` signatures (read only)
- `docs/FEATURES.md`

## Background
`GraphNode` optional fields (slice 07): `startLine?`, `endLine?` (1-based inclusive), `signature?`, `doc?`, `exported?`, `modifiers?`. Nodes from adapters that haven't been upgraded may lack them, so every consumer must degrade gracefully.

Bundle behaviour (new defaults; keep existing option names, adding new ones only):
- For a **symbol target** (function, method or class):
  - Emit its code from `startLine..endLine`, capped at `maxTargetLines` (default 200) with a `… (N more lines)` marker.
  - Then the **callers** and **callees** (one hop): signature + `path:start-end` + doc, with no bodies.
  - Then the file's imports.
- For a **file target**:
  - An outline: each top-level symbol's signature, range and doc.
  - Then the full source only if it is ≤ `maxTargetLines`. Otherwise the outline only, plus the first `maxTargetLines` lines.
- Dependencies: signature and range only by default. Honour the existing `maxDependencyLines`, which is currently unused, as a per-dependency snippet cap when `includeDependencySource` (or the existing equivalent flag) is true.
- Output a total size line: `≈ N lines, M chars`. Paths are relative to the project root when the generator knows it.

Flows:
- `findLargeFunctions(db, limit)`:
  - Ranks by `loc = endLine - startLine + 1` when present, falling back to the existing connectivity score.
  - Returns `loc`, `signature`, `startLine` and `endLine` in each item. Keep the existing fields.
- Entry points: prefer `exported` functions with zero incoming `calls` edges. Keep the existing heuristics as secondary.
- Call-chain output items include `signature` and `startLine` when available.

## Tasks
1. Implement the bundle behaviour above, with tests on a seeded `GraphDb` plus temp source files:
   - symbol bundle contains only the symbol lines
   - the truncation marker appears
   - file outline appears for a big file
   - a node with no ranges falls back to the old behaviour
2. Implement the flows changes, with tests:
   - LOC ordering
   - exported zero-caller entry points
   - fallback when ranges are missing
3. Update `docs/FEATURES.md`.

## Out of scope
- MCP tool schemas and descriptions (14/15 own `server.ts`). If you add bundle options, report them so slice 15 can expose them.
- Refactor code (13).

## Done when
```
npx tsc --noEmit
npx jest src/bundle src/flows
npx jest
npm run build
node dist/cli/index.js init -r . && node dist/cli/index.js bundle "<a function node id from this repo>" -r .
```
All pass. The CLI bundle for a function prints only that function's body plus caller and callee signatures.

## Finish
1. Tick `- [x] 12` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-12): symbol-scoped bundles and LOC-based large functions`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, bundle size before and after for one file and one function on this repo, and any new options for slice 15.
