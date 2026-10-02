# Slice 18: Lint/format baseline and CI

## Goal
Get `npm run lint` and `npm run format:check` to zero errors, then make CI enforce them. Today `eslint src` reports about 6.9k errors, mostly prettier and line-ending noise. CI ignores lint (`|| true`) and tests Node 18, even though `engines` requires Node >= 20.

## Prerequisites
All code slices 01–17 must be merged. This slice reformats almost every file in `src/`, so **nothing else may be in flight**. Slice 19 can run in parallel, because it only touches docs, manifests and the `package.json` version, not `src/`.

## Files touched
- Every `src/**/*.ts`: formatting and autofixable lint only
- `.eslintrc.json`, `.prettierrc`, `.prettierignore`
- `.gitattributes` (new)
- `.github/workflows/ci.yml`

## Suggested model
Sonnet (mechanical, but needs judgment on remaining non-autofixable errors)

## Read only these files
- `.eslintrc.json`, `.prettierrc`, `.prettierignore`, `.github/workflows/ci.yml`, `package.json` (scripts only, read only)
- the output of `npx eslint src --ext .ts -f unix | head -200` and `npx prettier --check "src/**/*.ts" | head`

## Background
- D13: lint cleanup happens only here.
- The repo is developed on Windows, and most errors are probably `prettier/prettier` CRLF (`Delete ␍`). Decide on line endings **once**: set `"endOfLine": "lf"` in `.prettierrc` and add `.gitattributes` with `* text=auto eol=lf`. Then `git add --renormalize .`.
- **No behaviour changes.** For non-autofixable rules (for example `no-explicit-any`, `no-unused-vars`):
  - Fix trivially safe cases: an unused import, an unused variable prefixed with `_`.
  - Otherwise prefer a targeted `// eslint-disable-next-line <rule> -- reason`.
  - Don't relax rules globally, except where a rule is plainly incompatible with the codebase. Document any such change in the commit body.
- CI target: Node `20.x` and `22.x` on `ubuntu-latest` and `windows-latest`. Steps:
  - `npm ci`
  - `npx tsc --noEmit`
  - `npm run lint -- --max-warnings 0`
  - `npm run format:check`
  - `npm run build`
  - `npm test`
- better-sqlite3 (slice 06) is a native module, and prebuilds cover these Node/OS combinations.

## Tasks
1. Add `.gitattributes`, set prettier `endOfLine`, renormalize, then run `npm run format` and `npm run lint:fix`.
2. Fix or annotate the remaining lint errors until `npm run lint -- --max-warnings 0` passes.
3. Update `ci.yml` as described.
4. Run the full test suite. Formatting must not change behaviour.

## Out of scope
- Any refactor or logic change, and docs.

## Done when
```
npx tsc --noEmit
npm run lint -- --max-warnings 0
npm run format:check
npx jest
npm run build
```
All pass, and `git diff --stat` shows only formatting and lint-related changes. Spot-check 5 files.

## Finish
1. Tick `- [x] 18` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit as **two** commits:
   - `chore(slice-18): normalize line endings and prettier format` (pure formatting)
   - `chore(slice-18): fix lint errors and enforce lint/format in CI`

   End each message with the Co-Authored-By trailer your harness specifies.
3. Report: the error count before and after, any rules changed, and the number of disable comments added.
