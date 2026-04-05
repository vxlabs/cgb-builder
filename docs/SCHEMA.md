# CGB Database Schema

The graph is stored in a single SQLite database (`.cgb/graph.db`).

## Tables

### `files`

Tracks every scanned source file.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Stable file identifier (usually absolute path) |
| `filePath` | TEXT NOT NULL | Relative path from project root |
| `language` | TEXT | Detected language (`typescript`, `python`, `rust`, …) |
| `lastParsed` | INTEGER | Unix timestamp of last parse |
| `hash` | TEXT | Content hash for incremental re-scans |

### `nodes`

Every named symbol extracted from source files.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Globally unique node ID |
| `name` | TEXT NOT NULL | Symbol name |
| `kind` | TEXT NOT NULL | `file` \| `function` \| `class` \| `interface` \| `type` \| `variable` \| `test` |
| `filePath` | TEXT | Source file (FK → `files.filePath`) |
| `startLine` | INTEGER | Line where the symbol starts |
| `endLine` | INTEGER | Line where the symbol ends |
| `isExternal` | INTEGER | `1` = from `node_modules` / external package |
| `exportedAs` | TEXT | Export alias (if re-exported under a different name) |

### `edges`

Directed relationships between nodes.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Edge ID |
| `fromId` | TEXT NOT NULL | Source node (FK → `nodes.id`) |
| `toId` | TEXT NOT NULL | Target node (FK → `nodes.id`) |
| `kind` | TEXT NOT NULL | `IMPORTS` \| `CALLS` \| `EXTENDS` \| `IMPLEMENTS` \| `CONTAINS` \| `TESTED_BY` \| `DEPENDS_ON` |

## Indexes

```sql
CREATE INDEX idx_edges_from ON edges(fromId);
CREATE INDEX idx_edges_to   ON edges(toId);
CREATE INDEX idx_nodes_file ON nodes(filePath);
CREATE INDEX idx_nodes_kind ON nodes(kind);
```

## FTS5 Search

An FTS5 virtual table mirrors `nodes` for fast full-text search:

```sql
CREATE VIRTUAL TABLE nodes_fts USING fts5(name, filePath, content='nodes', content_rowid='rowid');
```

## Versioning

The schema version is stored in `PRAGMA user_version`.  
Current version: **3**.
