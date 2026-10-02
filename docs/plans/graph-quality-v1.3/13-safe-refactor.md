# Slice 13: Safe refactor apply, and dead code via `exported`

## Goal
Make rename preview and apply safe and useful, and make dead-code detection report real results for TS. Today:
- `line` is always null, so apply runs a whole-file regex that also rewrites strings, comments and unrelated symbols.
- Only `exports` edges were considered, so calling files were never edited.
- The graph isn't re-parsed afterwards.
- The path check is a plain `startsWith`.
- TS functions always had an incoming `exports` edge, so they never showed up as dead.

## Prerequisites
- 12: track C order and `docs/FEATURES.md` ownership.
- Transitively 08: TS line ranges and `exported`. Slice 05 provides `calls` edges.

## Files touched
- `src/refactor/index.ts`
- `src/refactor/__tests__/refactor.test.ts` (new)
- `docs/FEATURES.md`: the "Refactoring" section

## Suggested model
Sonnet

## Read only these files
- `src/refactor/index.ts` (whole file, about 360 lines)
- `src/types.ts` `GraphNode` (read only)
- `src/graph/db.ts` public signatures (read only)
- `src/parser/index.ts`: the `Parser` class constructor and `parseFiles` signature (read only, for re-parse after apply)
- `docs/FEATURES.md`

## Background
- Edges available: `calls` (caller → callee, slice 05), `imports` (file → file), `contains` (file → symbol, class → method), `exports` (file → symbol, **only** for exported symbols), `inherits`, `implements`.
- Node fields: `startLine`/`endLine` (1-based inclusive, may be missing for unupgraded languages), `exported`.

Rename preview algorithm (new):
1. Target node T. Its occurrence sites are:
   - (a) the declaration: the name token inside `T.startLine..endLine`, first match of `\bname\b` on the declaration line(s)
   - (b) for each `calls` edge X→T, lines within X's range that contain `\bname\b`
   - (c) for files with `imports` edges to T's file, the import specifier lines that name T (`import { name` / `name,` / `as name`)
2. Within each candidate line, skip matches inside string literals or comments. Use a small lexer-lite: track `'`, `"`, `` ` `` and `//`, `/* */` on that line. Mark ambiguous lines `confidence: 'low'`.
3. Preview items are `{ file (repo-relative), line, column, before, after, confidence }`, stored in memory with the existing 10-minute expiry. Keep the existing preview ID mechanism.
4. If T has no line range, return the preview with `confidence: 'low'` on every item and a warning. **Never** fall back to whole-file replacement.

Apply:
- Apply only the previewed `(file, line, column)` edits. Before editing, verify that each line's current text still equals `before`. If any line has drifted, abort the whole apply, change nothing, and return the conflicting items.
- Path safety: `const rel = path.relative(root, abs); if (rel.startsWith('..') || path.isAbsolute(rel)) reject`. Also reject paths that resolve, via `fs.realpathSync`, outside the root (symlinks).
- After writing, re-parse the touched files: `await new Parser(db, root).parseFiles(files, true)`. Check the actual constructor signature. Return `{ applied, files, reparsed: true }`.

Dead code (new rule):
- A function, method or class is dead when it has **no incoming `calls`, `inherits` or `implements` edges**, `exported !== true`, and its name isn't `main`, `constructor` or a test (`isTestFile` path).
- Exported symbols with zero callers are reported separately as `unusedExports`, only when no file imports their file. Keep the old return shape and add fields; don't remove any.

## Tasks
1. Implement the preview, apply and dead-code changes above.
2. Write `refactor.test.ts` using temp files, a real `GraphDb` and the `Parser`. Use TS fixtures, which works now that 03/05/08 have landed. Cover:
   - rename of a function used in 2 other files: the declaration, the call sites and the import specifiers change, while a same-named word in a string or comment stays the same
   - drift abort: modify the file between preview and apply, and nothing changes
   - path traversal rejected (`../outside.ts`, a symlink outside the root)
   - preview expiry
   - dead code finds an unexported uncalled function and does not report an exported one
3. Update `docs/FEATURES.md` "Refactoring".

## Out of scope
- MCP schemas and descriptions (15 can expose new fields).
- Multi-language rename beyond what the line ranges support. Others get low-confidence previews.

## Done when
```
npx tsc --noEmit
npx jest src/refactor
npx jest
npm run build
```
All pass.

## Finish
1. Tick `- [x] 13` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `fix(slice-13): range-scoped rename apply with drift check; real dead-code detection`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, and the dead-code result count on this repo.
