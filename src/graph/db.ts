/**
 * SQLite-backed graph database using sql.js (pure WASM, no native compilation).
 * Stores nodes, edges, and file metadata. Persists to a binary .db file on disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import type { GraphEdge, GraphNode, FileRecord, EmbeddingRecord, CommunityRecord } from '../types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_CORE = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_external INTEGER NOT NULL DEFAULT 0,
  language    TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id)   REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
  file_path    TEXT PRIMARY KEY,
  language     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime        INTEGER NOT NULL,
  node_count   INTEGER NOT NULL DEFAULT 0,
  edge_count   INTEGER NOT NULL DEFAULT 0,
  parsed_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  node_id   TEXT PRIMARY KEY,
  vector    BLOB NOT NULL,
  text_hash TEXT NOT NULL,
  provider  TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS communities (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  level             INTEGER NOT NULL DEFAULT 0,
  parent_id         INTEGER,
  cohesion          REAL NOT NULL DEFAULT 0.0,
  size              INTEGER NOT NULL DEFAULT 0,
  dominant_language TEXT,
  description       TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_nodes_file_path  ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind       ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_edges_from_id    ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_id      ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind       ON edges(kind);
`;

// FTS5 is only available when SQLite is compiled with it (e.g. native binaries).
// The sql.js WASM build does not include FTS5, so we apply this schema
// opportunistically and fall back gracefully when it is absent.
const SCHEMA_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id        UNINDEXED,
  name,
  description,
  file_path,
  content='nodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, id, name, description, file_path)
  VALUES (new.rowid, new.id, new.name, new.description, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, description, file_path)
  VALUES ('delete', old.rowid, old.id, old.name, old.description, old.file_path);
  INSERT INTO nodes_fts(rowid, id, name, description, file_path)
  VALUES (new.rowid, new.id, new.name, new.description, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, description, file_path)
  VALUES ('delete', old.rowid, old.id, old.name, old.description, old.file_path);
END;
`;

// ─── GraphDb class ────────────────────────────────────────────────────────────

export class GraphDb {
  private db!: Database;
  private dbPath: string;
  private static sqlJs: SqlJsStatic | null = null;

  constructor(projectRoot: string) {
    const cgbDir = path.join(projectRoot, '.cgb');
    if (!fs.existsSync(cgbDir)) {
      fs.mkdirSync(cgbDir, { recursive: true });
    }
    this.dbPath = path.join(cgbDir, 'graph.db');
  }

  /** Initialize the database (async because sql.js WASM loading is async) */
  async init(): Promise<void> {
    if (!GraphDb.sqlJs) {
      const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
      GraphDb.sqlJs = await initSqlJs({ locateFile: () => wasmPath });
    }

    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new GraphDb.sqlJs.Database(fileBuffer);
    } else {
      this.db = new GraphDb.sqlJs.Database();
    }

    this.db.run(SCHEMA_CORE);

    // FTS5 is optional — only available in SQLite builds that include it.
    // sql.js (WASM) does not ship FTS5, so we apply it opportunistically.
    try {
      this.db.run(SCHEMA_FTS);
    } catch {
      // FTS5 unavailable; searchNodes() and searchNodesRanked() fall back to LIKE
    }

    // Idempotent migration: add community_id column to nodes if not present
    try {
      this.db.run('ALTER TABLE nodes ADD COLUMN community_id INTEGER');
    } catch {
      // Column already exists — ignore
    }

    this.persist();
  }

  /** Save the in-memory DB back to disk */
  persist(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  close(): void {
    this.persist();
    this.db.close();
  }

  /** Returns the .cgb/ directory that contains the database file. */
  getDbDir(): string {
    return path.dirname(this.dbPath);
  }

  // ─── Node Operations ───────────────────────────────────────────────────────

  upsertNode(node: GraphNode): void {
    this.db.run(
      `INSERT INTO nodes (id, kind, name, file_path, description, is_external, language, meta, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind        = excluded.kind,
         name        = excluded.name,
         file_path   = excluded.file_path,
         description = excluded.description,
         is_external = excluded.is_external,
         language    = excluded.language,
         meta        = excluded.meta,
         updated_at  = excluded.updated_at`,
      [
        node.id,
        node.kind,
        node.name,
        node.filePath,
        node.description,
        node.isExternal ? 1 : 0,
        node.language ?? null,
        node.meta,
        node.updatedAt,
      ],
    );
  }

  getNode(id: string): GraphNode | null {
    const rows = this.db.exec('SELECT * FROM nodes WHERE id = ?', [id]);
    if (!rows.length || !rows[0].values.length) return null;
    return this.rowToNode(rows[0].columns, rows[0].values[0]);
  }

  getNodesByFile(filePath: string): GraphNode[] {
    const rows = this.db.exec('SELECT * FROM nodes WHERE file_path = ?', [filePath]);
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToNode(rows[0].columns, row));
  }

  searchNodes(query: string): GraphNode[] {
    // Attempt FTS5 full-text search first; fall back to LIKE on error
    try {
      // Escape FTS5 special chars in the query and wrap for prefix matching
      const ftsQuery = query.replace(/["*^()]/g, ' ').trim() + '*';
      const rows = this.db.exec(
        `SELECT n.* FROM nodes n
         JOIN nodes_fts ON n.rowid = nodes_fts.rowid
         WHERE nodes_fts MATCH ?
         ORDER BY nodes_fts.rank
         LIMIT 100`,
        [ftsQuery],
      );
      if (rows.length) {
        return rows[0].values.map((row) => this.rowToNode(rows[0].columns, row));
      }
      return [];
    } catch {
      // Fallback: LIKE search when FTS5 is unavailable or query is malformed
      const like = `%${query}%`;
      const rows = this.db.exec(
        'SELECT * FROM nodes WHERE name LIKE ? OR description LIKE ? OR file_path LIKE ? LIMIT 100',
        [like, like, like],
      );
      if (!rows.length) return [];
      return rows[0].values.map((row) => this.rowToNode(rows[0].columns, row));
    }
  }

  /** Rebuild FTS5 index from scratch (useful after bulk imports or migrations) */
  rebuildFts(): void {
    try {
      this.db.run(`INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')`);
    } catch {
      // FTS5 may not be available in all builds; silently continue
    }
  }

  getNodesByKind(kinds: string[]): GraphNode[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(', ');
    const rows = this.db.exec(
      `SELECT * FROM nodes WHERE kind IN (${placeholders}) ORDER BY name`,
      kinds,
    );
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToNode(rows[0].columns, row));
  }

  getAllNodes(): GraphNode[] {
    const rows = this.db.exec('SELECT * FROM nodes ORDER BY name');
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToNode(rows[0].columns, row));
  }

  deleteNodesByFile(filePath: string): void {
    this.db.run('DELETE FROM nodes WHERE file_path = ?', [filePath]);
  }

  // ─── Edge Operations ───────────────────────────────────────────────────────

  upsertEdge(edge: GraphEdge): void {
    this.db.run(
      `INSERT INTO edges (id, from_id, to_id, kind, reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         reason     = excluded.reason,
         updated_at = excluded.updated_at`,
      [edge.id, edge.fromId, edge.toId, edge.kind, edge.reason, edge.updatedAt],
    );
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    const rows = this.db.exec('SELECT * FROM edges WHERE from_id = ?', [nodeId]);
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToEdge(rows[0].columns, row));
  }

  getEdgesTo(nodeId: string): GraphEdge[] {
    const rows = this.db.exec('SELECT * FROM edges WHERE to_id = ?', [nodeId]);
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToEdge(rows[0].columns, row));
  }

  getEdgesFromByKind(nodeId: string, kind: string): GraphEdge[] {
    const rows = this.db.exec('SELECT * FROM edges WHERE from_id = ? AND kind = ?', [nodeId, kind]);
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToEdge(rows[0].columns, row));
  }

  getEdgesToByKind(nodeId: string, kind: string): GraphEdge[] {
    const rows = this.db.exec('SELECT * FROM edges WHERE to_id = ? AND kind = ?', [nodeId, kind]);
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToEdge(rows[0].columns, row));
  }

  deleteEdgesByFile(filePath: string): void {
    // Edges are cascade-deleted when nodes are deleted, but we also remove
    // outgoing edges from this file's nodes
    const nodes = this.getNodesByFile(filePath);
    for (const node of nodes) {
      this.db.run('DELETE FROM edges WHERE from_id = ?', [node.id]);
    }
  }

  // ─── File Operations ───────────────────────────────────────────────────────

  upsertFile(record: FileRecord): void {
    this.db.run(
      `INSERT INTO files (file_path, language, content_hash, mtime, node_count, edge_count, parsed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         language     = excluded.language,
         content_hash = excluded.content_hash,
         mtime        = excluded.mtime,
         node_count   = excluded.node_count,
         edge_count   = excluded.edge_count,
         parsed_at    = excluded.parsed_at`,
      [
        record.filePath,
        record.language,
        record.contentHash,
        record.mtime,
        record.nodeCount,
        record.edgeCount,
        record.parsedAt,
      ],
    );
  }

  getFile(filePath: string): FileRecord | null {
    const rows = this.db.exec('SELECT * FROM files WHERE file_path = ?', [filePath]);
    if (!rows.length || !rows[0].values.length) return null;
    return this.rowToFile(rows[0].columns, rows[0].values[0]);
  }

  getAllFiles(): FileRecord[] {
    const rows = this.db.exec('SELECT * FROM files ORDER BY file_path');
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToFile(rows[0].columns, row));
  }

  deleteFile(filePath: string): void {
    this.deleteEdgesByFile(filePath);
    this.deleteNodesByFile(filePath);
    this.db.run('DELETE FROM files WHERE file_path = ?', [filePath]);
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  getStats(): { nodes: number; edges: number; files: number } {
    const nodeCount = this.db.exec('SELECT COUNT(*) FROM nodes')[0]?.values[0][0] as number;
    const edgeCount = this.db.exec('SELECT COUNT(*) FROM edges')[0]?.values[0][0] as number;
    const fileCount = this.db.exec('SELECT COUNT(*) FROM files')[0]?.values[0][0] as number;
    return { nodes: nodeCount ?? 0, edges: edgeCount ?? 0, files: fileCount ?? 0 };
  }

  getNodeCountByKind(): Record<string, number> {
    const rows = this.db.exec('SELECT kind, COUNT(*) as cnt FROM nodes GROUP BY kind');
    if (!rows.length) return {};
    return Object.fromEntries(rows[0].values.map(([kind, cnt]) => [kind as string, cnt as number]));
  }

  // ─── All Edges (for traversal) ────────────────────────────────────────────

  getAllEdges(): GraphEdge[] {
    const rows = this.db.exec('SELECT * FROM edges');
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToEdge(rows[0].columns, row));
  }

  // ─── BM25 Ranked Search ────────────────────────────────────────────────────

  /** FTS5 BM25-ranked search. Returns {id, score}[] with best matches first. */
  searchNodesRanked(query: string, limit = 50): Array<{ id: string; score: number }> {
    try {
      const ftsQuery = query.replace(/["*^()]/g, ' ').trim() + '*';
      const rows = this.db.exec(
        `SELECT n.id, nodes_fts.rank as score
         FROM nodes n
         JOIN nodes_fts ON n.rowid = nodes_fts.rowid
         WHERE nodes_fts MATCH ?
         ORDER BY nodes_fts.rank
         LIMIT ?`,
        [ftsQuery, limit],
      );
      if (!rows.length) return [];
      return rows[0].values.map(([id, score]) => ({
        id: id as string,
        score: -(score as number), // FTS5 rank is negative; flip so higher = better
      }));
    } catch {
      return [];
    }
  }

  // ─── Embedding Operations ──────────────────────────────────────────────────

  upsertEmbedding(record: EmbeddingRecord): void {
    this.db.run(
      `INSERT INTO embeddings (node_id, vector, text_hash, provider)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         vector    = excluded.vector,
         text_hash = excluded.text_hash,
         provider  = excluded.provider`,
      [record.nodeId, record.vector, record.textHash, record.provider],
    );
  }

  getEmbedding(nodeId: string): EmbeddingRecord | null {
    const rows = this.db.exec('SELECT * FROM embeddings WHERE node_id = ?', [nodeId]);
    if (!rows.length || !rows[0].values.length) return null;
    return this.rowToEmbedding(rows[0].columns, rows[0].values[0]);
  }

  getAllEmbeddings(): EmbeddingRecord[] {
    const rows = this.db.exec('SELECT * FROM embeddings');
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToEmbedding(rows[0].columns, row));
  }

  deleteEmbedding(nodeId: string): void {
    this.db.run('DELETE FROM embeddings WHERE node_id = ?', [nodeId]);
  }

  getEmbeddingCount(): number {
    const rows = this.db.exec('SELECT COUNT(*) FROM embeddings');
    return (rows[0]?.values[0][0] as number) ?? 0;
  }

  // ─── Community Operations ──────────────────────────────────────────────────

  upsertCommunity(community: Omit<CommunityRecord, 'id'>): number {
    this.db.run(
      `INSERT INTO communities (name, level, parent_id, cohesion, size, dominant_language, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        community.name,
        community.level,
        community.parentId ?? null,
        community.cohesion,
        community.size,
        community.dominantLanguage ?? null,
        community.description,
        community.createdAt,
      ],
    );
    const rows = this.db.exec('SELECT last_insert_rowid()');
    return (rows[0]?.values[0][0] as number) ?? 0;
  }

  clearCommunities(): void {
    this.db.run('DELETE FROM communities');
    this.db.run('UPDATE nodes SET community_id = NULL');
  }

  updateNodeCommunity(nodeId: string, communityId: number | null): void {
    this.db.run('UPDATE nodes SET community_id = ? WHERE id = ?', [communityId, nodeId]);
  }

  getCommunities(level?: number): CommunityRecord[] {
    const rows =
      level !== undefined
        ? this.db.exec('SELECT * FROM communities WHERE level = ? ORDER BY size DESC', [level])
        : this.db.exec('SELECT * FROM communities ORDER BY level ASC, size DESC');
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToCommunity(rows[0].columns, row));
  }

  getCommunityMembers(communityId: number): GraphNode[] {
    const rows = this.db.exec('SELECT * FROM nodes WHERE community_id = ?', [communityId]);
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToNode(rows[0].columns, row));
  }

  // ─── Row Mappers ───────────────────────────────────────────────────────────

  private rowToNode(columns: string[], row: (number | string | Uint8Array | null)[]): GraphNode {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return {
      id: obj['id'] as string,
      kind: obj['kind'] as GraphNode['kind'],
      name: obj['name'] as string,
      filePath: obj['file_path'] as string,
      description: (obj['description'] as string) ?? '',
      isExternal: (obj['is_external'] as number) === 1,
      language: (obj['language'] as GraphNode['language']) ?? null,
      meta: (obj['meta'] as string) ?? '{}',
      updatedAt: obj['updated_at'] as number,
    };
  }

  private rowToEdge(columns: string[], row: (number | string | Uint8Array | null)[]): GraphEdge {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return {
      id: obj['id'] as string,
      fromId: obj['from_id'] as string,
      toId: obj['to_id'] as string,
      kind: obj['kind'] as GraphEdge['kind'],
      reason: (obj['reason'] as string) ?? '',
      updatedAt: obj['updated_at'] as number,
    };
  }

  private rowToEmbedding(
    columns: string[],
    row: (number | string | Uint8Array | null)[],
  ): EmbeddingRecord {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return {
      nodeId: obj['node_id'] as string,
      vector: obj['vector'] as Uint8Array,
      textHash: obj['text_hash'] as string,
      provider: obj['provider'] as string,
    };
  }

  private rowToCommunity(
    columns: string[],
    row: (number | string | Uint8Array | null)[],
  ): CommunityRecord {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return {
      id: obj['id'] as number,
      name: obj['name'] as string,
      level: obj['level'] as number,
      parentId: (obj['parent_id'] as number | null) ?? null,
      cohesion: obj['cohesion'] as number,
      size: obj['size'] as number,
      dominantLanguage: (obj['dominant_language'] as string | null) ?? null,
      description: (obj['description'] as string) ?? '',
      createdAt: obj['created_at'] as number,
    };
  }

  private rowToFile(columns: string[], row: (number | string | Uint8Array | null)[]): FileRecord {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return {
      filePath: obj['file_path'] as string,
      language: obj['language'] as FileRecord['language'],
      contentHash: obj['content_hash'] as string,
      mtime: obj['mtime'] as number,
      nodeCount: obj['node_count'] as number,
      edgeCount: obj['edge_count'] as number,
      parsedAt: obj['parsed_at'] as number,
    };
  }
}
