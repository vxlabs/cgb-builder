/**
 * Unit tests for GraphDb — SQLite persistence layer.
 * Uses a real in-memory / temp-dir DB backed by sql.js (WASM) so we test
 * the actual SQL logic without mocking.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../db.js';
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
    db.upsertNode(makeNode({ id: 'class:/tmp/a.ts#Foo', kind: 'class', name: 'Foo', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    const nodes = db.getNodesByFile('/tmp/a.ts');
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.id)).toContain('file:/tmp/a.ts');
    expect(nodes.map(n => n.id)).toContain('class:/tmp/a.ts#Foo');
  });

  it('deleteNodesByFile removes nodes for that file only', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/a.ts', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'file:/tmp/b.ts', filePath: '/tmp/b.ts' }));
    db.deleteNodesByFile('/tmp/a.ts');
    expect(db.getNode('file:/tmp/a.ts')).toBeNull();
    expect(db.getNode('file:/tmp/b.ts')).not.toBeNull();
  });

  it('searchNodes matches by name', () => {
    db.upsertNode(makeNode({ id: 'file:/tmp/graphdb.ts', name: 'GraphDb', filePath: '/tmp/graphdb.ts' }));
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
    db.upsertNode(makeNode({ id: 'class:/tmp/a.ts#Foo', kind: 'class', name: 'Foo', filePath: '/tmp/a.ts' }));
    db.upsertEdge(makeEdge({ id: 'e1', kind: 'imports', fromId: 'file:/tmp/a.ts', toId: 'file:/tmp/b.ts' }));
    db.upsertEdge(makeEdge({ id: 'e2', kind: 'exports', fromId: 'file:/tmp/a.ts', toId: 'class:/tmp/a.ts#Foo' }));

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
    db.upsertEdge(makeEdge({ id: 'e1', kind: 'imports', fromId: 'file:/tmp/a.ts', toId: 'file:/tmp/c.ts' }));
    db.upsertEdge(makeEdge({ id: 'e2', kind: 'imports', fromId: 'file:/tmp/b.ts', toId: 'file:/tmp/c.ts' }));

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
    db.upsertNode(makeNode({ id: 'class:/tmp/a.ts#Foo', kind: 'class', name: 'Foo', filePath: '/tmp/a.ts' }));
    db.upsertNode(makeNode({ id: 'class:/tmp/a.ts#Bar', kind: 'class', name: 'Bar', filePath: '/tmp/a.ts' }));

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
});
