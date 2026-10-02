import * as path from 'path';
import { resolveRoot, rel, expandId, compactNode, page, ok, err, relPaths } from '../format';
import type { GraphNode } from '../../types';

const root = path.resolve('/proj/repo');
const abs = (p: string) => path.join(root, p);

function node(over: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `function:${abs('src/a.ts')}#foo`,
    kind: 'function',
    name: 'foo',
    filePath: abs('src/a.ts'),
    description: '',
    isExternal: false,
    language: 'typescript',
    meta: '{}',
    updatedAt: 0,
    ...over,
  };
}

describe('resolveRoot', () => {
  const saved = process.env.CGB_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.CGB_ROOT;
    else process.env.CGB_ROOT = saved;
  });

  it('prefers args.root, then CGB_ROOT, then cwd', () => {
    process.env.CGB_ROOT = abs('env');
    expect(resolveRoot({ root: abs('arg') })).toBe(abs('arg'));
    expect(resolveRoot({})).toBe(abs('env'));
    delete process.env.CGB_ROOT;
    expect(resolveRoot({})).toBe(process.cwd());
  });
});

describe('rel', () => {
  it('makes paths repo-relative with forward slashes', () => {
    expect(rel(root, abs('src/a/b.ts'))).toBe('src/a/b.ts');
  });
  it('leaves externals and outside paths unchanged', () => {
    expect(rel(root, 'lodash')).toBe('lodash');
    const outside = path.resolve('/elsewhere/x.ts');
    expect(rel(root, outside)).toBe(outside);
  });
});

describe('expandId', () => {
  it('expands repo-relative ids', () => {
    expect(expandId(root, 'function:src/a.ts#foo')).toBe(`function:${abs('src/a.ts')}#foo`);
    expect(expandId(root, 'file:src/a.ts')).toBe(`file:${abs('src/a.ts')}`);
  });
  it('passes absolute and external ids through', () => {
    const id = `class:${abs('src/a.ts')}#A`;
    expect(expandId(root, id)).toBe(id);
    expect(expandId(root, 'external_dep:lodash')).toBe('external_dep:lodash');
    expect(expandId(root, 'nonsense')).toBe('nonsense');
  });
});

describe('compactNode', () => {
  it('uses relative file, absolute id, and omits empty fields', () => {
    const c = compactNode(root, node());
    expect(c).toEqual({ id: node().id, kind: 'function', name: 'foo', file: 'src/a.ts' });
  });
  it('includes lines, sig, doc and exported when available', () => {
    const c = compactNode(
      root,
      node({
        description: 'does foo',
        meta: JSON.stringify({ startLine: 12, endLine: 40, signature: '(): void', exported: true }),
      }),
    );
    expect(c.lines).toBe('12-40');
    expect(c.sig).toBe('(): void');
    expect(c.doc).toBe('does foo');
    expect(c.exported).toBe(true);
  });
  it('keeps external package names', () => {
    const c = compactNode(
      root,
      node({ kind: 'external_dep', filePath: 'lodash', isExternal: true }),
    );
    expect(c.file).toBe('lodash');
  });
});

describe('page', () => {
  const items = Array.from({ length: 120 }, (_, i) => i);
  it('defaults to 50 and reports truncation', () => {
    const p = page(items, {});
    expect(p).toMatchObject({ total: 120, returned: 50, offset: 0, truncated: true });
  });
  it('honours offset and limit', () => {
    const p = page(items, { limit: 10, offset: 115 });
    expect(p.items).toEqual([115, 116, 117, 118, 119]);
    expect(p.truncated).toBe(false);
  });
  it('caps limit at 500 and clamps bad input', () => {
    expect(page(items, { limit: 9999 }).returned).toBe(120);
    expect(page(items, { limit: -3, offset: -5 })).toMatchObject({ returned: 1, offset: 0 });
    expect(page(items, { limit: NaN }).returned).toBe(50);
  });
  it('respects a custom default limit', () => {
    expect(page(items, {}, 5).returned).toBe(5);
  });
});

describe('ok / err', () => {
  it('ok emits compact JSON', () => {
    expect(ok({ a: 1, b: [1, 2] }).content[0].text).toBe('{"a":1,"b":[1,2]}');
  });
  it('err sets isError and appends hint', () => {
    const r = err('boom', 'try again');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('boom\nHint: try again');
    expect(err('plain').content[0].text).toBe('plain');
  });
});

describe('relPaths', () => {
  it('rewrites path keys only, leaving ids absolute', () => {
    const data = {
      id: `file:${abs('x.ts')}`,
      filePath: abs('x.ts'),
      nested: [{ files: [abs('y.ts')] }],
    };
    const out = relPaths(root, data);
    expect(out.id).toBe(data.id);
    expect(out.filePath).toBe('x.ts');
    expect(out.nested[0].files).toEqual(['y.ts']);
  });
});
