# TypeScript / JavaScript extraction contract

Adapter: `src/parser/adapters/typescript.ts` (web-tree-sitter 0.20.8 WASM; no TS compiler API).

## Extension -> grammar

| Extension | `language` | Grammar key | WASM |
|-----------|-----------|-------------|------|
| `.ts` | `typescript` | `typescript` | `tree-sitter-typescript.wasm` |
| `.tsx` | `typescript` | `tsx` (internal only) | `tree-sitter-tsx.wasm` |
| `.js` `.mjs` `.cjs` | `javascript` | `javascript` | `tree-sitter-javascript.wasm` |
| `.jsx` | `javascript` | `javascript` (supports JSX) | `tree-sitter-javascript.wasm` |

## Node kinds and IDs

IDs are `kind:<absPath>#<symbol>` (`makeNodeId`). Only **top-level declarations and class members** become nodes.

| Source | kind | symbol | example id | meta |
|--------|------|--------|------------|------|
| `function f`, `const f = () => {}`, `const f = function(){}` | `function` | `f` | `function:/abs/a.ts#f` | `{}` |
| `export default function () {}` (anonymous) | `function` | `default` | `function:/abs/a.ts#default` | |
| `class C`, `abstract class C`, `const C = class {}` | `class` | `C` | `class:/abs/a.ts#C` | `visibility`, `heritage`, `abstract?` |
| class method, accessor, ctor, `#private`, abstract, arrow/function-valued field | `method` | `C.name` | `method:/abs/a.ts#UserService.find` | `accessor?` (`get`/`set`/`both`), `abstract?`, `static?` |
| `const api = { get() {}, post: () => {} }` | `method` | `api.get` | `method:/abs/a.ts#api.get` | `objectLiteral: true` |
| `interface I` | `interface` | `I` | `interface:/abs/a.ts#I` | `heritage` |
| `type T = ...` | `type` | `T` | `type:/abs/a.ts#T` | `subkind: "alias"` |
| `enum E` | `type` | `E` | `type:/abs/a.ts#E` | `subkind: "enum"` |
| `namespace N`, `module M`, `declare module 'x'` | `module` | `N` / `x` | `module:/abs/a.ts#N` | `{}` |

Getter and setter share one method node (`meta.accessor: "both"` when both exist). Overload signatures
(`function_signature`, `method_signature`) collapse into the one node. Computed method names are skipped.
`meta.heritage = { extends: string[], implements: string[] }` holds bare names (generic args stripped).

## Edges

- `contains`: file -> each top-level symbol (including object-literal methods); class -> each of its methods.
- `exports`: file -> symbol, **only when exported**: `export ...`, `export default ...`, `export { a, b }` naming a local
  declaration. JS also: `module.exports = X`, `module.exports = { a, b }`, `exports.a = ...`, `module.exports.a = ...`.
  Anonymous `export default function/class` and `module.exports = function` produce a symbol named `default`.
- `inherits`: class -> class and interface -> interface, **only when the parent is declared in the same file**.
- `implements`: class -> interface, same-file only.
- Cross-file parents get no edge; they are available in `meta.heritage` for later resolution.
- `imports`: see "Imports & resolution".

## Intentionally not extracted

- Nested functions / classes inside function bodies, and the contents of `namespace` bodies (calls inside them belong to the enclosing top-level symbol).
- Interface members, type members, enum members, plain (non-function) variables and class fields.
- Re-exports create no symbol nodes (they are recorded in `meta.reexports` and an `imports` edge).
- Computed method names (`[sym]() {}`).

## Imports & resolution (slice 04)

Forms captured (tree walk, any depth): `import` (default / named / namespace / side-effect / `import type`),
`export * from`, `export * as ns from`, `export { a, b as c } from`, `import('s')` and `require('s')` with a string
literal argument (also `const x = require(..)`, `const { a, b: c } = require(..)`, `await import(..)`).

Specifier classification, in order:
1. Starts with `.`: relative to the importing file's directory.
2. Matches a `compilerOptions.paths` pattern of the nearest tsconfig.json / jsconfig.json: each mapped target is tried
   (relative to `baseUrl`, else to the config dir). If the alias matches but no file exists, the import is dropped (no node, no edge).
3. `baseUrl` set and `<baseUrl>/<s>` is a file: local.
4. Otherwise external. Package name is `@a/b` for scoped specifiers, the first segment otherwise. `node:fs`, `fs`, `fs/promises`
   map to external `node:fs`. Malformed names such as `@` or `@/x` are dropped.

File resolution of a base path: strip `.js/.jsx/.mjs/.cjs`, try `.ts .tsx .mts .cts .js .jsx .mjs .cjs`, then
`<base>/index.<same list>`; finally the path as written if it exists (e.g. `.json`). `.d.ts` is never chosen. An unresolved
relative import keeps the stripped path (edge to a file node that may not exist).

Config discovery (`src/parser/ts-config.ts`): `findTsPathConfig(dir)` walks up for tsconfig.json then jsconfig.json, follows
relative `extends` (string or array), tolerates JSONC, caches per directory. Package `extends` is ignored (debug log).
`expandPathAlias(cfg, spec)` applies the most specific matching pattern (single `*`) and returns absolute candidate base paths.

Edges: `imports` file -> file (local) or file -> `external_dep:<pkg>`; reason `imports <spec>`, `dynamically imports <spec>`
or `re-export <spec>`. One edge per target (first reason wins).

File node `meta` (JSON):
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
Notes: `import * as ns` -> `imported: '*'`; `import 's'` -> `local: ''`, `imported: '*'`; `const x = require('s')` and
`await import('s')` bind `local: x, imported: '*'`; destructuring binds each name (`{ b: bb }` -> `local: bb, imported: b`).
`export type { T } from` is a normal re-export. Re-exports do not create bindings in `imports`.

Known limits: no monorepo workspace package -> source mapping, no `exports` field of package.json, no `typesVersions`,
non-literal `require(x)` / `import(x)` ignored, `require` inside conditionals still counts, package `extends` ignored.

## Calls (slice 05)

The adapter emits `SymbolRef`s (`calls`, and `inherits`/`implements` for parents not defined in the same file). The
post-parse `Linker` (`src/parser/linker.ts`) resolves them after each batch, writes the edges, and prunes dangling edges.

Attribution: a call is attributed to the enclosing top-level symbol (function, `const` arrow, class method, object-literal
method `obj.key`, class field initialiser -> its method or class). Nested functions count toward the enclosing top-level
symbol. Module-level calls are attributed to the file node. Duplicate calls to the same callee are one edge; `reason` is
`call`, `new`, or `call via <binding>` / `new via <binding>` / `call via this|super`.

Extracted forms: `f()`, `this.m()`, `super.m()`, `a.b()` (name `b`, qualifier `a`), `a.b.c()` (name `c`, qualifier `a.b`),
`new X()`, `a?.b()`. `require(...)`, `import(...)` and `super(...)` are not call refs.

Resolution order (heuristic, no type checker):
1. Bare `f()` / `new X()`: top-level function/class `f` in the same file.
2. Bare call matching an import binding: locate `imported` in the source file; if absent, follow the source's re-exports
   one level (named, or `export *`). `default` matches a symbol named `default` (anonymous default export), then a symbol
   named like the local binding, then the file's only exported function/class.
3. `ns.f()` where `ns` is a namespace import (or `require` result): locate `f` in the source. `ns.Class.m()` resolves to
   `Class.m`. `Cls.m()` / `obj.m()` where `Cls`/`obj` is a same-file or imported class or object literal resolves to
   `method:<file>#Cls.m`.
4. `this.m()` / `super.m()`: method on the enclosing class, then up the resolved `extends` chain (same file or imported,
   up to 5 levels, cross-file included). `super.m()` skips the enclosing class.
5. Otherwise unresolved: nothing is written, the caller node gets `meta.unresolvedCalls` (number) and
   `meta.unresolvedSample` (first 20 names, `qualifier.name`).

Heritage: `extends`/`implements` names are resolved through same-file symbols, import bindings (one barrel level) and
`ns.Name` namespace imports; external parents resolve to nothing.

Limits:
- `obj.method()` on arbitrary objects/instances (`repo.find()`) is unresolved; there is no type information.
- Named default exports (`export default function foo`) are not marked as default: `import x from` resolves only when the
  local name matches, the symbol is anonymous (`default`), or it is the file's single exported function/class.
- Incremental: refs live only for the batch. When file A is re-parsed, edges from unchanged file B into A's symbols
  survive while the symbol id still exists and are pruned if it is gone. A symbol newly added to A that B already calls
  by name is not linked until B is re-parsed. Deleted files (`scanAll` removes DB files no longer discovered,
  `removeFile`) lose their nodes and outgoing edges, and incoming edges are pruned.
- Shadowed names (a local variable named like an import) are not detected.

## Metadata (slice 08)

Every TS/JS/TSX node gets `startLine`/`endLine` (1-based, inclusive), `signature`, `doc`, `exported` and `modifiers`.

- **Range**: the whole declaration, including `export`/`declare` and decorators (class members: the decorators above them). A `const f = () => {}` with a single declarator spans the full `const` statement. Overloads, declaration merges and getter+setter pairs widen one node's range. The file node is `1..lastLine`.
- **Signature** (one line, whitespace collapsed, at most 200 chars):
  - function / method: `[modifiers ]name<T>(params): Ret`, e.g. `async find(id: string): Promise<User | null>`, `private static async load(x: number): Promise<void>`, `get size(): number`
  - arrow / function-expression const: `const name = async (x: number): Promise<void> =>`
  - object-literal member: `get(id)` or `post: (x) =>`
  - class: `abstract class Repo<T> extends Base<T> implements I1, I2`
  - interface: `interface Box<T> extends A, B`
  - type alias: `type Pair<A> = { first: A; second: A }` (RHS cut at 120 chars); enum: `enum Color { Red, Green }`
  - namespace: `namespace NS`
- **Doc**: first paragraph of the JSDoc directly above the declaration (above the `export` keyword when present), stopping at a blank line or `@tag`. Falls back to consecutive `//` comments. When present it also becomes `description`.
- **Exported**: `true` exactly when the node has an `exports` edge (including `export { a }`, `export default a`, CommonJS); class members are `false`.
- **Modifiers**: `public|private|protected`, `static`, `async`, `abstract`, `readonly`, `generator`, `getter`, `setter`, `default`. Default-exported symbols also get `meta.isDefault = true`.
