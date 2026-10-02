# Slice 08: TS metadata population

## Goal
Fill the schema-v2 fields (`startLine`, `endLine`, `signature`, `doc`, `exported`, `modifiers`) for every TS/JS/TSX node, so MCP tools can return "`find(id: string): Promise<User>` at `src/users.ts:42-58`" and Claude can read just that range.

## Prerequisites
- 05: the TS adapter and linker are final for structure.
- 07: `GraphNode` has the optional fields, and `nodeRange`, `oneLine`, `leadingDocComment` exist in `src/parser/utils.ts`.

## Files touched
- `src/parser/adapters/typescript.ts`
- `src/parser/__tests__/typescript.test.ts`: add a metadata `describe` block
- `docs/languages/typescript.md`: fill in the "Metadata" section

## Suggested model
Sonnet

## Read only these files
- `src/parser/adapters/typescript.ts`
- `src/parser/utils.ts` (read only)
- `src/types.ts`, the `GraphNode` part (read only)
- `src/parser/__tests__/typescript.test.ts`, `src/parser/__tests__/helpers.ts`
- `docs/languages/typescript.md`

## Background
Field contract (from slice 07). Every field is optional:
```ts
startLine?: number; endLine?: number;  // 1-based inclusive; use nodeRange(declNode)
signature?: string;  // oneLine(), ≤200 chars
doc?: string;        // leadingDocComment(node, source, 'jsdoc') — falls back to 'slash'
exported?: boolean;
modifiers?: string[]; // async, static, abstract, private, protected, public, readonly, default, generator, getter, setter
```
Rules:
- **Range**: covers the full declaration, including the `export` keyword when present (the `export_statement` node), and including decorators for classes and methods. File nodes get `startLine: 1` and `endLine` = the last line.
- **Signature by kind**:
  - function / method: `[modifiers ]name[<T>](params)[: ReturnType]`, with params text as written and whitespace collapsed. For example: `async find(id: string): Promise<User | null>`.
  - arrow or function-expression const: `const name = [async ](params)[: R] =>`
  - class: `class Name<T> extends Base implements I1, I2`, with `abstract ` prefixed when it applies
  - interface: `interface Name<T> extends A, B`
  - type alias: `type Name<T> = <first 120 chars of RHS>`
  - enum: `enum Name { A, B, C }`, truncated
  - module: `namespace Name`
- **Doc**: JSDoc first paragraph. For an exported declaration, look above the `export_statement`.
- **Exported**: true when the node has an `exports` edge from 03's rules. Keep the edge as well.
- **Modifiers**: from tree-sitter tokens (`accessibility_modifier`, `static`, `async`, `abstract`, `readonly`, `*` generator, `get`/`set`), plus `default` for `export default`.
- Also make `description` more useful when there is a doc: `description = doc ?? <existing style>`.

## Tasks
1. Populate all the fields for every node kind the adapter emits.
2. Add tests:
   - line ranges for a function, a method inside a class, and a decorated class
   - signature strings for each kind
   - JSDoc on an exported function
   - `//` comment fallback
   - modifiers for an `private static async` method, a getter and an abstract method
   - `exported` true/false
   - the file node range
3. Fill in the "Metadata" section of `docs/languages/typescript.md` with the rules above and examples.

## Out of scope
- Other adapters (09).
- Consumers of the metadata, such as bundle, refactor and MCP (12, 13, 14, 15).

## Done when
```
npx tsc --noEmit
npx jest src/parser
npx jest
npm run build
```
All pass. After `node dist/cli/index.js init -r .`, a raw query `select name,start_line,end_line,signature from nodes where kind in ('function','method') limit 10` on `.cgb/graph.db` shows filled values.

## Finish
1. Tick `- [x] 08` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-08): TS line ranges, signatures, JSDoc and modifiers`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, and five sample rows from the query above.
