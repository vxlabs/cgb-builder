# Slice 04: TS import resolution (re-exports, tsconfig paths, scoped packages)

## Goal
Resolve TS/JS imports the way real projects write them, so `imports` edges point at the right files and slice 05 can resolve calls through imported bindings. Today the adapter has several problems:
- `@scope/pkg` is stored as `@scope`.
- `@/x` and tsconfig `paths` aliases are treated as external packages.
- `export * from` / `export { a } from` (barrels) and dynamic `import('x')` are ignored.
- `.mts`/`.cts` files are never tried.

## Prerequisites
- 03: the TS adapter was rewritten. Read its current state; don't assume the old code.

## Files touched
- `src/parser/adapters/typescript.ts` (import section only)
- `src/parser/ts-config.ts` (new)
- `src/parser/__tests__/ts-imports.test.ts` (new)
- `docs/languages/typescript.md` (fill in the "Imports & resolution" section)

## Suggested model
Sonnet

## Read only these files
- `src/parser/adapters/typescript.ts`
- `src/parser/utils.ts` (read only)
- `src/parser/__tests__/helpers.ts`
- `docs/languages/typescript.md`

## Background
Decisions (final): D2 tree-sitter only, D4 ID format `kind:<absPath>#<symbol>`, D12 stderr logging via `src/util/log.ts` (`debug`, `warnOnce`).

Import forms to capture:
- `import x from 's'`, `import { a as b } from 's'`, `import * as ns from 's'`, `import 's'`, `import type ...`. Type-only imports still produce file edges, marked `typeOnly: true` in bindings.
- `export * from 's'`, `export * as ns from 's'`, `export { a, b as c } from 's'`
- `import('s')` with a string literal argument only
- `require('s')`, including `const { a } = require('s')` and `const x = require('s')`

Classification of a specifier `s`, in order:
1. Starts with `.` → relative. Resolve against the importing file's dir.
2. Matches a tsconfig/jsconfig `compilerOptions.paths` pattern → try each mapped target, relative to `baseUrl`, or to the tsconfig dir if there is no baseUrl.
3. `baseUrl` is set and `<baseUrl>/<s>` resolves to a file → local.
4. Otherwise external. The package name is `@a/b` for scoped specifiers (first two segments) and the first segment otherwise. `node:fs` and bare Node builtins (`fs`, `path`, ...) map to external `node:<name>`.

File resolution for a candidate base path:
- Strip any `.js/.jsx/.mjs/.cjs` extension first, because TS sources import compiled names.
- Try `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`.
- Then try `<base>/index.<same list>`.
- Skip `.d.ts` (the parser ignores it). The first existing file wins.

`src/parser/ts-config.ts` contract:
```ts
export interface TsPathConfig { configDir: string; baseUrl?: string; paths: Record<string, string[]> }
/** Nearest tsconfig.json or jsconfig.json walking up from `fromDir`; follows relative `extends`; JSONC-tolerant (comments, trailing commas); cached per directory. Returns null if none. */
export function findTsPathConfig(fromDir: string): TsPathConfig | null;
/** Apply `paths` (single `*` wildcard, most specific pattern first) → candidate absolute base paths (unresolved). */
export function expandPathAlias(cfg: TsPathConfig, specifier: string): string[];
export function clearTsConfigCache(): void; // for tests
```
Package `extends` (for example `@tsconfig/node20`) is ignored with a `debug` log.

**Binding contract.** Slice 05 consumes this exactly, so don't rename it. The file node's `meta` (a JSON string) gets:
```ts
imports: Array<{ source: string;      // resolved absolute file path, or package name if external
                 isExternal: boolean;
                 local: string;       // local binding name ('' for side-effect import)
                 imported: string;    // 'default' | '*' | exported name
                 typeOnly?: boolean; dynamic?: boolean }>;
reexports: Array<{ source: string; isExternal: boolean;
                   imported: string;  // name or '*'
                   exported: string }>; // name as re-exported ('*' for export *)
```
Edges stay as they are today:
- an `imports` edge file→file for local targets
- file→`external_dep:<pkg>` for externals, creating the external node as now
- re-exports also produce an `imports` edge, with reason `"re-export"`

## Tasks
1. Implement `ts-config.ts` with tests: temp-dir fixtures under `os.tmpdir()`, `extends` chains, JSONC, `paths` with `@/*` and `~lib/*`, no config found.
2. Rewrite the import extraction in `typescript.ts` for all the forms above and the classification and resolution rules. Populate `meta.imports` / `meta.reexports` on the file node.
3. Write `ts-imports.test.ts`. Use a real temp directory, because resolution checks file existence:
   - relative import with a `.js` suffix resolving to `.ts`
   - directory → `index.ts`
   - `.mts`
   - `@/utils/x` via `paths`
   - baseUrl bare import
   - `@scope/pkg/sub` → external `@scope/pkg`
   - `node:fs` and `fs` → `node:fs`
   - `export * from './a'` and `export { x as y } from './b'` in `meta.reexports`
   - dynamic `import('./lazy')`
   - `const { a } = require('./c')` binding
   - type-only import flagged
4. Fill in the "Imports & resolution" section of `docs/languages/typescript.md`: rules, the binding contract above, and known limits (no workspace package resolution, no `exports` field of package.json).

## Out of scope
- Call edges or cross-file symbol resolution (05).
- Monorepo workspace package → source mapping (record it under "known limits").
- Editing files outside the list above.

## Done when
```
npx tsc --noEmit
npx jest src/parser
npx jest
npm run build
```
All pass. On this repo, `node dist/cli/index.js init -r .` (then stats) shows no `external_dep` nodes named `@` or starting with `.`.

## Finish
1. Tick `- [x] 04` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-04): TS re-exports, tsconfig paths, scoped package imports`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, the external_dep list for this repo, and any deviations from the binding contract (there should be none).
