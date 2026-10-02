# Slice 02: Adapter test harness (non-TS languages)

## Goal
There are no parser tests today. That is why a broken TS query and a broken Louvain import shipped unnoticed. This slice builds a reusable harness for testing adapters on inline source snippets, adds smoke tests for every **non-TypeScript** adapter, and records the current extraction matrix.

## Prerequisites
None. This is wave 1, alongside 01 and 06.

## Files touched
- `src/parser/__tests__/helpers.ts` (new; not a test file, since jest only matches `*.test.ts`)
- `src/parser/__tests__/adapters.test.ts` (new; non-TS languages only)
- `docs/languages/README.md` (new; the language support matrix, owned by track F)

## Suggested model
Sonnet

## Read only these files
- `src/parser/adapter.ts`
- `src/parser/index.ts` (adapter registry, around lines 20-40)
- `src/parser/tree-sitter-engine.ts`
- `src/parser/utils.ts`
- `src/types.ts` (lines 1-110)
- One or two adapters to learn the shape, e.g. `src/parser/adapters/python.ts` and `src/parser/adapters/go.ts`. Open the others only to find each class name and constructor.
- `src/graph/__tests__/engine.test.ts` (test style)

## Background
- Adapters implement `parse(filePath: string, source: string): Promise<ParsedFile>`, where `ParsedFile = { filePath, language, nodes, edges }`. Parsing is pure (no DB), so tests can call adapters directly with a fake absolute path such as `path.resolve('/fixture/src/a.py')`.
- Node IDs: `kind:<absPath>#<symbol>` (`makeNodeId` in `src/parser/utils.ts`). Edge IDs: `from|kind|to`.
- tree-sitter is WASM (`web-tree-sitter` 0.20.8) and initialised lazily by `treeSitterEngine`. First init can take about 1 s, so set `jest.setTimeout(30000)` in the test file.
- Slice 03 will add `src/parser/__tests__/typescript.test.ts` using this harness. **Do not write TS/JS tests here.**
- Slice 09 will fix gaps in non-TS adapters and convert your `it.todo`s into real tests.
- Track F owns `docs/languages/README.md`. Slice 03 creates `docs/languages/typescript.md` separately. Link to it from the matrix, but don't create it.

## Tasks
1. Write `helpers.ts`:
   ```ts
   export interface ParsedView { nodes; edges; kinds: Record<string, number>; ids: Set<string>;
     node(kind: string, symbol?: string): GraphNode-like | undefined;
     edgesOf(kind: EdgeKind): Array<{ from: string; to: string }>; }
   export async function parseSnippet(adapter: LanguageAdapter, relPath: string, source: string): Promise<ParsedView>;
   export const FIXTURE_ROOT: string; // path.resolve('/cgb-fixture')
   ```
2. For each non-TS adapter (csharp, python, go, java, rust, ruby, php, c, cpp, kotlin; check the registry for the actual set), write a `describe` block with a realistic 15-30 line snippet: a class/struct with 2 methods, a free function, a call between functions, and one local plus one external import. Assert what works **today** (node kinds present, import edges, inheritance).
3. For anything expected but missing (no functions, no calls, Python relative import becoming `external_dep`, and so on), add `it.todo('<lang>: <gap description>')` so the gaps are explicit.
4. Create `docs/languages/README.md`. It holds a matrix with rows per language and columns: classes, functions, methods, calls, imports-local, imports-external, inherits/implements, line ranges. Cells are ✅ / ⚠️ partial / ❌, filled from your test results. TS/JS rows say "see typescript.md (slice 03)".

## Out of scope
- Changing any adapter code, even when you find bugs. Record them as `it.todo` and in the matrix.
- TS/JS tests (slice 03).

## Done when
```
npx tsc --noEmit
npx jest src/parser
npx jest
```
All pass, and there is at least one passing `it` per non-TS adapter. The report lists every `it.todo`.

## Finish
1. Tick `- [x] 02` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `test(slice-02): adapter test harness and language matrix`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, and the list of `it.todo` gaps per language (slice 09's input).
