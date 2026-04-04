/**
 * SQLite-backed graph database using sql.js (pure WASM, no native compilation).
 * Stores nodes, edges, and file metadata. Persists to a binary .db file on disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import type { GraphEdge, GraphNode, FileRecord } from '../types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
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

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_nodes_file_path  ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind       ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_edges_from_id    ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_id      ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind       ON edges(kind);
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

    this.db.run(SCHEMA);
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
    const like = `%${query}%`;
    const rows = this.db.exec(
      'SELECT * FROM nodes WHERE name LIKE ? OR description LIKE ? OR file_path LIKE ? LIMIT 50',
      [like, like, like],
    );
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

  // ─── All Nodes/Edges (for traversal) ──────────────────────────────────────

  getAllNodes(): GraphNode[] {
    const rows = this.db.exec('SELECT * FROM nodes');
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToNode(rows[0].columns, row));
  }

  getAllEdges(): GraphEdge[] {
    const rows = this.db.exec('SELECT * FROM edges');
    if (!rows.length) return [];
    return rows[0].values.map((row) => this.rowToEdge(rows[0].columns, row));
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
