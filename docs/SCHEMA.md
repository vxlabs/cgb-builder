# CGB Database Schema

The graph is stored in a single SQLite database (`.cgb/graph.db`), opened with
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (native, on-disk).

## Engine and pragmas

| Pragma | Value | Why |
|--------|-------|-----|
| `journal_mode` | `WAL` | Concurrent readers (MCP server, VS Code extension) while a writer (watcher, `init`) runs |
| `synchronous` | `NORMAL` | Safe with WAL, much faster writes |
| `foreign_keys` | `OFF` | Edges have no foreign keys (see below) |
| `busy_timeout` | `5000` | Wait up to 5 s for a competing writer instead of failing |

The database is **derived data**. Writes go straight to disk (there is no in-memory copy and
no whole-file rewrite on `init`/`close`); `GraphDb.persist()` is a deprecated no-op.

## Tables

### `files`

Tracks every scanned source file.

| Column | Type | Description |
|--------|------|-------------|
| `file_path` | TEXT PRIMARY KEY | Path of the file |
| `language` | TEXT NOT NULL | Detected language |
| `content_hash` | TEXT NOT NULL | Content hash for incremental re-scans |
| `mtime` | INTEGER NOT NULL | File modification time |
| `node_count` | INTEGER NOT NULL | Nodes extracted from the file |
| `edge_count` | INTEGER NOT NULL | Edges extracted from the file |
| `parsed_at` | INTEGER NOT NULL | Unix ms of last parse |

### `nodes`

Every named symbol extracted from source files.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Stable, globally unique node ID |
| `kind` | TEXT NOT NULL | Node kind (`file`, `function`, `class`, ...) |
| `name` | TEXT NOT NULL | Symbol name |
| `file_path` | TEXT NOT NULL | Source file |
| `description` | TEXT NOT NULL | Description (default `''`) |
| `is_external` | INTEGER NOT NULL | `1` = external package |
| `language` | TEXT | Language |
| `meta` | TEXT NOT NULL | JSON metadata (default `'{}'`) |
| `updated_at` | INTEGER NOT NULL | Unix ms |
| `community_id` | INTEGER | Community assignment (nullable) |
| `start_line` | INTEGER | 1-based first line of the symbol (nullable; v2) |
| `end_line` | INTEGER | 1-based last line, inclusive (nullable; v2) |
| `signature` | TEXT | Single-line signature, max 200 chars (nullable; v2) |
| `doc` | TEXT | First paragraph of the leading doc comment, max 300 chars (nullable; v2) |
| `exported` | INTEGER | `1`/`0` exported flag, NULL = unknown (v2) |
| `modifiers` | TEXT | JSON array, subset of `async static abstract private protected public readonly default generator getter setter`, or NULL (v2) |

### `edges`

Directed relationships between nodes. **No foreign keys and no cascades.**
Re-parsing a file deletes that file's nodes and its *outgoing* edges only. Incoming edges from
other files survive because node IDs are stable. `GraphDb.deleteDanglingEdges()` prunes edges
whose `from_id` or `to_id` has no node (the linker calls it after each batch).

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Edge ID |
| `from_id` | TEXT NOT NULL | Source node ID |
| `to_id` | TEXT NOT NULL | Target node ID |
| `kind` | TEXT NOT NULL | Edge kind (`imports`, `calls`, ...) |
| `reason` | TEXT NOT NULL | Human-readable reason (default `''`) |
| `updated_at` | INTEGER NOT NULL | Unix ms |

### `embeddings`

`node_id` (PK), `vector` (BLOB, Float32 encoded), `text_hash`, `provider` (default `'local'`).

### `communities`

`id` (INTEGER PK AUTOINCREMENT), `name`, `level`, `parent_id`, `cohesion`, `size`,
`dominant_language`, `description`, `created_at`.

## Indexes

```sql
CREATE INDEX idx_nodes_file_path ON nodes(file_path);
CREATE INDEX idx_nodes_kind      ON nodes(kind);
CREATE INDEX idx_nodes_name      ON nodes(name);
CREATE INDEX idx_nodes_community ON nodes(community_id);
CREATE INDEX idx_edges_from_id   ON edges(from_id);
CREATE INDEX idx_edges_to_id     ON edges(to_id);
CREATE INDEX idx_edges_kind      ON edges(kind);
```

## FTS5 Search

*Added in schema v2 (slice 07).* `nodes_fts` is an FTS5 virtual table maintained by
`GraphDb` itself (no triggers, so identifier tokenisation stays in TypeScript):

```sql
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  node_id UNINDEXED, name, name_tokens, signature, doc, path_tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

- Its `rowid` equals the `nodes.rowid` of the indexed node (one row per node, external nodes included).
- `name_tokens` = `splitIdentifier(name)` (`parseFileAsync` -> `parse file async`).
- `path_tokens` = the last 4 segments of `file_path`, split on `/  . _ -`.
- `upsertNode` replaces the node's FTS row; `deleteNodesByFile` deletes the file's FTS rows;
  `rebuildFts()` repopulates the whole table from `nodes`.
### Ranking (slice 10)

`searchNodesRanked(query, opts?)` (`opts` is a number limit or `{ limit (default 30, max 500), kinds, includeExternal (default false) }`)
returns `{ id, score, matchedBy: 'exact' | 'prefix' | 'fts' }[]`; `searchNodes` returns the same order as `GraphNode[]`.

1. **exact**: `name = ? COLLATE NOCASE`, or the last segment of `Class.method` names. Score 1000.
2. **prefix**: `name LIKE 'query%'`. Score `500 - min(len(name) - len(query), 400)`.
3. **fts**: `splitIdentifier(query)` tokens, each double-quoted with a `*` suffix, AND-ed; if empty, retried with OR.
   Ordered by `bm25(nodes_fts, 0, 10, 5, 2, 1, 1)` (columns `node_id, name, name_tokens, signature, doc, path_tokens`);
   score `100 / (1 + position)`. FTS syntax characters in user input never reach the MATCH expression.
4. If nothing matched, a substring match on `name` (score 10) covers punctuation-only queries.

Results are merged by id keeping the best score; ties break by kind priority
(`class, interface, function, method, type, module, file, external_dep`) then shorter name.
External nodes are excluded unless `includeExternal` is set.

Embeddings are optional: `hybridSearch` (`src/embed`) fuses the lexical list with a vector list via RRF (k=60)
only when the `embeddings` table is non-empty. A missing `@xenova/transformers` (optional dependency) logs one warning and
falls back to a TF-IDF centroid query vector.

## Versioning

The schema version is stored in `PRAGMA user_version` and exported as `SCHEMA_VERSION`
(`src/graph/db.ts`). Current version: **2** (v2 added the metadata columns and `nodes_fts`).

Policy: the graph is derived data, so there are no data migrations. When the stored version
differs from `SCHEMA_VERSION` (including databases written by older sql.js builds, which have
`user_version = 0`), `GraphDb.init()` drops all tables, recreates the schema, and logs a
one-time warning to stderr. Re-run `cgb init` to repopulate.
