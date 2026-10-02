import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDb } from '../../graph/db';
import { Parser } from '../../parser/index';
import { handleTool } from '../server';
import { resetFreshnessThrottle } from '../freshness';

let root: string;
const savedRoot = process.env.CGB_ROOT;
const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const abs = (f: string) => path.join(root, f);

const C_TS = "import { mid } from './b';\nexport function top() {\n  return mid();\n}\n";

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-tools-'));
  fs.mkdirSync(abs('src'));
  fs.writeFileSync(abs('src/a.ts'), 'export function helper(x: number) {\n  return x + 1;\n}\n');
  fs.writeFileSync(
    abs('src/b.ts'),
    "import { helper } from './a';\nexport function mid() {\n  return helper(1);\n}\nexport function helperExtra() {\n  return 0;\n}\n",
  );
  fs.writeFileSync(abs('src/c.ts'), C_TS);
  const db = new GraphDb(root);
  await db.init();
  await new Parser(db, root).scanAll();
  // Fixture fields so these tests do not depend on adapter output for lines/signature.
  const helper = db.getNodesByName('helper', ['function'])[0];
  db.upsertNode({
    ...helper,
    startLine: 1,
    endLine: 3,
    signature: 'function helper(x: number)',
    exported: true,
  });
  db.close();
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.CGB_ROOT;
  else process.env.CGB_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.CGB_ROOT = root;
  resetFreshnessThrottle();
});

describe('cgb_symbol', () => {
  it('looks up by name with lines, signature, callers and readHint', async () => {
    const r = json(await handleTool('cgb_symbol', { name: 'helper' }));
    const item = r.items[0];
    expect(item).toMatchObject({
      name: 'helper',
      kind: 'function',
      file: 'src/a.ts',
      lines: '1-3',
      sig: 'function helper(x: number)',
      matchedBy: 'exact',
      readHint: 'Read src/a.ts lines 1-3',
    });
    expect(item.callers).toBe(1);
    expect(item.topCallers[0]).toMatchObject({ name: 'mid', file: 'src/b.ts' });
    expect(item.callees).toBe(0);
  });

  it('accepts a repo-relative id and reports callees', async () => {
    const r = json(await handleTool('cgb_symbol', { id: 'function:src/b.ts#mid' }));
    expect(r.items[0].name).toBe('mid');
    expect(r.items[0].topCallees.map((n: { name: string }) => n.name)).toEqual(['helper']);
  });

  it('falls back to ranked search and filters by file', async () => {
    const r = json(await handleTool('cgb_symbol', { name: 'help' }));
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0].matchedBy).not.toBe('exact');
    const none = await handleTool('cgb_symbol', { name: 'helper', file: 'src/c.ts' });
    expect(none.isError).toBe(true);
  });

  it('errors without name or id', async () => {
    expect((await handleTool('cgb_symbol', {})).isError).toBe(true);
  });
});

describe('cgb_callers / cgb_callees', () => {
  it('walks callers to depth 2 with depth and via', async () => {
    const r = json(await handleTool('cgb_callers', { id: 'function:src/a.ts#helper', depth: 2 }));
    const byName = Object.fromEntries(r.items.map((i: { name: string }) => [i.name, i]));
    expect(byName.mid.depth).toBe(1);
    expect(byName.top.depth).toBe(2);
    expect(byName.top.via).toContain('mid');
    expect(r.total).toBe(2);
  });

  it('depth 1 stops at direct callers', async () => {
    const r = json(await handleTool('cgb_callers', { id: 'function:src/a.ts#helper' }));
    expect(r.items.map((i: { name: string }) => i.name)).toEqual(['mid']);
  });

  it('walks callees', async () => {
    const r = json(await handleTool('cgb_callees', { id: 'function:src/c.ts#top', depth: 3 }));
    expect(r.items.map((i: { name: string; depth: number }) => `${i.name}@${i.depth}`)).toEqual([
      'mid@1',
      'helper@2',
    ]);
  });

  it('errors on an unknown id', async () => {
    const r = await handleTool('cgb_callers', { id: 'function:src/nope.ts#x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('cgb_symbol');
  });
});

describe('cgb_search', () => {
  it('puts the exact match before prefix matches and reports matchedBy', async () => {
    const r = json(await handleTool('cgb_search', { query: 'helper' }));
    expect(r.items[0]).toMatchObject({ name: 'helper', matchedBy: 'exact' });
    expect(typeof r.items[0].score).toBe('number');
    const extra = r.items.find((i: { name: string }) => i.name === 'helperExtra');
    expect(extra.matchedBy).toBe('prefix');
  });

  it('filters by kinds', async () => {
    const r = json(await handleTool('cgb_search', { query: 'helper', kinds: ['class'] }));
    expect(r.total).toBe(0);
  });

  it('cgb_embed_search is an alias returning the same result', async () => {
    const a = await handleTool('cgb_search', { query: 'helper' });
    const b = await handleTool('cgb_embed_search', { query: 'helper' });
    expect(b.content[0].text).toBe(a.content[0].text);
  });

  it('semantic:true works without embeddings (lexical fallback)', async () => {
    const r = json(await handleTool('cgb_search', { query: 'helper', semantic: true }));
    expect(r.items[0].name).toBe('helper');
    expect(r.items[0].matchedBy).toBe('hybrid');
  });
});

describe('auto-freshness through handlers', () => {
  const touchFuture = (f: string, ms: number) => {
    const t = new Date(Date.now() + ms);
    fs.utimesSync(abs(f), t, t);
  };

  it('reflects an edit without cgb_init', async () => {
    expect((await handleTool('cgb_symbol', { name: 'zzbrandfn' })).isError).toBe(true);

    fs.writeFileSync(abs('src/c.ts'), C_TS + 'export function zzbrandfn() {\n  return 1;\n}\n');
    touchFuture('src/c.ts', 5000);
    resetFreshnessThrottle();

    const hit = json(await handleTool('cgb_symbol', { name: 'zzbrandfn' }));
    expect(hit.items[0]).toMatchObject({ name: 'zzbrandfn', file: 'src/c.ts' });
  });

  it('can be disabled with CGB_NO_AUTOREFRESH=1', async () => {
    fs.appendFileSync(abs('src/c.ts'), 'export function zzqxUniq() {}\n');
    touchFuture('src/c.ts', 10000);
    resetFreshnessThrottle();
    process.env.CGB_NO_AUTOREFRESH = '1';
    try {
      expect((await handleTool('cgb_symbol', { name: 'zzqxUniq' })).isError).toBe(true);
    } finally {
      delete process.env.CGB_NO_AUTOREFRESH;
    }
    resetFreshnessThrottle();
    expect(json(await handleTool('cgb_symbol', { name: 'zzqxUniq' })).items[0].name).toBe(
      'zzqxUniq',
    );
  });
});
