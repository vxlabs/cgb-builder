import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDb } from '../../graph/db';
import { handleTool } from '../server';
import type { GraphNode, GraphEdge } from '../../types';

let root: string;
let emptyRoot: string;
const savedRoot = process.env.CGB_ROOT;

function fileNode(abs: string): GraphNode {
  return {
    id: `file:${abs}`,
    kind: 'file',
    name: path.basename(abs),
    filePath: abs,
    description: '',
    isExternal: false,
    language: 'typescript',
    meta: '{}',
    updatedAt: 1,
  };
}

function edge(from: string, to: string, kind: GraphEdge['kind'] = 'imports'): GraphEdge {
  return { id: `${from}|${kind}|${to}`, fromId: from, toId: to, kind, reason: '', updatedAt: 1 };
}

async function seed(dir: string): Promise<void> {
  const db = new GraphDb(dir);
  await db.init();
  const corePath = path.join(dir, 'src', 'core.ts');
  const core = fileNode(corePath);
  db.upsertNode(core);
  // 60 files import core, so impact has more than one page of results.
  for (let i = 0; i < 60; i++) {
    const f = fileNode(path.join(dir, 'src', `user${i}.ts`));
    db.upsertNode(f);
    db.upsertEdge(edge(f.id, core.id));
  }
  db.upsertNode({
    ...core,
    id: `function:${corePath}#coreFn`,
    kind: 'function',
    name: 'coreFn',
    description: 'core function',
  });
  db.close();
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-mcp-'));
  emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-mcp-empty-'));
  await seed(root);
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.CGB_ROOT;
  else process.env.CGB_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(emptyRoot, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.CGB_ROOT = root;
});

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('MCP handlers', () => {
  it('uses CGB_ROOT when root is omitted, and emits compact JSON', async () => {
    const r = await handleTool('cgb_stats', {});
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).not.toContain('\n');
    expect(json(r).nodes).toBe(62);
  });

  it('explicit root overrides CGB_ROOT', async () => {
    process.env.CGB_ROOT = emptyRoot;
    const r = await handleTool('cgb_stats', { root });
    expect(r.isError).toBeFalsy();
    expect(json(r).nodes).toBe(62);
  });

  it('returns repo-relative files but absolute ids', async () => {
    const r = json(await handleTool('cgb_search', { query: 'core' }));
    const item = r.items.find((i: { name: string }) => i.name === 'coreFn');
    expect(item.file).toBe('src/core.ts');
    expect(item.id).toContain(root);
    expect(item).not.toHaveProperty('filePath');
  });

  it('accepts repo-relative node ids', async () => {
    const r = await handleTool('cgb_rename_preview', { nodeId: 'function:src/core.ts#coreFn' });
    expect(r.isError).toBeFalsy();
  });

  it('paginates with total/returned/offset/truncated', async () => {
    const first = json(await handleTool('cgb_impact', { target: 'src/core.ts' }));
    expect(first).toMatchObject({ total: 60, returned: 50, offset: 0, truncated: true });
    expect(first.items[0].file).toMatch(/^src\/user\d+\.ts$/);
    const second = json(
      await handleTool('cgb_impact', { target: 'src/core.ts', offset: 50, limit: 50 }),
    );
    expect(second).toMatchObject({ total: 60, returned: 10, offset: 50, truncated: false });
    const small = json(await handleTool('cgb_impact', { target: 'src/core.ts', limit: 5 }));
    expect(small.returned).toBe(5);
  });

  it('reports an empty graph with a hint', async () => {
    const r = await handleTool('cgb_stats', { root: emptyRoot });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Graph not built for');
    expect(r.content[0].text).toContain('Call cgb_init first');
  });

  it('closes every DB handle it opens, including on error paths', async () => {
    const closeSpy = jest.spyOn(GraphDb.prototype, 'close');
    const calls = 50;
    for (let i = 0; i < calls; i++) {
      await handleTool('cgb_stats', {});
      await handleTool('cgb_impact', { target: 'src/missing.ts' }); // error path
      await handleTool('cgb_embed_similar', { nodeId: 'function:src/core.ts#coreFn' });
    }
    const closes = closeSpy.mock.calls.length;
    closeSpy.mockRestore();
    expect(closes).toBe(calls * 3);
  });

  it('returns an error result for unknown tools', async () => {
    const r = await handleTool('cgb_nope', {});
    expect(r.isError).toBe(true);
  });
});
