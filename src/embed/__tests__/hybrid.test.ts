import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../../graph/db.js';
import { hybridSearch, encodeVector } from '../index.js';
import type { GraphNode } from '../../types.js';

function node(id: string, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'function',
    name,
    filePath: `/repo/${name}.ts`,
    description: '',
    isExternal: false,
    language: 'typescript',
    meta: '{}',
    updatedAt: 1,
    ...extra,
  };
}

describe('hybridSearch', () => {
  let dir: string;
  let db: GraphDb;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-hybrid-'));
    db = new GraphDb(dir);
    await db.init();
    db.upsertNode(node('f:parseFile', 'parseFile'));
    db.upsertNode(node('f:parseFileAsync', 'parseFileAsync'));
    db.upsertNode(node('f:unrelated', 'unrelated'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('works lexically with zero embeddings', async () => {
    expect(db.getEmbeddingCount()).toBe(0);
    const res = await hybridSearch(db, 'parseFile');
    expect(res[0].id).toBe('f:parseFile');
    expect(res.map((r) => r.id)).toContain('f:parseFileAsync');
    expect(res.map((r) => r.id)).not.toContain('f:unrelated');
  });

  it('fuses vector hits with lexical hits when embeddings exist', async () => {
    const e = (nodeId: string, v: number[]) =>
      db.upsertEmbedding({ nodeId, vector: encodeVector(v), textHash: 'h', provider: 'fake' });
    e('f:parseFile', [1, 0, 0]);
    e('f:parseFileAsync', [0.9, 0.1, 0]);
    e('f:unrelated', [0.8, 0.2, 0]);
    const res = await hybridSearch(db, 'parseFile');
    expect(res[0].id).toBe('f:parseFile');
    // vector leg pulls in the lexically unrelated node
    expect(res.map((r) => r.id)).toContain('f:unrelated');
    const ids = res.map((r) => r.id);
    expect(ids.indexOf('f:parseFileAsync')).toBeLessThan(ids.indexOf('f:unrelated'));
  });
});
