# Slice 06: Storage migration to better-sqlite3

## Goal
Replace sql.js (an in-memory WASM SQLite that rewrites the whole DB file on every `init`/`close` and has no FTS5) with **better-sqlite3**. That gives a real on-disk DB, WAL mode for concurrent watcher and MCP access, prepared statements, and FTS5 (used by slices 07/10). Keep the public `GraphDb` API source-compatible and add the few helpers later slices need.

## Prerequisites
None. This is wave 1, alongside 01 and 02. If 01 has landed, use `src/util/log.ts`. If it hasn't, write to `process.stderr` directly, gated on `process.env.CGB_DEBUG`, and leave a `// TODO(slice-01)` comment.

## Files touched
- `src/graph/db.ts`
- `src/graph/__tests__/db.test.ts`
- `src/graph/__tests__/engine.test.ts` (header comment and setup only, if needed)
- `package.json` and `package-lock.json`: add `better-sqlite3` and `@types/better-sqlite3`, remove `sql.js` and its types
- `docs/SCHEMA.md` (owned by track B)
- `docs/TROUBLESHOOTING.md` (native-module install section)

## Suggested model
Sonnet

## Read only these files
- `src/graph/db.ts` (whole file, about 570 lines)
- `src/graph/__tests__/db.test.ts`
- `src/graph/__tests__/engine.test.ts` (setup section)
- `src/types.ts` lines 1-80 (read only; slice 07 owns it)
- `docs/SCHEMA.md`, `docs/TROUBLESHOOTING.md`
- Run `grep -rn "persist()\|sql.js\|sqlJs\|GraphDb.sqlJs" src` to find every caller of sql.js-specific APIs.

## Background
Decisions (final):
- **D1**: better-sqlite3 with WAL. sql.js is removed completely.
- **D6**: edges have **no foreign keys and no cascades**. Re-parsing a file deletes that file's nodes and **outgoing** edges only. Incoming edges from other files survive, because node IDs are stable. A linker (slice 05) prunes dangling edges after each batch. This fixes a real bug: a cascade on `to_id` used to delete edges from unchanged files, and those files were never re-parsed.
- **D12**: logs go to stderr only.
- The graph DB is **derived data**. When the schema version changes, drop and recreate it rather than writing data migrations.

Facts about the current code:
- `GraphDb` is constructed with `new GraphDb(projectRoot)`, then `await db.init()`. The DB file is `<root>/.cgb/graph.db`.
- Callers (CLI, MCP server, registry, eval) use: `upsertNode`, `getNode`, `getNodesByFile`, `searchNodes`, `rebuildFts`, `getNodesByKind`, `getAllNodes`, `deleteNodesByFile`, `upsertEdge`, `getEdgesFrom/To`, `getEdgesFromByKind/ToByKind`, `deleteEdgesByFile`, `upsertFile`, `getFile`, `getAllFiles`, `deleteFile`, `getStats`, `getNodeCountByKind`, `getEdgeCountByKind`, `getAllEdges`, `searchNodesRanked`, the embedding methods, the community methods, `persist`, `close` and `getDbDir`.
- `nodes.community_id` is currently added by an `ALTER` inside try/catch. Fold it into the base schema.
- The VS Code extension (`vscode-extension/`) already reads `graph.db` with better-sqlite3 read-only. Keep the table and column names compatible.

API contract after this slice. Later slices depend on these exact signatures:
```ts
class GraphDb {
  constructor(projectRoot: string);
  init(): Promise<void>;          // stays async for compatibility; opens file, pragmas, schema check
  persist(): void;                // no-op (kept so callers compile); mark @deprecated
  close(): void;                  // closes the handle; idempotent
  transaction<T>(fn: () => T): T; // wraps better-sqlite3 db.transaction
  getNodesByIds(ids: string[]): GraphNode[];               // chunked IN (...) of 500; order not guaranteed
  getNodesByName(name: string, kinds?: NodeKind[]): GraphNode[]; // exact, case-sensitive
  deleteDanglingEdges(): number;  // DELETE edges whose from_id or to_id has no node; returns count
  deleteEdgesByFile(filePath: string): void; // OUTGOING only: edges whose from_id is a node in filePath
  // ...all existing methods keep their signatures and semantics
}
export const SCHEMA_VERSION = 1;  // PRAGMA user_version; mismatch ⇒ drop all tables, recreate, warnOnce
```
- Pragmas: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = OFF`, `busy_timeout = 5000`.
- Cache prepared statements in a private `Map<string, Statement>`.
- `searchNodes` / `searchNodesRanked` keep today's behaviour, a LIKE search. Escape `%`, `_` and `\` with `ESCAPE '\'`. Slice 10 replaces them with FTS5, so don't add FTS here.
- Add an index on `nodes(name)`.

Native-module notes: better-sqlite3 ships prebuilds for Node 20/22 on win32, darwin and linux. `engines` already requires Node >= 20. If `npm install` falls back to a source build on Windows, document the fix in TROUBLESHOOTING (Visual Studio Build Tools, or `npm config set msvs_version`).

## Tasks
1. `npm uninstall sql.js @types/sql.js` (whichever are present), then `npm install better-sqlite3@^11` and `npm install -D @types/better-sqlite3`.
2. Rewrite `db.ts` on better-sqlite3 to match the contract above. Remove row-mapping code that only existed for sql.js result arrays. Rewrite `rowTo*` helpers to map from objects.
3. Use a schema without FKs or cascades. Apply the version check with drop-and-recreate on mismatch, including a DB written by older sql.js builds (which has `user_version` 0).
4. Update `db.test.ts`:
   - existing tests must pass
   - transaction rollback on throw
   - `getNodesByIds` with 1200 IDs (chunking)
   - `getNodesByName`
   - `deleteEdgesByFile` leaves incoming edges intact
   - `deleteDanglingEdges` count
   - LIKE escaping of `%`
   - schema mismatch recreates the DB
   - two `GraphDb` instances on the same root can both read while one writes (WAL)
5. Grep for and remove any `persist()` reliance (for example "persist then copy"). Keep calls compiling, since the method is a no-op.
6. Update `docs/SCHEMA.md`: engine, pragmas, tables without FK, the `SCHEMA_VERSION` policy, the `nodes(name)` index. Mark the FTS5 section "added in schema v2 (slice 07)". Add the native-module install section to `docs/TROUBLESHOOTING.md`.

## Out of scope
- New columns, line ranges or FTS5 (07, 10).
- Changing query semantics in `engine.ts` or other callers (17 does batching).
- The VS Code extension code.

## Done when
```
npm ci
npx tsc --noEmit
npx jest
npm run build
node dist/cli/index.js init -r . && node dist/cli/index.js stats -r .
```
All pass. `grep -rn "sql.js" src package.json` is empty. A second `init` run is fast (incremental) and doesn't rewrite the whole file: check that `.cgb/graph.db` mtime changes only when files changed, or that WAL files are present.

## Finish
1. Tick `- [x] 06` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `refactor(slice-06): migrate GraphDb to better-sqlite3 (WAL, no FK cascades)`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, init time on this repo before and after, and any caller that needed a change.
