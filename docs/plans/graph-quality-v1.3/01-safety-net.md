# Slice 01: Safety net (logger, no silent catches, safe git exec)

## Goal
Make parser and query failures visible, and remove a shell-injection risk. Today every adapter wraps its tree-sitter query in `try { ... } catch {}`, so a broken query (like the TS `FUNCTION_QUERY`) silently produces no nodes. Also, `src/git/diff.ts` builds `git diff ${base}..HEAD` by string interpolation, and `base` comes from MCP input.

## Prerequisites
None. This is wave 1, alongside 02 and 06.

## Files touched
- `src/util/log.ts` (new)
- `src/util/__tests__/log.test.ts` (new)
- `src/parser/adapters/*.ts`: **only** the `catch` blocks around query compile/exec. No other edits.
- `src/git/diff.ts`
- `src/git/__tests__/diff.test.ts` (new)

## Suggested model
Sonnet

## Read only these files
- `src/parser/adapters/typescript.ts` (to see the catch pattern, around lines 180, 259, 301, 347)
- `src/parser/adapters/csharp.ts` (second example)
- `src/git/diff.ts`
- `src/git/__tests__/changes.test.ts` (test style)
- `jest.config.json`

## Background
- Decision D12: diagnostics go to **stderr only**, because stdout is the MCP JSON-RPC stdio channel and anything written there corrupts the protocol. Output is gated by the env var `CGB_DEBUG=1`. Empty `catch {}` is banned in touched code.
- The project is ESM-style TS that imports with `.js` suffixes (for example `import { x } from '../util/log.js'`). Jest maps `.js` → TS via `moduleNameMapper`.
- Logger API contract, which later slices import as-is:
  ```ts
  // src/util/log.ts
  export function debug(scope: string, msg: string, err?: unknown): void;   // only if CGB_DEBUG
  export function warnOnce(scope: string, key: string, msg: string, err?: unknown): void; // once per key per process, always to stderr
  export function isDebug(): boolean;
  ```
  Format: `[cgb:<scope>] <msg>` plus `: <err.message>` when an error is given. In debug mode, append the stack.
- Query-compile errors are programmer bugs, so report them with `warnOnce('parser', '<lang>:<QUERY_NAME>', ...)`. Per-file runtime errors use `debug`.
- In `diff.ts`, use `execFileSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 64*1024*1024 })` everywhere. Validate refs with `/^[A-Za-z0-9._\/~^@{}-]+$/` and reject anything starting with `-`. Throw `Error('Invalid git ref: ...')`.

## Tasks
1. Create `src/util/log.ts` with the API above, plus unit tests that check stderr output via a `jest.spyOn(process.stderr, 'write')` spy, the CGB_DEBUG gating, and warnOnce dedupe.
2. In every adapter under `src/parser/adapters/`, replace each empty or silent `catch` around `language.query(...)` / `query.matches(...)` / `query.captures(...)` with a `warnOnce` (compile) or `debug` (runtime) call. **Do not fix the queries themselves.** That is slice 03 (TS) and 09 (others).
3. Rewrite every git invocation in `src/git/diff.ts` to use `execFileSync` with an argument array and ref validation. Keep the exported function signatures identical.
4. Add `src/git/__tests__/diff.test.ts` covering ref validation (accepts `main`, `HEAD~3`, `origin/feature-x`, `v1.2.0`; rejects `main; rm -rf /`, `--output=x`, `$(id)`).
5. Run a quick manual check: `CGB_DEBUG=1 node dist/cli/index.js init -r .` after building. You should now **see** the TS `FUNCTION_QUERY` compile warning on stderr. Note it in your report (it proves the safety net works).

## Out of scope
- Fixing any tree-sitter query (slices 03, 09).
- Catch blocks in `db.ts`, `communities/`, `embed/` (slices 06, 11, 10 own those files).
- Lint cleanup (slice 18).

## Done when
```
npx tsc --noEmit
npx jest
npm run build
npx jest src/util src/git
```
All pass. The test count is ≥ 53 plus the new tests. `grep -rn "catch {}" src/parser/adapters src/git` returns nothing.

## Finish
1. Tick `- [x] 01` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `fix(slice-01): stderr logger, surface parser query errors, safe git exec`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: files changed, the test count, and the stderr warnings seen during the manual init (list them; slices 03 and 09 need them).
