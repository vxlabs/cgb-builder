/**
 * SQLite-backed graph database using better-sqlite3 (native, on-disk, WAL).
 * Stores nodes, edges, and file metadata in <dbDir>/graph.db (default <root>/.cgb).
 *
 * Design notes:
 *  - Edges have NO foreign keys / cascades. Re-parsing a file removes that file's
 *    nodes and OUTGOING edges only; incoming edges survive (node IDs are stable).
 *    `deleteDanglingEdges()` prunes edges whose endpoints no longer exist.
 *  - The DB is derived data: on SCHEMA_VERSION mismatch all tables are dropped
 *    and recreated.
 *  - Paths and node ids are stored relative to the project root with POSIX separators, so a
 *    cached DB is valid for any worktree (and OS) of the same repository. The in-memory API
 *    still exposes absolute, native paths.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type {
  GraphEdge,
  GraphNode,
  FileRecord,
  EmbeddingRecord,
  CommunityRecord,
} from '../types.js';
import type { NodeKind } from '../types.js';
import { warnOnce, debug } from '../util/log.js';
import { splitIdentifier } from '../parser/utils.js';

/** Stored in PRAGMA user_version. Bump to force a drop-and-recreate. */
export const SCHEMA_VERSION = 3;

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_CORE = `
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  is_external  INTEGER NOT NULL DEFAULT 0,
  language     TEXT,
  meta         TEXT NOT NULL DEFAULT '{}',
  updated_at   INTEGER NOT NULL,
  community_id INTEGER,
  start_line   INTEGER,
  end_line     INTEGER,
  signature    TEXT,
  doc          TEXT,
  exported     INTEGER,
  modifiers    TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_nodes_file_path  ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind       ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name       ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_community  ON nodes(community_id);
CREATE INDEX IF NOT EXISTS idx_edges_from_id    ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_id      ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind       ON edges(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id UNINDEXED, name, name_tokens, signature, doc, path_tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const IN_CHUNK = 500;

export interface SearchOptions {
  /** Default 30, max 500. */
  limit?: number;
  kinds?: NodeKind[];
  /** Default false. */
  includeExternal?: boolean;
}

const KIND_PRIORITY = [
  'class',
  'interface',
  'function',
  'method',
  'type',
  'module',
  'file',
  'external_dep',
];

type Row = Record<string, unknown>;

/** Last 4 path segments, split on / \ . _ - (the DB does not know the repo root). */
function pathTokens(filePath: string): string {
  return filePath
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-4)
    .join(' ')
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .join(' ');
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function optionalNodeFields(obj: Row): Partial<GraphNode> {
  const out: Partial<GraphNode> = {};
  if (obj['start_line'] != null) out.startLine = obj['start_line'] as number;
  if (obj['end_line'] != null) out.endLine = obj['end_line'] as number;
  if (obj['signature'] != null) out.signature = obj['signature'] as string;
  if (obj['doc'] != null) out.doc = obj['doc'] as string;
  if (obj['exported'] != null) out.exported = (obj['exported'] as number) === 1;
  if (obj['modifiers'] != null) {
    try {
      out.modifiers = JSON.parse(obj['modifiers'] as string) as string[];
    } catch (err) {
      debug('db', 'bad modifiers JSON', err);
    }
  }
  return out;
}

const IS_WIN = process.platform === 'win32';

// ─── GraphDb class ────────────────────────────────────────────────────────────

export interface GraphDbOptions {
  /** Directory holding graph.db. Overrides env CGB_DB_DIR and the default `<root>/.cgb`. */
  dbDir?: string;
  /** Open an existing DB read-only: never create directories or write the file. */
  readOnly?: boolean;
}

export class GraphDb {
  private db!: Database.Database;
  private dbPath: string;
  private stmts = new Map<string, Database.Statement>();
  private readonly root: string;
  private readonly rootPrefix: string;
  private readonly readOnly: boolean;

  /**
   * @param projectRoot Project root; stored paths are relative to it.
   * @param options     `dbDir` overrides the DB directory (precedence: option > env CGB_DB_DIR >
   *                    `<root>/.cgb`). `readOnly` never creates directories or writes the file.
   */
  constructor(projectRoot: string, options: GraphDbOptions = {}) {
    this.root = path.resolve(projectRoot);
    this.rootPrefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    this.readOnly = options.readOnly ?? false;
    const configured = options.dbDir || process.env['CGB_DB_DIR'] || undefined;
    const cgbDir = configured ? path.resolve(configured) : path.join(this.root, '.cgb');
    if (!this.readOnly && !fs.existsSync(cgbDir)) {
      fs.mkdirSync(cgbDir, { recursive: true });
    }
    this.dbPath = path.join(cgbDir, 'graph.db');
  }

  // ─── Path portability (root-relative POSIX on disk, absolute in memory) ────

  /**
   * Absolute path under the root -> `./`-prefixed root-relative POSIX path; anything else is
   * stored unchanged. The `./` marker lets decPath touch only what encPath rewrote.
   */
  private encPath(p: string): string {
    if (!p) return p;
    const head = p.slice(0, this.rootPrefix.length);
    const under = IS_WIN
      ? head.replace(/\//g, '\\').toLowerCase() === this.rootPrefix.toLowerCase()
      : head === this.rootPrefix;
    if (!under) return p;
    const rel = p.slice(this.rootPrefix.length);
    return './' + (IS_WIN ? rel.replace(/\\/g, '/') : rel);
  }

  private decPath(p: string): string {
    return p.startsWith('./') ? path.join(this.root, p) : p;
  }

  /** Node id `kind:path[#symbol]` -> stored form (path part encoded). */
  private encId(id: string): string {
    return this.mapIdPath(id, (p) => this.encPath(p));
  }

  private decId(id: string): string {
    return this.mapIdPath(id, (p) => this.decPath(p));
  }

  private mapIdPath(id: string, fn: (p: string) => string): string {
    if (id.startsWith('external_dep:')) return id;
    const colon = id.indexOf(':');
    if (colon < 0) return id;
    const rest = id.slice(colon + 1);
    const hash = rest.indexOf('#');
    const p = hash < 0 ? rest : rest.slice(0, hash);
    const sym = hash < 0 ? '' : rest.slice(hash);
    return `${id.slice(0, colon + 1)}${fn(p)}${sym}`;
  }

  /** Edge id `from|kind|to`. */
  private encEdgeId(id: string): string {
    const parts = id.split('|');
    if (parts.length !== 3) return id;
    return `${this.encId(parts[0])}|${parts[1]}|${this.encId(parts[2])}`;
  }

  private decEdgeId(id: string): string {
    const parts = id.split('|');
    if (parts.length !== 3) return id;
    return `${this.decId(parts[0])}|${parts[1]}|${this.decId(parts[2])}`;
  }

  /** Open the database, set pragmas, and ensure the schema is current. */
  // eslint-disable-next-line @typescript-eslint/require-await -- async kept for API/signature compatibility
  async init(): Promise<void> {
    if (this.db && this.db.open) return;
    this.stmts.clear();
    if (this.readOnly) {
      this.openReadOnly();
      return;
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = OFF');
    this.db.pragma('busy_timeout = 5000');

    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version !== SCHEMA_VERSION) {
      const hasTables = (
        this.db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get() as Row
      )['c'] as number;
      if (hasTables > 0) {
        warnOnce(
          'db',
          'schema-reset',
          `graph.db schema version ${version} != ${SCHEMA_VERSION}; rebuilding (run init to re-index)`,
        );
        this.dropAll();
      }
      this.db.exec(SCHEMA_CORE);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else {
      this.db.exec(SCHEMA_CORE);
    }
    debug('db', `opened ${this.dbPath}`);
  }

  private openReadOnly(): void {
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`Graph database not found at ${this.dbPath}. Run \`cgb init\` first.`);
    }
    this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `graph.db at ${this.dbPath} has schema version ${version}, expected ${SCHEMA_VERSION}; ` +
          'rebuild it with `cgb init` (read-only mode cannot migrate)',
      );
    }
    debug('db', `opened ${this.dbPath} (read-only)`);
  }

  private dropAll(): void {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Row[];
    this.stmts.clear();
    this.db.transaction(() => {
      for (const t of tables) this.db.exec(`DROP TABLE IF EXISTS "${t['name'] as string}"`);
    })();
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** @deprecated No-op; writes go straight to disk. Kept so callers compile. */
  persist(): void {
    /* no-op */
  }

  /** Close the handle. Idempotent. */
  close(): void {
    if (this.db && this.db.open) {
      this.stmts.clear();
      this.db.close();
    }
  }

  /** Run fn inside a transaction (rolls back if it throws). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Returns the directory that contains the database file. */
  getDbDir(): string {
    return path.dirname(this.dbPath);
  }

  // ─── Node Operations ───────────────────────────────────────────────────────

  upsertNode(node: GraphNode): void {
    this.stmt(
      `INSERT INTO nodes (id, kind, name, file_path, description, is_external, language, meta, updated_at,
                          start_line, end_line, signature, doc, exported, modifiers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind        = excluded.kind,
         name        = excluded.name,
         file_path   = excluded.file_path,
         description = excluded.description,
         is_external = excluded.is_external,
         language    = excluded.language,
         meta        = excluded.meta,
         updated_at  = excluded.updated_at,
         start_line  = excluded.start_line,
         end_line    = excluded.end_line,
         signature   = excluded.signature,
         doc         = excluded.doc,
         exported    = excluded.exported,
         modifiers   = excluded.modifiers`,
    ).run(
      this.encId(node.id),
      node.kind,
      node.name,
      this.encPath(node.filePath),
      node.description,
      node.isExternal ? 1 : 0,
      node.language ?? null,
      node.meta,
      node.updatedAt,
      node.startLine ?? null,
      node.endLine ?? null,
      node.signature ?? null,
      node.doc ?? null,
      node.exported === undefined ? null : node.exported ? 1 : 0,
      node.modifiers && node.modifiers.length > 0 ? JSON.stringify(node.modifiers) : null,
    );
    const id = this.encId(node.id);
    const rowid = (this.stmt('SELECT rowid AS r FROM nodes WHERE id = ?').get(id) as Row)[
      'r'
    ] as number;
    this.writeFtsRow(rowid, { ...node, id, filePath: this.encPath(node.filePath) });
  }

  /** Replace the FTS row for a node (FTS rowid == nodes.rowid). Takes the stored id/path. */
  private writeFtsRow(
    rowid: number,
    n: Pick<GraphNode, 'id' | 'name' | 'filePath' | 'signature' | 'doc'>,
  ): void {
    this.stmt('DELETE FROM nodes_fts WHERE rowid = ?').run(rowid);
    this.stmt(
      `INSERT INTO nodes_fts (rowid, node_id, name, name_tokens, signature, doc, path_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowid,
      n.id,
      n.name,
      splitIdentifier(n.name),
      n.signature ?? '',
      n.doc ?? '',
      pathTokens(n.filePath),
    );
  }

  getNode(id: string): GraphNode | null {
    const row = this.stmt('SELECT * FROM nodes WHERE id = ?').get(this.encId(id)) as
      | Row
      | undefined;
    return row ? this.rowToNode(row) : null;
  }

  getNodesByFile(filePath: string): GraphNode[] {
    return (
      this.stmt('SELECT * FROM nodes WHERE file_path = ?').all(this.encPath(filePath)) as Row[]
    ).map((r) => this.rowToNode(r));
  }

  /** Fetch nodes by ID (chunked IN lists). Order is not guaranteed. */
  getNodesByIds(ids: string[]): GraphNode[] {
    const out: GraphNode[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK).map((id) => this.encId(id));
      const ph = chunk.map(() => '?').join(', ');
      const rows = this.stmt(`SELECT * FROM nodes WHERE id IN (${ph})`).all(...chunk) as Row[];
      for (const r of rows) out.push(this.rowToNode(r));
    }
    return out;
  }

  /** Exact, case-sensitive name lookup, optionally restricted to kinds. */
  getNodesByName(name: string, kinds?: NodeKind[]): GraphNode[] {
    let rows: Row[];
    if (kinds && kinds.length > 0) {
      const ph = kinds.map(() => '?').join(', ');
      rows = this.stmt(`SELECT * FROM nodes WHERE name = ? AND kind IN (${ph})`).all(
        name,
        ...kinds,
      ) as Row[];
    } else {
      rows = this.stmt('SELECT * FROM nodes WHERE name = ?').all(name) as Row[];
    }
    return rows.map((r) => this.rowToNode(r));
  }

  /** Ranked search (exact name > prefix > FTS5 BM25), deduped. See searchNodesRanked. */
  searchNodes(query: string, opts?: number | SearchOptions): GraphNode[] {
    const ranked = this.searchNodesRanked(query, opts);
    if (ranked.length === 0) return [];
    const byId = new Map(this.getNodesByIds(ranked.map((r) => r.id)).map((n) => [n.id, n]));
    const out: GraphNode[] = [];
    for (const r of ranked) {
      const n = byId.get(r.id);
      if (n) out.push(n);
    }
    return out;
  }

  /** Repopulate nodes_fts from nodes (external nodes included). */
  rebuildFts(): void {
    this.transaction(() => {
      this.stmt('DELETE FROM nodes_fts').run();
      const rows = this.stmt(
        'SELECT rowid AS r, id, name, file_path, signature, doc FROM nodes',
      ).all() as Row[];
      for (const r of rows) {
        this.writeFtsRow(r['r'] as number, {
          id: r['id'] as string,
          name: r['name'] as string,
          filePath: r['file_path'] as string,
          signature: (r['signature'] as string | null) ?? undefined,
          doc: (r['doc'] as string | null) ?? undefined,
        });
      }
    });
  }

  getNodesByKind(kinds: string[]): GraphNode[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(', ');
    return (
      this.stmt(`SELECT * FROM nodes WHERE kind IN (${placeholders}) ORDER BY name`).all(
        ...kinds,
      ) as Row[]
    ).map((r) => this.rowToNode(r));
  }

  getAllNodes(): GraphNode[] {
    return (this.stmt('SELECT * FROM nodes ORDER BY name').all() as Row[]).map((r) =>
      this.rowToNode(r),
    );
  }

  deleteNodesByFile(filePath: string): void {
    this.stmt(
      'DELETE FROM nodes_fts WHERE rowid IN (SELECT rowid FROM nodes WHERE file_path = ?)',
    ).run(this.encPath(filePath));
    this.stmt('DELETE FROM nodes WHERE file_path = ?').run(this.encPath(filePath));
  }

  // ─── Edge Operations ───────────────────────────────────────────────────────

  upsertEdge(edge: GraphEdge): void {
    this.stmt(
      `INSERT INTO edges (id, from_id, to_id, kind, reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         reason     = excluded.reason,
         updated_at = excluded.updated_at`,
    ).run(
      this.encEdgeId(edge.id),
      this.encId(edge.fromId),
      this.encId(edge.toId),
      edge.kind,
      edge.reason,
      edge.updatedAt,
    );
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return (
      this.stmt('SELECT * FROM edges WHERE from_id = ?').all(this.encId(nodeId)) as Row[]
    ).map((r) => this.rowToEdge(r));
  }

  getEdgesTo(nodeId: string): GraphEdge[] {
    return (this.stmt('SELECT * FROM edges WHERE to_id = ?').all(this.encId(nodeId)) as Row[]).map(
      (r) => this.rowToEdge(r),
    );
  }

  getEdgesFromByKind(nodeId: string, kind: string): GraphEdge[] {
    return (
      this.stmt('SELECT * FROM edges WHERE from_id = ? AND kind = ?').all(
        this.encId(nodeId),
        kind,
      ) as Row[]
    ).map((r) => this.rowToEdge(r));
  }

  getEdgesToByKind(nodeId: string, kind: string): GraphEdge[] {
    return (
      this.stmt('SELECT * FROM edges WHERE to_id = ? AND kind = ?').all(
        this.encId(nodeId),
        kind,
      ) as Row[]
    ).map((r) => this.rowToEdge(r));
  }

  /** Delete OUTGOING edges of every node in filePath. Incoming edges are kept. */
  deleteEdgesByFile(filePath: string): void {
    this.stmt('DELETE FROM edges WHERE from_id IN (SELECT id FROM nodes WHERE file_path = ?)').run(
      this.encPath(filePath),
    );
  }

  /** Delete edges whose from_id or to_id has no node. Returns the number removed. */
  deleteDanglingEdges(): number {
    const res = this.stmt(
      `DELETE FROM edges
       WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE nodes.id = edges.from_id)
          OR NOT EXISTS (SELECT 1 FROM nodes WHERE nodes.id = edges.to_id)`,
    ).run();
    return res.changes;
  }

  // ─── File Operations ───────────────────────────────────────────────────────

  upsertFile(record: FileRecord): void {
    this.stmt(
      `INSERT INTO files (file_path, language, content_hash, mtime, node_count, edge_count, parsed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         language     = excluded.language,
         content_hash = excluded.content_hash,
         mtime        = excluded.mtime,
         node_count   = excluded.node_count,
         edge_count   = excluded.edge_count,
         parsed_at    = excluded.parsed_at`,
    ).run(
      this.encPath(record.filePath),
      record.language,
      record.contentHash,
      record.mtime,
      record.nodeCount,
      record.edgeCount,
      record.parsedAt,
    );
  }

  getFile(filePath: string): FileRecord | null {
    const row = this.stmt('SELECT * FROM files WHERE file_path = ?').get(this.encPath(filePath)) as
      | Row
      | undefined;
    return row ? this.rowToFile(row) : null;
  }

  getAllFiles(): FileRecord[] {
    return (this.stmt('SELECT * FROM files ORDER BY file_path').all() as Row[]).map((r) =>
      this.rowToFile(r),
    );
  }

  deleteFile(filePath: string): void {
    this.deleteEdgesByFile(filePath);
    this.deleteNodesByFile(filePath);
    this.stmt('DELETE FROM files WHERE file_path = ?').run(this.encPath(filePath));
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  getStats(): { nodes: number; edges: number; files: number } {
    const n = this.stmt('SELECT COUNT(*) AS c FROM nodes').get() as Row;
    const e = this.stmt('SELECT COUNT(*) AS c FROM edges').get() as Row;
    const f = this.stmt('SELECT COUNT(*) AS c FROM files').get() as Row;
    return {
      nodes: (n['c'] as number) ?? 0,
      edges: (e['c'] as number) ?? 0,
      files: (f['c'] as number) ?? 0,
    };
  }

  getNodeCountByKind(): Record<string, number> {
    const rows = this.stmt('SELECT kind, COUNT(*) AS cnt FROM nodes GROUP BY kind').all() as Row[];
    return Object.fromEntries(rows.map((r) => [r['kind'] as string, r['cnt'] as number]));
  }

  getEdgeCountByKind(): Record<string, number> {
    const rows = this.stmt('SELECT kind, COUNT(*) AS cnt FROM edges GROUP BY kind').all() as Row[];
    return Object.fromEntries(rows.map((r) => [r['kind'] as string, r['cnt'] as number]));
  }

  // ─── All Edges (for traversal) ────────────────────────────────────────────

  getAllEdges(): GraphEdge[] {
    return (this.stmt('SELECT * FROM edges').all() as Row[]).map((r) => this.rowToEdge(r));
  }

  // ─── Ranked Search ─────────────────────────────────────────────────────────

  /**
   * Ranked search. Stages: exact name (1000), name prefix (500 - extra length),
   * FTS5 BM25 over token columns (100 / (1 + position)). Merged by id (best score),
   * ties broken by kind priority then shorter name. Externals excluded by default.
   */
  searchNodesRanked(
    query: string,
    opts?: number | SearchOptions,
  ): Array<{ id: string; score: number; matchedBy: 'exact' | 'prefix' | 'fts' }> {
    const o: SearchOptions = typeof opts === 'number' ? { limit: opts } : (opts ?? {});
    const limit = Math.max(1, Math.min(Math.floor(o.limit ?? 30), 500));
    const q = query.trim();
    if (!q) return [];

    let filter = '';
    const fparams: unknown[] = [];
    if (!o.includeExternal) filter += ' AND n.is_external = 0';
    if (o.kinds && o.kinds.length > 0) {
      filter += ` AND n.kind IN (${o.kinds.map(() => '?').join(', ')})`;
      fparams.push(...o.kinds);
    }

    type Hit = {
      id: string;
      name: string;
      kind: string;
      score: number;
      matchedBy: 'exact' | 'prefix' | 'fts';
    };
    const best = new Map<string, Hit>();
    const add = (r: Row, score: number, matchedBy: Hit['matchedBy']): void => {
      const id = this.decId(r['id'] as string);
      const prev = best.get(id);
      if (!prev || prev.score < score) {
        best.set(id, {
          id,
          name: r['name'] as string,
          kind: r['kind'] as string,
          score,
          matchedBy,
        });
      }
    };
    const run = (sql: string, ...params: unknown[]): Row[] => {
      try {
        return this.stmt(sql).all(...params) as Row[];
      } catch (err) {
        debug('search', 'query failed', err);
        return [];
      }
    };

    const esc = escapeLike(q);
    // 1. exact (also the last segment of Class.method names)
    for (const r of run(
      `SELECT n.id, n.name, n.kind FROM nodes n
       WHERE (n.name = ? COLLATE NOCASE OR n.name LIKE ? ESCAPE '\\')${filter} LIMIT ?`,
      q,
      `%.${esc}`,
      ...fparams,
      limit,
    )) {
      add(r, 1000, 'exact');
    }
    // 2. prefix
    for (const r of run(
      `SELECT n.id, n.name, n.kind FROM nodes n
       WHERE n.name LIKE ? ESCAPE '\\'${filter} ORDER BY length(n.name) LIMIT ?`,
      `${esc}%`,
      ...fparams,
      limit,
    )) {
      add(r, 500 - Math.min(Math.max((r['name'] as string).length - q.length, 0), 400), 'prefix');
    }
    // 3. FTS5 BM25 (AND of prefix tokens, then OR)
    const tokens = splitIdentifier(q.replace(/["*:()^-]/g, ' '))
      .split(' ')
      .filter(Boolean)
      .slice(0, 12);
    if (tokens.length > 0) {
      const quoted = tokens.map((t) => `"${t}"*`);
      const ftsSql = `SELECT n.id, n.name, n.kind FROM nodes_fts
         JOIN nodes n ON n.rowid = nodes_fts.rowid
         WHERE nodes_fts MATCH ?${filter}
         ORDER BY bm25(nodes_fts, 0, 10, 5, 2, 1, 1) LIMIT ?`;
      let rows = run(ftsSql, quoted.join(' '), ...fparams, limit);
      if (rows.length === 0 && quoted.length > 1) {
        rows = run(ftsSql, quoted.join(' OR '), ...fparams, limit);
      }
      rows.forEach((r, i) => add(r, 100 / (1 + i), 'fts'));
    }
    // 4. last resort: substring match on name (covers punctuation-only queries like "%")
    if (best.size === 0) {
      for (const r of run(
        `SELECT n.id, n.name, n.kind FROM nodes n
         WHERE n.name LIKE ? ESCAPE '\\'${filter} ORDER BY length(n.name) LIMIT ?`,
        `%${esc}%`,
        ...fparams,
        limit,
      )) {
        add(r, 10, 'fts');
      }
    }

    const prio = (k: string): number => {
      const i = KIND_PRIORITY.indexOf(k);
      return i < 0 ? KIND_PRIORITY.length : i;
    };
    return [...best.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          prio(a.kind) - prio(b.kind) ||
          a.name.length - b.name.length ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, limit)
      .map(({ id, score, matchedBy }) => ({ id, score, matchedBy }));
  }

  // ─── Embedding Operations ──────────────────────────────────────────────────

  upsertEmbedding(record: EmbeddingRecord): void {
    this.stmt(
      `INSERT INTO embeddings (node_id, vector, text_hash, provider)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         vector    = excluded.vector,
         text_hash = excluded.text_hash,
         provider  = excluded.provider`,
    ).run(this.encId(record.nodeId), Buffer.from(record.vector), record.textHash, record.provider);
  }

  getEmbedding(nodeId: string): EmbeddingRecord | null {
    const row = this.stmt('SELECT * FROM embeddings WHERE node_id = ?').get(this.encId(nodeId)) as
      | Row
      | undefined;
    return row ? this.rowToEmbedding(row) : null;
  }

  getAllEmbeddings(): EmbeddingRecord[] {
    return (this.stmt('SELECT * FROM embeddings').all() as Row[]).map((r) =>
      this.rowToEmbedding(r),
    );
  }

  deleteEmbedding(nodeId: string): void {
    this.stmt('DELETE FROM embeddings WHERE node_id = ?').run(this.encId(nodeId));
  }

  getEmbeddingCount(): number {
    return ((this.stmt('SELECT COUNT(*) AS c FROM embeddings').get() as Row)['c'] as number) ?? 0;
  }

  // ─── Community Operations ──────────────────────────────────────────────────

  upsertCommunity(community: Omit<CommunityRecord, 'id'>): number {
    const res = this.stmt(
      `INSERT INTO communities (name, level, parent_id, cohesion, size, dominant_language, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      community.name,
      community.level,
      community.parentId ?? null,
      community.cohesion,
      community.size,
      community.dominantLanguage ?? null,
      community.description,
      community.createdAt,
    );
    return Number(res.lastInsertRowid);
  }

  clearCommunities(): void {
    this.stmt('DELETE FROM communities').run();
    this.stmt('UPDATE nodes SET community_id = NULL').run();
  }

  updateNodeCommunity(nodeId: string, communityId: number | null): void {
    this.stmt('UPDATE nodes SET community_id = ? WHERE id = ?').run(
      communityId,
      this.encId(nodeId),
    );
  }

  getCommunities(level?: number): CommunityRecord[] {
    const rows =
      level !== undefined
        ? (this.stmt('SELECT * FROM communities WHERE level = ? ORDER BY size DESC').all(
            level,
          ) as Row[])
        : (this.stmt('SELECT * FROM communities ORDER BY level ASC, size DESC').all() as Row[]);
    return rows.map((r) => this.rowToCommunity(r));
  }

  getCommunityMembers(communityId: number): GraphNode[] {
    return (this.stmt('SELECT * FROM nodes WHERE community_id = ?').all(communityId) as Row[]).map(
      (r) => this.rowToNode(r),
    );
  }

  // ─── Row Mappers ───────────────────────────────────────────────────────────

  private rowToNode(obj: Row): GraphNode {
    return {
      id: this.decId(obj['id'] as string),
      kind: obj['kind'] as GraphNode['kind'],
      name: obj['name'] as string,
      filePath: this.decPath(obj['file_path'] as string),
      description: (obj['description'] as string) ?? '',
      isExternal: (obj['is_external'] as number) === 1,
      language: (obj['language'] as GraphNode['language']) ?? null,
      meta: (obj['meta'] as string) ?? '{}',
      updatedAt: obj['updated_at'] as number,
      ...optionalNodeFields(obj),
    };
  }

  private rowToEdge(obj: Row): GraphEdge {
    return {
      id: this.decEdgeId(obj['id'] as string),
      fromId: this.decId(obj['from_id'] as string),
      toId: this.decId(obj['to_id'] as string),
      kind: obj['kind'] as GraphEdge['kind'],
      reason: (obj['reason'] as string) ?? '',
      updatedAt: obj['updated_at'] as number,
    };
  }

  private rowToEmbedding(obj: Row): EmbeddingRecord {
    const v = obj['vector'] as Buffer;
    return {
      nodeId: this.decId(obj['node_id'] as string),
      // Copy into a standalone Uint8Array (Buffer may be a view into a shared pool)
      vector: new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)),
      textHash: obj['text_hash'] as string,
      provider: obj['provider'] as string,
    };
  }

  private rowToCommunity(obj: Row): CommunityRecord {
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

  private rowToFile(obj: Row): FileRecord {
    return {
      filePath: this.decPath(obj['file_path'] as string),
      language: obj['language'] as FileRecord['language'],
      contentHash: obj['content_hash'] as string,
      mtime: obj['mtime'] as number,
      nodeCount: obj['node_count'] as number,
      edgeCount: obj['edge_count'] as number,
      parsedAt: obj['parsed_at'] as number,
    };
  }
}
