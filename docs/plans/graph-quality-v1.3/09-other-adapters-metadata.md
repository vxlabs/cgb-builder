# Slice 09: Other adapters (line ranges, signatures, Python relative imports, query fixes)

## Goal
Bring the non-TS adapters up to a usable baseline:
- every symbol node carries `startLine`/`endLine` and a best-effort `signature`/`doc`
- query bugs surfaced by slices 01/02 are fixed
- Python relative imports (`from .b import x`) resolve to local files instead of becoming `external_dep:b`

## Prerequisites
- 01: query errors are logged with `warnOnce('parser', '<lang>:<QUERY>')`. Its report lists the warnings seen.
- 02: the harness and `it.todo` gap list in `src/parser/__tests__/adapters.test.ts`.
- 07: the `GraphNode` optional fields and `nodeRange`, `oneLine`, `leadingDocComment` in `src/parser/utils.ts`.

## Files touched
- `src/parser/adapters/{csharp,python,go,java,rust,ruby,php,c,kotlin}.ts`, plus any other non-TS adapter in the registry. **Not** `typescript.ts`.
- `src/parser/__tests__/adapters.test.ts`
- `docs/languages/README.md` (the language matrix, owned by track F)

## Suggested model
Sonnet. This is the largest slice. If it runs long, finish csharp, python, go and java first, commit, and leave the rest as a clearly reported remainder.

## Read only these files
- The adapters listed above, one at a time
- `src/parser/utils.ts` (read only), `src/types.ts` `GraphNode` (read only)
- `src/parser/__tests__/adapters.test.ts`, `src/parser/__tests__/helpers.ts`
- `docs/languages/README.md`

## Background
Field contract (slice 07): `startLine?`, `endLine?` (1-based inclusive, via `nodeRange`), `signature?` (`oneLine`, ≤200 chars), `doc?` (`leadingDocComment(n, src, style)` with style `slash` for C#/Go/Rust/Java/Kotlin/C/C++/PHP, `hash` for Ruby, `python` for Python), `exported?`, `modifiers?`.

Rules:
- **Priority 1, all adapters:** set `startLine`/`endLine` on every non-file node, and `1..lastLine` on file nodes.
- **Priority 2:** `signature`, using the declaration header text up to the body start (`{` / `:`), collapsed through `oneLine`.
- **Priority 3:** `doc` and `exported`.
  - Go: capitalised name.
  - Java/C#/Kotlin: a `public` modifier.
  - Python: no leading `_`.
  - Rust: `pub`.
- Python relative imports: `from . import x`, `from .b import y` and `from ..pkg.mod import z` resolve against the importing file's package dir. Try `<path>.py` then `<path>/__init__.py`. A resolved file becomes an `imports` edge file→file. Unresolvable relative imports produce **no** external node; log them with `debug`.
- Node IDs and kinds don't change (D4, D5). Methods keep whatever kind and ID scheme each adapter uses today. Don't rename IDs.
- Logging uses `src/util/log.ts` only (D12).

## Tasks
1. For each adapter: add the metadata, and fix any query that 01 reported as failing to compile.
2. Implement Python relative import resolution.
3. Convert the `it.todo`s in `adapters.test.ts` into real tests where fixed. Add line-range and signature assertions per language. Keep a `todo` for anything still missing.
4. Update the matrix in `docs/languages/README.md`, including a "line ranges" and a "signature" column.

## Out of scope
- `typescript.ts` (track A).
- New call-edge extraction for languages that lack it. Record it as ❌ in the matrix; it's a future slice.
- `utils.ts`, `types.ts`, `db.ts`.

## Done when
```
npx tsc --noEmit
npx jest src/parser
npx jest
npm run build
CGB_DEBUG=1 node dist/cli/index.js init -r <a small multi-language fixture or this repo>
```
All pass. There are no `warnOnce` query-compile warnings for the adapters you finished.

## Finish
1. Tick `- [x] 09` in `docs/plans/graph-quality-v1.3/00-README.md`. If it's partial, write `- [~] 09 (done: csharp, python, ...)`.
2. Commit only the files above plus that README: `feat(slice-09): line ranges, signatures and Python relative imports for non-TS adapters`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: per-language status, test count, and the remaining todos.
