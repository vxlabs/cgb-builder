import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../db.js';
import type { GraphNode } from '../../types.js';

function node(o: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return {
    kind: 'class',
    filePath: '/repo/src/x.ts',
    description: '',
    isExternal: false,
    language: 'typescript',
    meta: '{}',
    updatedAt: 1,
    ...o,
  };
}

describe('ranked search', () => {
  let dir: string;
  let db: GraphDb;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-search-'));
    db = new GraphDb(dir);
    await db.init();
    db.upsertNode(
      node({ id: 'class:GraphDb', name: 'GraphDb', filePath: '/repo/src/graph/db.ts' }),
    );
    db.upsertNode(
      node({
        id: 'class:GraphDbOptions',
        name: 'GraphDbOptions',
        kind: 'interface',
        filePath: '/repo/src/graph/db.ts',
      }),
    );
    db.upsertNode(
      node({
        id: 'class:WikiGenerator',
        name: 'WikiGenerator',
        filePath: '/repo/src/wiki/index.ts',
        doc: 'Generates wiki pages from the graph db contents',
      }),
    );
    db.upsertNode(
      node({
        id: 'method:GraphEngine.search',
        name: 'GraphEngine.search',
        kind: 'method',
        filePath: '/repo/src/graph/engine.ts',
      }),
    );
    db.upsertNode(
      node({
        id: 'ext:graphology',
        name: 'graphology',
        kind: 'external_dep',
        isExternal: true,
        filePath: '',
      }),
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const names = (q: string, o?: Parameters<GraphDb['searchNodes']>[1]) =>
    db.searchNodes(q, o).map((n) => n.name);

  it('ranks the exact class first', () => {
    expect(names('GraphDb')[0]).toBe('GraphDb');
    expect(db.searchNodesRanked('GraphDb')[0]).toMatchObject({
      id: 'class:GraphDb',
      matchedBy: 'exact',
      score: 1000,
    });
  });

  it('is case-insensitive', () => {
    expect(names('graphdb')[0]).toBe('GraphDb');
  });

  it('finds both GraphDb nodes ahead of WikiGenerator for "graph db"', () => {
    const res = names('graph db');
    const wiki = res.indexOf('WikiGenerator');
    expect(res.indexOf('GraphDb')).toBeGreaterThanOrEqual(0);
    expect(res.indexOf('GraphDbOptions')).toBeGreaterThanOrEqual(0);
    if (wiki >= 0) {
      expect(res.indexOf('GraphDb')).toBeLessThan(wiki);
      expect(res.indexOf('GraphDbOptions')).toBeLessThan(wiki);
    }
  });

  it('matches the last segment of a method name', () => {
    expect(names('search')[0]).toBe('GraphEngine.search');
  });

  it('filters by kinds', () => {
    expect(names('graph', { kinds: ['interface'] })).toEqual(['GraphDbOptions']);
  });

  it('excludes externals by default and includes on request', () => {
    expect(names('graphology')).toEqual([]);
    expect(names('graphology', { includeExternal: true })).toEqual(['graphology']);
  });

  it('accepts a numeric limit and clamps', () => {
    expect(db.searchNodesRanked('graph', 1)).toHaveLength(1);
    expect(db.searchNodesRanked('graph', { limit: 0 }).length).toBeLessThanOrEqual(1);
  });

  it.each(['a:b(', '%', '-x', '"', '*', '^^', 'x AND', ''])('does not throw on %j', (q) => {
    expect(() => db.searchNodes(q)).not.toThrow();
    expect(() => db.searchNodesRanked(q)).not.toThrow();
  });
});
