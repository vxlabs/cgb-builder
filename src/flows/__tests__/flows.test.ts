import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../../graph/db.js';
import { FlowsAnalyzer, findLargeFunctions } from '../index.js';
import type { GraphNode, GraphEdge } from '../../types.js';

function node(o: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return {
    kind: 'function',
    filePath: '/repo/src/x.ts',
    description: '',
    isExternal: false,
    language: 'typescript',
    meta: '{}',
    updatedAt: 1,
    ...o,
  };
}

function calls(from: string, to: string): GraphEdge {
  return {
    id: `${from}|calls|${to}`,
    fromId: from,
    toId: to,
    kind: 'calls',
    reason: 'call',
    updatedAt: 1,
  } as GraphEdge;
}

describe('flows', () => {
  let dir: string;
  let db: GraphDb;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-flows-'));
    db = new GraphDb(dir);
    await db.init();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('findLargeFunctions', () => {
    it('ranks by LOC and returns loc, signature and range', () => {
      db.upsertNode(
        node({ id: 'f:small', name: 'small', startLine: 1, endLine: 5, signature: 'small()' }),
      );
      db.upsertNode(
        node({
          id: 'f:big',
          name: 'big',
          startLine: 10,
          endLine: 109,
          signature: 'big(a: number)',
        }),
      );
      db.upsertNode(node({ id: 'f:mid', name: 'mid', startLine: 20, endLine: 49 }));
      // High connectivity must not outrank a longer function
      for (let i = 0; i < 5; i++) {
        db.upsertNode(node({ id: `f:c${i}`, name: `c${i}`, startLine: 1, endLine: 1 }));
        db.upsertEdge(calls(`f:c${i}`, 'f:small'));
        db.upsertEdge(calls('f:small', `f:c${i}`));
      }
      const res = findLargeFunctions(db, 3);
      expect(res.map((r) => r.name)).toEqual(['big', 'mid', 'small']);
      expect(res[0]).toMatchObject({
        loc: 100,
        signature: 'big(a: number)',
        startLine: 10,
        endLine: 109,
      });
      expect(res[2].fanOut).toBe(5);
    });

    it('falls back to connectivity for nodes without ranges, ranked after ranged ones', () => {
      db.upsertNode(node({ id: 'f:a', name: 'a' }));
      db.upsertNode(node({ id: 'f:b', name: 'b' }));
      db.upsertNode(node({ id: 'f:r', name: 'r', startLine: 1, endLine: 2 }));
      db.upsertEdge(calls('f:b', 'f:a'));
      db.upsertEdge(calls('f:b', 'f:r'));
      const res = findLargeFunctions(db, 10);
      expect(res.map((r) => r.name)).toEqual(['r', 'b', 'a']);
      expect(res[1].loc).toBeUndefined();
    });
  });

  describe('entryPoints', () => {
    it('ranks exported zero-caller functions before other no-caller nodes', () => {
      db.upsertNode(
        node({
          id: 'f:pub',
          name: 'pub',
          exported: true,
          startLine: 1,
          endLine: 3,
          signature: 'pub()',
        }),
      );
      db.upsertNode(node({ id: 'f:priv', name: 'priv', exported: false }));
      db.upsertNode(node({ id: 'f:callee', name: 'callee', exported: true }));
      db.upsertEdge(calls('f:priv', 'f:callee'));
      const res = new FlowsAnalyzer(db).entryPoints();
      const names = res.map((r) => r.name);
      expect(names).not.toContain('callee');
      expect(names[0]).toBe('pub');
      expect(res[0]).toMatchObject({ exported: true, signature: 'pub()', startLine: 1 });
      expect(names).toContain('priv');
    });

    it('still works when nodes have no export info or ranges', () => {
      db.upsertNode(node({ id: 'f:x', name: 'x' }));
      db.upsertNode(node({ id: 'f:y', name: 'y' }));
      db.upsertEdge(calls('f:x', 'f:y'));
      const res = new FlowsAnalyzer(db).entryPoints();
      expect(res.map((r) => r.name)).toEqual(['x']);
      expect(res[0].signature).toBeUndefined();
    });
  });

  it('callChain items carry signature and startLine when available', () => {
    db.upsertNode(node({ id: 'f:a', name: 'a', signature: 'a()', startLine: 3, endLine: 4 }));
    db.upsertNode(node({ id: 'f:b', name: 'b' }));
    db.upsertEdge(calls('f:a', 'f:b'));
    const chain = new FlowsAnalyzer(db).callChain('f:a');
    expect(chain[0]).toMatchObject({ name: 'a', signature: 'a()', startLine: 3 });
    expect(chain[1].signature).toBeUndefined();
  });
});
