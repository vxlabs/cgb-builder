# Slice 07: Schema v2 (line ranges, signature, doc, exported, FTS5 table)

## Goal
Store the metadata Claude needs to jump straight to code instead of grepping: line ranges, signature, doc comment, exported flag and modifiers. Also add an FTS5 index over symbols. This slice adds the **columns, types, DB plumbing and shared tree-sitter helpers**. Adapters fill the fields later, in 08 (TS) and 09 (others). Ranked search queries come in 10.

## Prerequisites
- 06: `GraphDb` is on better-sqlite3 with `SCHEMA_VERSION` and drop-and-recreate on mismatch.

## Files touched
- `src/types.ts`
- `src/graph/db.ts`
- `src/parser/utils.ts`
- `src/graph/__tests__/db.test.ts`
- `src/parser/__tests__/utils.test.ts` (new)
- `docs/SCHEMA.md`

## Suggested model
Sonnet

## Read only these files
- `src/types.ts`, `src/graph/db.ts`, `src/parser/utils.ts`
- `src/graph/__tests__/db.test.ts`
- `docs/SCHEMA.md`
- `src/parser/tree-sitter-engine.ts` (to see the `SyntaxNode` type import from `web-tree-sitter`)

## Background
Decisions (final):
- **D1**: better-sqlite3 has FTS5 built in.
- **D5**: no new `NodeKind`s.
- **D6**: no FKs on edges.
- The DB is derived data. Bump `SCHEMA_VERSION` to **2**, so existing DBs are dropped and recreated (06 implemented that policy).
- `GraphNode` additions. All are **optional**, so adapters that don't fill them still compile:
  ```ts
  startLine?: number;   // 1-based, inclusive
  endLine?: number;     // 1-based, inclusive
  signature?: string;   // single line, ≤ 200 chars, e.g. "async find(id: string): Promise<User | null>"
  doc?: string;         // first paragraph of the leading doc comment, ≤ 300 chars, comment markers stripped
  exported?: boolean;
  modifiers?: string[]; // subset of: async, static, abstract, private, protected, public, readonly, default, generator, getter, setter
  ```
- Columns on `nodes`: `start_line INTEGER, end_line INTEGER, signature TEXT, doc TEXT, exported INTEGER, modifiers TEXT` (a JSON array or NULL). `upsertNode` writes them. The `rowToNode` helper reads them back, leaving `undefined` when the column is NULL.
- FTS5 virtual table maintained by `GraphDb` itself, not by triggers, so tokenisation stays in TS:
  ```sql
  CREATE VIRTUAL TABLE nodes_fts USING fts5(
    node_id UNINDEXED, name, name_tokens, signature, doc, path_tokens,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  ```
  - `name_tokens = splitIdentifier(name)`
  - `path_tokens` = the repo-relative-ish tail of `file_path`, split on `/\\._-`. Use the last 4 path segments, since the root isn't known inside the DB.
  - `upsertNode` replaces the FTS row. `deleteNodesByFile` / `deleteNode` paths delete FTS rows.
  - `rebuildFts()` repopulates everything from `nodes`.
  - External nodes are indexed too.
- **Don't** change `searchNodes` / `searchNodesRanked` behaviour yet. Slice 10 does that. Adding a new private helper is fine.
- Shared helpers in `src/parser/utils.ts`. These signatures are exact, because 08 and 09 call them:
  ```ts
  import type { SyntaxNode } from 'web-tree-sitter';
  export function nodeRange(n: SyntaxNode): { startLine: number; endLine: number }; // 1-based
  export function splitIdentifier(s: string): string; // "parseFileAsync" → "parse file async"; "HTTPServer_v2" → "http server v 2"; lowercased, space-joined
  export function oneLine(text: string, max = 200): string; // collapse whitespace, trim, truncate with "…"
  export function leadingDocComment(n: SyntaxNode, source: string, style: 'jsdoc' | 'hash' | 'slash' | 'python'): string | undefined;
  ```
  - `jsdoc`: `/** ... */` immediately preceding the node, or its `export_statement` parent. Strip `*` and `@tags` lines, and keep the first paragraph.
  - `slash`: consecutive `///` or `//` lines immediately above.
  - `hash`: consecutive `#` lines.
  - `python`: the first string-expression statement of the body (a docstring).

## Tasks
1. Add the optional fields to `GraphNode` in `types.ts`.
2. In `db.ts`: bump `SCHEMA_VERSION` to 2, add the columns and the FTS5 table, keep FTS rows in sync, and implement `rebuildFts()`. The DB-level `GraphNode` round-trip must preserve every new field.
3. Implement the helpers in `utils.ts`, with `utils.test.ts`. Cover `splitIdentifier` edge cases, and run `leadingDocComment` on a real tree-sitter parse of small TS, Python and C# snippets (use `treeSitterEngine`).
4. Extend `db.test.ts`:
   - round-trip of the new fields
   - an FTS row exists after upsert and is gone after `deleteNodesByFile`
   - `rebuildFts` count equals the nodes count
   - a v1 DB gets recreated
5. Update `docs/SCHEMA.md`: the new columns, the FTS5 table and its maintenance, and version 2.

## Out of scope
- Filling the fields in any adapter (08, 09).
- Search ranking or MCP output (10, 14).

## Done when
```
npx tsc --noEmit
npx jest
npm run build
```
All pass. A raw query `select count(*) from nodes_fts` on this repo's DB, after `node dist/cli/index.js init -r .`, equals the node count.

## Finish
1. Tick `- [x] 07` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-07): schema v2 with line ranges, signature, doc and FTS5 index`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, and the final helper signatures if any changed (they shouldn't).
