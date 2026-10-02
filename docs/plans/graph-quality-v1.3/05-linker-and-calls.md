# Slice 05: Linker pass, TS call edges, incremental correctness

## Goal
Give TS/JS real `calls` edges and resolve cross-file `inherits`/`implements`, so `callers`, `callees`, call_chain, entry_points and criticality work for TypeScript projects. This adds a post-parse **linker** that resolves symbol references across files. It also fixes two incremental-update bugs: deleted files are never removed by `scanAll`, and dangling edges build up.

## Prerequisites
- 04: the TS adapter writes `meta.imports` / `meta.reexports` on file nodes, plus `meta.heritage` on classes and interfaces (from 03).
- 06: better-sqlite3 `GraphDb` with `transaction`, `getNodesByIds`, `getNodesByName`, `deleteDanglingEdges`, and outgoing-only `deleteEdgesByFile`.

## Files touched
- `src/parser/adapter.ts`: adds the `SymbolRef` type and an optional `refs` on the adapter result
- `src/parser/adapters/typescript.ts`: call and heritage ref emission only
- `src/parser/linker.ts` (new)
- `src/parser/index.ts`: run the linker after each batch, handle deleted files, wrap writes in transactions
- `src/parser/__tests__/linker.test.ts` (new)
- `docs/languages/typescript.md`: fill in the "Calls" section

## Suggested model
Sonnet

## Read only these files
- `src/parser/adapter.ts`, `src/parser/index.ts`, `src/parser/adapters/typescript.ts`
- `src/graph/db.ts`: public method signatures only. **Don't edit it.**
- `src/types.ts` lines 1-110 (read only)
- `src/parser/__tests__/helpers.ts`, `docs/languages/typescript.md`

## Background
Decisions (final):
- **D4**: IDs are `kind:<absPath>#<symbol>`. Methods are `method:<abs>#<Class>.<name>`.
- **D6**: edges have no FK. Re-parse deletes the file's nodes and outgoing edges only. The linker prunes dangling edges after each batch with `db.deleteDanglingEdges()`.
- **D7**: call resolution is heuristic, with no type checker. Order:
  1. **Same file**: a top-level function/class (`new X()` → class) with that name in this file.
  2. **Imported binding**: the callee identifier (or the namespace object in `ns.f()`) matches a `meta.imports[].local` of the caller's file. Look up `imported` (or `f` for namespace imports) as a symbol in `source`. If it isn't found there, follow `source`'s `meta.reexports` **one level**, by name or through `*`. `default` matches the symbol whose `exports` edge reason or meta marks it as default. Otherwise match by name.
  3. **`this.m()` / `super.m()`**: method `m` on the enclosing class, then on its resolved parent class (one level).
  4. Otherwise **unresolved**: drop it. Increment `meta.unresolvedCalls` (a number) on the caller node, and keep the first 20 names in `meta.unresolvedSample`.
- `obj.method()` on an arbitrary object is unresolved, unless `obj` is an imported namespace or a class name (static call → `method:<file>#<Class>.method`).
- Calls are attributed to the **enclosing top-level symbol**: a function, method or `const` arrow. A call at module top level is attributed to the file node. Nested function bodies count toward their enclosing top-level symbol (03 doesn't create nested nodes).
- Duplicate calls from the same caller to the same callee are one edge. Edge `reason` = `"call"`, `"new"`, or `"call via <binding>"`.

Contracts:
```ts
// src/parser/adapter.ts
export interface SymbolRef {
  fromId: string;                 // caller node id (function/method/file) or class/interface id for heritage
  kind: 'calls' | 'inherits' | 'implements';
  name: string;                   // bare callee / parent name, e.g. 'find', 'BaseRepo'
  qualifier?: string;             // 'this' | 'super' | object/namespace identifier, e.g. 'api', 'utils'
  isNew?: boolean;                // new X()
  line?: number;                  // 1-based, optional
}
export interface ParsedFileWithRefs extends ParsedFile { refs?: SymbolRef[] }
// LanguageAdapter.parse may now return ParsedFileWithRefs (back-compatible).

// src/parser/linker.ts
export interface LinkStats { resolved: number; unresolved: number; pruned: number }
export class Linker {
  constructor(db: GraphDb);
  /** Resolve refs produced by the files just parsed, write edges, prune dangling. */
  link(batch: Array<{ filePath: string; refs: SymbolRef[] }>): LinkStats;
}
```
- File node `meta` (from slice 04): `imports: [{source, isExternal, local, imported, typeOnly?, dynamic?}]` and `reexports: [{source, isExternal, imported, exported}]`.
- Class and interface `meta.heritage = { extends: string[], implements: string[] }` (from slice 03). The adapter turns each name into a heritage `SymbolRef` whose parent is **not** in the same file. 03 already emits same-file edges.
- Persisting refs: refs only need to live for the duration of the batch. Do **not** add DB tables. However, when file A is re-parsed, incoming edges from unchanged file B to A's symbols survive (D6). Edges from B to symbols A no longer has are pruned as dangling. A newly added symbol in A that B calls by name won't link until B is re-parsed. Accept this limitation and document it under "Calls → limits".

`parser/index.ts` changes:
- `parseFiles` collects `{filePath, refs}` from each parsed file and calls `new Linker(db).link(batch)` once at the end.
- Wrap each file's delete and insert in `db.transaction`.
- `scanAll`: any `files` row whose path no longer exists on disk (or is no longer discovered) → `deleteNodesByFile`, `deleteEdgesByFile`, `deleteFile`, then `deleteDanglingEdges`.
- Parse-time edges whose target isn't in the DB yet (for example an import of a file later in the batch) are fine, since there is no FK. The prune runs **after** all files in the batch are written.

## Tasks
1. Add the types to `adapter.ts`.
2. In `typescript.ts`, walk `call_expression` and `new_expression` inside each top-level symbol body and the module top level, and emit `SymbolRef`s:
   - `foo()` → name `foo`
   - `this.foo()` → qualifier `this`
   - `a.b()` → name `b`, qualifier `a`; for deeper chains like `a.b.c()`, use name `c`, qualifier `a.b`, which is unresolved unless `a` is a namespace import
   - `new X()` → `isNew`
   - optional chaining `a?.b()` is handled the same way
   - also emit heritage refs for cross-file parents
3. Implement `linker.ts` per D7, using batched DB lookups (`getNodesByIds`, `getNodesByName`, `getNodesByFile`). Avoid one query per ref where a per-file cache works.
4. Update `parser/index.ts` as described.
5. Write `linker.test.ts`. Build real temp-dir projects (files on disk) and run `Parser` + `GraphDb` end to end:
   - same-file call
   - named import call
   - default import call
   - namespace import `ns.f()`
   - call through a barrel `index.ts` re-export (`export *` and named)
   - `this.m()` resolved to its own class method, and inherited from a parent in another file
   - `new X()` → class
   - unresolved count on the caller
   - cross-file `implements` edge resolved
   - delete a file → its nodes and edges are gone and no dangling edges remain
   - re-parse a callee file → the caller's edge survives when the symbol still exists, and is pruned when the symbol is removed
6. Fill in the "Calls" section of `docs/languages/typescript.md`: the resolution order, attribution rules and limits.

## Out of scope
- Call extraction for other languages (C# already has it; the rest is slice 09's matrix, not here).
- Line ranges or signature metadata (08).
- Editing `db.ts`, `types.ts` or `utils.ts`.

## Done when
```
npx tsc --noEmit
npx jest src/parser
npx jest
npm run build
node dist/cli/index.js init -r . && node dist/cli/index.js stats -r .
node dist/cli/index.js callers "function:<abs path to src/parser/index.ts>#<some fn>" -r .
```
All pass. Stats show `calls` edges > 0 for this repo, and the `callers` command returns real results. Running `sqlite3 .cgb/graph.db "select count(*) from edges e left join nodes n on n.id=e.to_id where n.id is null"` (or the same query through a small node script) returns 0.

## Finish
1. Tick `- [x] 05` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-05): linker pass with TS call and cross-file heritage edges`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, calls edges on this repo, resolved and unresolved totals from `LinkStats`, and init time.
