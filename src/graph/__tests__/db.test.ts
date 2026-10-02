/**
 * Unit tests for GraphDb — SQLite persistence layer.
 * Uses a real in-memory / temp-dir DB backed by better-sqlite3 so we test
 * the actual SQL logic without mocking.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { GraphDb, SCHEMA_VERSION } from '../db.js';
import type { GraphNode, GraphEdge } from '../../types.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-test-'));
}

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'file:/tmp/a.ts',
    kind: 'file',
    name: 'a.ts',
    filePath: '/tmp/a.ts',
    description: 'test file',
    isExternal: false,
    language: 'typescript',
    meta: '{}',
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: 'file:/tmp/a.ts|imports|file:/tmp/b.ts',
    fromId: 'file:/tmp/a.ts',
    toId: 'file:/tmp/b.ts',
    kind: 'imports',
    reason: 'test import',
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('GraphDb', () => {
  let tmpDir: string;
  let db: GraphDb;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    db = new GraphDb(tmpDir);
    await db.init();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── init ──────────────────────────────────────────────────────────────────

  it('creates the .cgb directory and graph.db file', () => {
    const dbPath = path.join(tmpDir, '.cgb', 'graph.db');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  // ── nodes ─────────────────────────────────────────────────────────────────

  it('upsertNode / getNode roundtrip', () => {
    const node = makeNode();
    db.upsertNode(node);
    const fetched = db.getNode(node.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(node.id);
    expect(fetched!.name).toBe(node.name);
    expect(fetched!.isExternal).toBe(false);
  });

  it('returns null for missing node', () => {
    expect(db.getNode('file:/nonexistent')).toBeNull();
  });

  it('upsertNode overwrites existing node', () => {
    const node = makeNode();
    db.upsertNode(node);
    db.upsertNode({ ...node, name: 'updated.ts', description: 'updated' });
    const fetched = db.getNode(node.id);
    expect(fetched!.name).toBe('updated.ts');
    expect(fetched!.description).toBe('updated');
  });

  it('getNodesByFile returns all nodes for a file path', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(
      makeNode({ id: 'class:/tmp/a.ts#Foo', kind: 'class', name: 'Foo', filePath: '/tmp/a.ts' }),
    );
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    const nodes = db.getNodesByFile('/tmp/a.ts');
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.id)).toContain('file:/tmp/a.ts');
    expect(nodes.map((n) => n.id)).toContain('class:/tmp/a.ts#Foo');
  });

  it('deleteNodesByFile removes nodes for that file only', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.deleteNodesByFile('/tmp/a.ts');
    expect(db.getNode('file:/tmp/a.ts')).toBeNull();
    expect(db.getNode('file:/tmp/b.ts')).not.toBeNull();
  });

  it('searchNodes matches by name', () => {
    db.upsertNode(
      makeNode({ id: 'file:/tmp/graphdb.ts', name: 'GraphDb', filePath: '/tmp/graphdb.ts' }),
    );
    db.upsertNode(makeNode({ id: 'file:/tmp/other.ts', name: 'Other', filePath: '/tmp/other.ts' }));
    const results = db.searchNodes('GraphDb');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('GraphDb');
  });

  it('searchNodes matches by file path', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/special.ts', filePath: '/tmp/special.ts' }));
    const results = db.searchNodes('special');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // ── edges ─────────────────────────────────────────────────────────────────

  it('upsertEdge / getEdgesFrom roundtrip', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    const edge = makeEdge();
    db.upsertEdge(edge);
    const edges = db.getEdgesFrom('file:/tmp/a.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe(edge.id);
    expect(edges[0].kind).toBe('imports');
  });

  it('getEdgesTo returns edges pointing at the target', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.upsertEdge(makeEdge());
    const edges = db.getEdgesTo('file:/tmp/b.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].fromId).toBe('file:/tmp/a.ts');
  });

  it('getEdgesFromByKind filters by edge kind', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.upsertNode(
      makeNode({ id: 'class:/tmp/a.ts#Foo', kind: 'class', name: 'Foo', filePath: '/tmp/a.ts' }),
    );
    db.upsertEdge(
      makeEdge({ id: 'e1', kind: 'imports', fromId: 'file:/tmp/a.ts', toId: 'file:/tmp/b.ts' }),
    );
    db.upsertEdge(
      makeEdge({
        id: 'e2',
        kind: 'exports',
        fromId: 'file:/tmp/a.ts',
        toId: 'class:/tmp/a.ts#Foo',
      }),
    );

    const imports = db.getEdgesFromByKind('file:/tmp/a.ts', 'imports');
    expect(imports).toHaveLength(1);
    expect(imports[0].kind).toBe('imports');

    const exports = db.getEdgesFromByKind('file:/tmp/a.ts', 'exports');
    expect(exports).toHaveLength(1);
    expect(exports[0].kind).toBe('exports');
  });

  it('getEdgesToByKind filters by edge kind', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/c.ts', filePath: '/tmp/c.ts' }));
    db.upsertEdge(
      makeEdge({ id: 'e1', kind: 'imports', fromId: 'file:/tmp/a.ts', toId: 'file:/tmp/c.ts' }),
    );
    db.upsertEdge(
      makeEdge({ id: 'e2', kind: 'imports', fromId: 'file:/tmp/b.ts', toId: 'file:/tmp/c.ts' }),
    );

    const edges = db.getEdgesToByKind('file:/tmp/c.ts', 'imports');
    expect(edges).toHaveLength(2);
  });

  it('deleteNodesByFile cascades edge deletion via deleteEdgesByFile + deleteNodesByFile', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.upsertEdge(makeEdge());
    // Simulate what Parser.parseFile does when re-parsing a file
    db.deleteEdgesByFile('/tmp/a.ts');
    db.deleteNodesByFile('/tmp/a.ts');
    expect(db.getEdgesFrom('file:/tmp/a.ts')).toHaveLength(0);
  });

  // ── stats ─────────────────────────────────────────────────────────────────

  it('getStats returns correct counts', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.upsertEdge(makeEdge());

    const stats = db.getStats();
    expect(stats.nodes).toBe(2);
    expect(stats.edges).toBe(1);
  });

  it('getNodeCountByKind groups correctly', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', kind: 'file', filePath: '/tmp/a.ts' }));
    db.upsertNode(
      makeNode({ id: 'class:/tmp/a.ts#Foo', kind: 'class', name: 'Foo', filePath: '/tmp/a.ts' }),
    );
    db.upsertNode(
      makeNode({ id: 'class:/tmp/a.ts#Bar', kind: 'class', name: 'Bar', filePath: '/tmp/a.ts' }),
    );

    const counts = db.getNodeCountByKind();
    expect(counts['file']).toBe(1);
    expect(counts['class']).toBe(2);
  });

  // ── files ─────────────────────────────────────────────────────────────────

  it('upsertFile / getFile roundtrip', () => {
    db.upsertFile({
      filePath: '/tmp/a.ts',
      language: 'typescript',
      contentHash: 'abc123',
      mtime: 1000,
      nodeCount: 3,
      edgeCount: 2,
      parsedAt: Date.now(),
    });
    const file = db.getFile('/tmp/a.ts');
    expect(file).not.toBeNull();
    expect(file!.contentHash).toBe('abc123');
    expect(file!.language).toBe('typescript');
  });

  it('getAllNodes returns all stored nodes', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    const all = db.getAllNodes();
    expect(all.length).toBe(2);
  });

  it('getAllEdges returns all stored edges', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.upsertEdge(makeEdge());
    const all = db.getAllEdges();
    expect(all.length).toBe(1);
  });

  // -- slice 06 additions --------------------------------------------------

  it('transaction rolls back when fn throws', () => {
    expect(() =>
      db.transaction(() => {
        db.upsertNode(makeNode({ id: 'file:/tmp/t.ts', filePath: '/tmp/t.ts' }));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.getNode('file:/tmp/t.ts')).toBeNull();
  });

  it('transaction commits and returns value', () => {
    const r = db.transaction(() => {
      db.upsertNode(makeNode({ id: 'file:/tmp/t.ts', filePath: '/tmp/t.ts' }));
      return 42;
    });
    expect(r).toBe(42);
    expect(db.getNode('file:/tmp/t.ts')).not.toBeNull();
  });

  it('getNodesByIds handles 1200 ids (chunking)', () => {
    const ids: string[] = [];
    db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        const id = `function:/tmp/x.ts#f${i}`;
        ids.push(id);
        db.upsertNode(makeNode({ id, kind: 'function', name: `f${i}`, filePath: '/tmp/x.ts' }));
      }
    });
    const got = db.getNodesByIds([...ids, 'missing']);
    expect(got).toHaveLength(1200);
    expect(db.getNodesByIds([])).toEqual([]);
  });

  it('getNodesByName is exact, case-sensitive, with optional kinds', () => {
    db.upsertNode(makeNode({ id: 'class:/a#Foo', kind: 'class', name: 'Foo', filePath: '/a' }));
    db.upsertNode(
      makeNode({ id: 'function:/b#Foo', kind: 'function', name: 'Foo', filePath: '/b' }),
    );
    db.upsertNode(makeNode({ id: 'class:/c#foo', kind: 'class', name: 'foo', filePath: '/c' }));
    expect(db.getNodesByName('Foo')).toHaveLength(2);
    expect(db.getNodesByName('Foo', ['class'])).toHaveLength(1);
    expect(db.getNodesByName('Fo')).toHaveLength(0);
  });

  it('deleteEdgesByFile removes outgoing edges only and keeps incoming', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.upsertEdge(makeEdge({ id: 'a-b', fromId: 'file:/tmp/a.ts', toId: 'file:/tmp/b.ts' }));
    db.upsertEdge(makeEdge({ id: 'b-a', fromId: 'file:/tmp/b.ts', toId: 'file:/tmp/a.ts' }));
    db.deleteEdgesByFile('/tmp/a.ts');
    expect(db.getEdgesFrom('file:/tmp/a.ts')).toHaveLength(0);
    expect(db.getEdgesTo('file:/tmp/a.ts')).toHaveLength(1);
    // deleting the nodes too keeps the incoming edge (no cascade)
    db.deleteNodesByFile('/tmp/a.ts');
    expect(db.getEdgesTo('file:/tmp/a.ts')).toHaveLength(1);
  });

  it('deleteDanglingEdges removes edges with a missing endpoint and returns count', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.upsertEdge(makeEdge({ id: 'ok', fromId: 'file:/tmp/a.ts', toId: 'file:/tmp/b.ts' }));
    db.upsertEdge(makeEdge({ id: 'd1', fromId: 'file:/tmp/a.ts', toId: 'file:/gone' }));
    db.upsertEdge(makeEdge({ id: 'd2', fromId: 'file:/gone', toId: 'file:/tmp/b.ts' }));
    expect(db.deleteDanglingEdges()).toBe(2);
    expect(db.getAllEdges().map((e) => e.id)).toEqual(['ok']);
    expect(db.deleteDanglingEdges()).toBe(0);
  });

  it('searchNodes escapes LIKE wildcards', () => {
    db.upsertNode(makeNode({ id: 'n1', name: '100%_done', filePath: '/p1', description: '' }));
    db.upsertNode(makeNode({ id: 'n2', name: 'abcdef', filePath: '/p2', description: '' }));
    expect(db.searchNodes('%').map((n) => n.id)).toEqual(['n1']);
    expect(db.searchNodes('_').map((n) => n.id)).toEqual(['n1']);
    expect(db.searchNodesRanked('%').map((r) => r.id)).toEqual(['n1']);
  });

  it('searchNodesRanked ranks exact name above contains', () => {
    db.upsertNode(makeNode({ id: 'r1', name: 'myParser', filePath: '/r1' }));
    db.upsertNode(makeNode({ id: 'r2', name: 'parser', filePath: '/r2' }));
    const res = db.searchNodesRanked('parser');
    expect(res[0].id).toBe('r2');
    expect(res.map((r) => r.id)).toContain('r1');
  });

  it('embeddings roundtrip as bytes', () => {
    const vec = new Uint8Array(new Float32Array([1.5, -2, 3]).buffer);
    db.upsertEmbedding({ nodeId: 'n', vector: vec, textHash: 'h', provider: 'local' });
    const e = db.getEmbedding('n')!;
    expect(Array.from(new Float32Array(e.vector.buffer, e.vector.byteOffset, 3))).toEqual([
      1.5, -2, 3,
    ]);
    expect(db.getEmbeddingCount()).toBe(1);
  });

  it('close is idempotent and persist is a no-op', () => {
    db.persist();
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  it('recreates the DB on schema version mismatch (incl. legacy user_version 0)', async () => {
    db.upsertNode(makeNode());
    db.close();
    const dbPath = path.join(tmpDir, '.cgb', 'graph.db');
    const raw = new Database(dbPath);
    raw.pragma('user_version = 0');
    raw.close();
    const db2 = new GraphDb(tmpDir);
    await db2.init();
    expect(db2.getStats().nodes).toBe(0);
    db2.upsertNode(makeNode());
    expect(db2.getStats().nodes).toBe(1);
    db2.close();
    const chk = new Database(dbPath, { readonly: true });
    expect(chk.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    chk.close();
    db = new GraphDb(tmpDir);
    await db.init();
    expect(db.getStats().nodes).toBe(1); // matching version is preserved
  });

  it('two instances on the same root: reader sees writes (WAL)', async () => {
    const reader = new GraphDb(tmpDir);
    await reader.init();
    db.upsertNode(makeNode({ id: 'w1', filePath: '/w' }));
    expect(reader.getNode('w1')).not.toBeNull();
    db.transaction(() => {
      db.upsertNode(makeNode({ id: 'w2', filePath: '/w' }));
      expect(reader.getNode('w1')).not.toBeNull();
      expect(reader.getNode('w2')).toBeNull();
    });
    expect(reader.getNode('w2')).not.toBeNull();
    reader.close();
  });
  describe('schema v2 metadata + FTS', () => {
    const ftsCount = (): number => {
      const raw = new Database(path.join(tmpDir, '.cgb', 'graph.db'), { readonly: true });
      const c = (raw.prepare('SELECT COUNT(*) AS c FROM nodes_fts').get() as { c: number }).c;
      raw.close();
      return c;
    };

    it('round-trips the new fields and leaves them undefined when NULL', () => {
      db.upsertNode(
        makeNode({
          id: 'function:/p/a.ts#find',
          kind: 'function',
          name: 'find',
          startLine: 10,
          endLine: 20,
          signature: 'async find(id: string): Promise<User | null>',
          doc: 'Find a user.',
          exported: true,
          modifiers: ['async', 'static'],
        }),
      );
      db.upsertNode(makeNode({ id: 'plain' }));
      const n = db.getNode('function:/p/a.ts#find')!;
      expect(n.startLine).toBe(10);
      expect(n.endLine).toBe(20);
      expect(n.signature).toBe('async find(id: string): Promise<User | null>');
      expect(n.doc).toBe('Find a user.');
      expect(n.exported).toBe(true);
      expect(n.modifiers).toEqual(['async', 'static']);
      const p = db.getNode('plain')!;
      expect(p.startLine).toBeUndefined();
      expect(p.signature).toBeUndefined();
      expect(p.modifiers).toBeUndefined();
      expect(p.exported).toBeUndefined();
    });

    it('keeps one FTS row per node, replaced on upsert and removed by deleteNodesByFile', () => {
      db.upsertNode(makeNode({ id: 'a1', name: 'parseFile', filePath: '/p/x.ts' }));
      db.upsertNode(makeNode({ id: 'a1', name: 'parseFile', filePath: '/p/x.ts', doc: 'changed' }));
      db.upsertNode(makeNode({ id: 'b1', name: 'other', filePath: '/p/y.ts', isExternal: true }));
      expect(ftsCount()).toBe(2);
      db.deleteNodesByFile('/p/x.ts');
      expect(ftsCount()).toBe(1);
    });

    it('rebuildFts count equals nodes count', () => {
      for (let i = 0; i < 5; i++) db.upsertNode(makeNode({ id: 'n' + i, name: 'Node' + i }));
      db.rebuildFts();
      expect(ftsCount()).toBe(db.getStats().nodes);
      db.rebuildFts();
      expect(ftsCount()).toBe(5);
    });

    it('tokenises name and path for matching', () => {
      db.upsertNode(
        makeNode({ id: 'z', name: 'parseFileAsync', filePath: '/r/src/graph/db_utils.ts' }),
      );
      const raw = new Database(path.join(tmpDir, '.cgb', 'graph.db'), { readonly: true });
      const hit = raw
        .prepare(
          "SELECT node_id FROM nodes_fts WHERE nodes_fts MATCH 'name_tokens:async AND path_tokens:utils'",
        )
        .all();
      raw.close();
      expect(hit).toHaveLength(1);
    });

    it('recreates a v1 database (no new columns, no FTS table)', async () => {
      db.close();
      const dbPath = path.join(tmpDir, '.cgb', 'graph.db');
      const raw = new Database(dbPath);
      raw.exec('DROP TABLE nodes_fts; DROP TABLE nodes;');
      raw.exec(
        'CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, file_path TEXT NOT NULL, description TEXT NOT NULL DEFAULT "", is_external INTEGER NOT NULL DEFAULT 0, language TEXT, meta TEXT NOT NULL DEFAULT "{}", updated_at INTEGER NOT NULL, community_id INTEGER)',
      );
      raw.pragma('user_version = 1');
      raw.close();
      const db2 = new GraphDb(tmpDir);
      await db2.init();
      db2.upsertNode(makeNode({ startLine: 3, signature: 's' }));
      expect(db2.getNode('file:/tmp/a.ts')!.startLine).toBe(3);
      db2.close();
      expect(ftsCount()).toBe(1);
      db = new GraphDb(tmpDir);
      await db.init();
    });
  });
});
