# Slice 03: TS/JS/TSX symbol extraction

## Goal
Make the TypeScript/JavaScript adapter actually extract functions, methods and the other TS declarations, for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs`. Today it yields zero function and method nodes for any TS/JS file, and JS files get no classes.

## Prerequisites
- 01: the logger at `src/util/log.ts`; adapter catches already log.
- 02: the test harness at `src/parser/__tests__/helpers.ts`.

## Files touched
- `src/parser/adapters/typescript.ts`
- `src/parser/tree-sitter-engine.ts`
- `src/parser/__tests__/typescript.test.ts` (new)
- `docs/languages/typescript.md` (new; owned by track A)

## Suggested model
Sonnet

## Read only these files
- `src/parser/adapters/typescript.ts` (whole file, about 370 lines)
- `src/parser/tree-sitter-engine.ts`
- `src/parser/utils.ts` (`makeNodeId`, `makeEdgeId`, `fileDisplayName`). **Read it, but don't edit it.** Slice 07 owns it.
- `src/types.ts` lines 1-110 (read only; slice 07 owns it)
- `src/parser/__tests__/helpers.ts`
- `src/util/log.ts`

## Background
Root causes, verified on 2026-10-02:
1. `FUNCTION_QUERY` has `(method_definition key: (property_identifier) ...)`. In this grammar version the field is **`name:`**. The whole alternation fails to compile ("Bad pattern structure"), so no `function` nodes come out at all.
2. `CLASS_QUERY` / `INTERFACE_QUERY` use `type_identifier`, `extends_clause` and `implements_clause`. These don't exist in the **JavaScript** grammar, so JS files get no classes.
3. `.tsx` files are parsed with `tree-sitter-typescript.wasm`. They must use `tree-sitter-tsx.wasm`, which is already shipped in `tree-sitter-wasms`. Otherwise JSX becomes ERROR nodes and can swallow later declarations.
4. A bare `(arrow_function) @fn_decl` pattern has no name capture.

Decisions that apply here (final):
- D2: stay on tree-sitter WASM (`web-tree-sitter` 0.20.8). No TS compiler API.
- D4: IDs are `kind:<absPath>#<symbol>` via `makeNodeId`. Methods use kind `method` with symbol `<Class>.<name>` (for example `method:/abs/a.ts#UserService.find`). Object-literal methods on a top-level `const` use `<objVar>.<key>`. Getters and setters share the method ID. If both exist, keep one node and set `meta.accessor: "get"|"set"|"both"`.
- D5: type aliases → kind `type`, `meta.subkind: "alias"`. Enums → kind `type`, `meta.subkind: "enum"`. `namespace X {}` / `module X {}` / `declare module 'x'` → kind `module`. No new `NodeKind` values.
- D12: report compile errors with `warnOnce('parser', 'ts:<QUERY>', ...)`. No empty catches.
- `language` stays `'typescript'` or `'javascript'` (`SupportedLanguage` is unchanged). TSX is only an internal **grammar key**.
- Scope of nodes: **top-level declarations and class members only**. Nested functions inside function bodies are not nodes. Slice 05 attributes their calls to the enclosing top-level symbol.

Edge contract after this slice:
- `contains`: from file to each top-level symbol, and from class to each of its methods.
- `exports`: from file to symbol, **only** when the declaration is exported. That covers `export ...`, `export default ...` and `export { a, b }` naming a local declaration. In JS it also covers `module.exports = X`, `module.exports = { a, b }` and `exports.a = ...`. Today every symbol gets an `exports` edge whether or not it is exported. Fix that.
- `inherits` / `implements`: emit the edge only when the parent is declared **in the same file**. Always record heritage in meta as `meta.heritage = { extends: string[], implements: string[] }`, using bare names with generic args stripped (`I2<X>` → `I2`). Slice 05 resolves cross-file parents from this. Interface `extends` produces `inherits` edges interface→interface, with the same same-file rule.
- Keep import extraction as it is (slice 04 rewrites it).
- Overloads: `function_signature` siblings collapse into the implementation node, so the ID is deduplicated.

Grammar facts. Verify each one by dumping `tree.rootNode.toString()` for your fixtures **before** writing queries, and fix this list if it is wrong:
- TS `class_declaration name: (type_identifier)`. TS also has `abstract_class_declaration`.
- TS `class_heritage` → `extends_clause (value: _)` and `implements_clause (type_identifier | generic_type ...)`.
- JS `class_declaration name: (identifier)`, and `class_heritage` holds the extends expression directly.
- `method_definition name: (property_identifier | private_property_identifier | computed_property_name | string)`. Skip computed names.
- TS `abstract_method_signature`, `type_alias_declaration`, `enum_declaration`, `internal_module` / `module`.
- Exported default anonymous function: `export_statement (function_expression | arrow_function | class)`. Name it `default`.

Engine change: allow a grammar key `'tsx'` mapped to `tree-sitter-tsx.wasm`, for example `parse(source, grammar: SupportedLanguage | 'tsx')` and `loadLanguage(grammar)`. Cache per key. The adapter picks `tsx` when `filePath` ends in `.tsx`. `.jsx` stays on the JS grammar, which supports JSX.

Implementation guidance:
- Compile each query pattern **separately** (an array of small queries), so one bad pattern can't kill the others.
- Prefer one walk over top-level `program` children with a small dispatcher (export_statement → unwrap → declaration) over giant alternation queries. Either approach is acceptable if the tests pass.
- Keep the `description` text style used today ("Class X. " plus a short source excerpt). Slice 08 adds signature, doc and line metadata, so don't add `startLine` and similar fields here.

## Tasks
1. Add the `tsx` grammar key to `tree-sitter-engine.ts`.
2. Rewrite extraction in `typescript.ts` to satisfy the contract above for both the TS and JS grammars.
3. Write `src/parser/__tests__/typescript.test.ts` using `parseSnippet`. It needs these cases (each one its own `it`):
   - function declarations, `export function`, and `export default function`
   - `const f = () => {}`, `const g = function () {}`, and `export const h = async () => {}`
   - class methods: normal, `static`, `get`/`set`, `constructor`, `#private`, and `abstract`
   - abstract class
   - interface extends
   - type alias, enum, and namespace
   - object-literal methods (`const api = { get() {}, post: () => {} }`)
   - overloads collapse to one node
   - `.tsx` component (`export function Button() { return <div/> }`) followed by a class declared after the JSX, with **both** extracted
   - JS file with a class that extends another class, plus `module.exports`
   - `exports` edges only for exported symbols
   - same-file `inherits`/`implements` edges; for a cross-file parent, no edge, but `meta.heritage` is filled
   - `implements I1, I2<X>` captures both names
4. Create `docs/languages/typescript.md`, the extraction contract: node kinds and ID formats with examples, the edge rules above, what is intentionally not extracted, and the file extension → grammar table. Leave headed placeholder sections "Imports & resolution (slice 04)", "Calls (slice 05)" and "Metadata (slice 08)".
5. Sanity-check on this repo: `npm run build && node dist/cli/index.js init -r . && node dist/cli/index.js stats -r .` (check the CLI help for flags). Function and method counts must be > 0. Paste the counts in your report.

## Out of scope
- Import resolution changes (04), call edges or cross-file resolution (05), line, signature or doc metadata (08).
- Editing `utils.ts`, `types.ts`, `parser/index.ts` or `db.ts`.

## Done when
```
npx tsc --noEmit
npx jest src/parser/__tests__/typescript.test.ts
npx jest
npm run build
```
All pass. `CGB_DEBUG=1` init on this repo prints no `ts:` query warnings, and the stats show function and method nodes.

## Finish
1. Tick `- [x] 03` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `fix(slice-03): TS/JS/TSX function, method and type extraction`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: node counts by kind for this repo, before and after, and any grammar facts above that turned out to be wrong.
