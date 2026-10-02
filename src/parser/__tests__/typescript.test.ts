import { TypeScriptAdapter } from '../adapters/typescript.js';
import { parseSnippet, FIXTURE_ROOT, type ParsedView } from './helpers.js';
import * as path from 'path';

const ts = new TypeScriptAdapter('typescript');
const js = new TypeScriptAdapter('javascript');

const abs = (rel: string) => path.join(FIXTURE_ROOT, rel);
const id = (kind: string, rel: string, sym?: string) =>
  `${kind}:${abs(rel)}${sym ? `#${sym}` : ''}`;
const meta = (v: ParsedView, kind: string, sym: string) =>
  JSON.parse(v.node(kind, sym)!.meta) as Record<string, any>;
const has = (v: ParsedView, kind: Parameters<ParsedView['edgesOf']>[0], from: string, to: string) =>
  v.edgesOf(kind).some((e) => e.from === from && e.to === to);

describe('TypeScript adapter', () => {
  it('extracts function declarations, export function and export default function', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `function plain() {}\nexport function named() {}\nexport default function () {}\n`,
    );
    expect(v.node('function', 'plain')).toBeDefined();
    expect(v.node('function', 'named')).toBeDefined();
    expect(v.node('function', 'default')).toBeDefined();
    expect(v.kinds.function).toBe(3);
  });

  it('extracts arrow and function-expression consts', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `const f = () => {};\nconst g = function () {};\nexport const h = async () => {};\n`,
    );
    for (const n of ['f', 'g', 'h']) expect(v.ids.has(id('function', 'a.ts', n))).toBe(true);
    expect(v.kinds.function).toBe(3);
  });

  it('extracts class methods (normal, static, accessors, constructor, #private, abstract)', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `abstract class C {
  normal() {}
  static make() {}
  get val() { return 1; }
  set val(x: number) {}
  constructor() {}
  #secret() {}
  abstract must(): void;
}
`,
    );
    for (const m of ['normal', 'make', 'val', 'constructor', '#secret', 'must']) {
      expect(v.ids.has(id('method', 'a.ts', `C.${m}`))).toBe(true);
    }
    expect(v.kinds.method).toBe(6);
    expect(meta(v, 'method', 'C.val').accessor).toBe('both');
    expect(meta(v, 'method', 'C.must').abstract).toBe(true);
    expect(meta(v, 'method', 'C.make').static).toBe(true);
    expect(has(v, 'contains', id('class', 'a.ts', 'C'), id('method', 'a.ts', 'C.normal'))).toBe(
      true,
    );
  });

  it('marks abstract classes', async () => {
    const v = await parseSnippet(ts, 'a.ts', `export abstract class Base {}\n`);
    expect(v.node('class', 'Base')).toBeDefined();
    expect(meta(v, 'class', 'Base').abstract).toBe(true);
  });

  it('handles interface extends', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `interface A {}\ninterface B<T> {}\ninterface C extends A, B<string> {}\n`,
    );
    expect(meta(v, 'interface', 'C').heritage.extends).toEqual(['A', 'B']);
    expect(has(v, 'inherits', id('interface', 'a.ts', 'C'), id('interface', 'a.ts', 'A'))).toBe(
      true,
    );
    expect(has(v, 'inherits', id('interface', 'a.ts', 'C'), id('interface', 'a.ts', 'B'))).toBe(
      true,
    );
  });

  it('extracts type alias, enum and namespace', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `type T = { a: number };\nenum E { A, B }\nnamespace N { export const x = 1; }\nexport namespace N2 {}\ndeclare module 'ext' {}\n`,
    );
    expect(meta(v, 'type', 'T').subkind).toBe('alias');
    expect(meta(v, 'type', 'E').subkind).toBe('enum');
    expect(v.node('module', 'N')).toBeDefined();
    expect(v.node('module', 'N2')).toBeDefined();
    expect(v.node('module', 'ext')).toBeDefined();
  });

  it('extracts object-literal methods on a top-level const', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `export const api = { get() {}, post: () => {}, n: 1 };\n`,
    );
    expect(v.ids.has(id('method', 'a.ts', 'api.get'))).toBe(true);
    expect(v.ids.has(id('method', 'a.ts', 'api.post'))).toBe(true);
    expect(v.kinds.method).toBe(2);
  });

  it('collapses overloads into one node', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `function f(a: number): void;\nfunction f(a: string): void;\nfunction f(a: any) {}\nclass K { m(a: number): void; m(a: string): void; m(a: any) {} }\n`,
    );
    expect(v.nodes.filter((n) => n.kind === 'function' && n.name === 'f')).toHaveLength(1);
    expect(v.nodes.filter((n) => n.kind === 'method')).toHaveLength(1);
  });

  it('parses .tsx with the TSX grammar and keeps declarations after JSX', async () => {
    const v = await parseSnippet(
      ts,
      'a.tsx',
      `export function Button() { return <div/>; }\nclass After {}\n`,
    );
    expect(v.node('function', 'Button')).toBeDefined();
    expect(v.node('class', 'After')).toBeDefined();
  });

  it('extracts JS classes, extends and module.exports', async () => {
    const v = await parseSnippet(
      js,
      'a.js',
      `class Base {}\nclass Child extends Base { run() {} }\nfunction helper() {}\nfunction hidden() {}\nmodule.exports = { Child, helper };\n`,
    );
    expect(v.node('class', 'Child')).toBeDefined();
    expect(v.ids.has(id('method', 'a.js', 'Child.run'))).toBe(true);
    expect(has(v, 'inherits', id('class', 'a.js', 'Child'), id('class', 'a.js', 'Base'))).toBe(
      true,
    );
    const exp = v.edgesOf('exports').map((e) => e.to);
    expect(exp).toContain(id('class', 'a.js', 'Child'));
    expect(exp).toContain(id('function', 'a.js', 'helper'));
    expect(exp).not.toContain(id('function', 'a.js', 'hidden'));
    expect(exp).not.toContain(id('class', 'a.js', 'Base'));
  });

  it('handles module.exports = X and exports.a = fn', async () => {
    const v = await parseSnippet(
      js,
      'a.cjs',
      `class X {}\nmodule.exports = X;\nexports.a = function () {};\n`,
    );
    const exp = v.edgesOf('exports').map((e) => e.to);
    expect(exp).toContain(id('class', 'a.cjs', 'X'));
    expect(exp).toContain(id('function', 'a.cjs', 'a'));
  });

  it('emits exports edges only for exported symbols', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `function priv() {}\nexport function pub() {}\nfunction later() {}\nclass Hidden {}\nexport { later };\n`,
    );
    const exp = v.edgesOf('exports').map((e) => e.to);
    expect(exp).toContain(id('function', 'a.ts', 'pub'));
    expect(exp).toContain(id('function', 'a.ts', 'later'));
    expect(exp).not.toContain(id('function', 'a.ts', 'priv'));
    expect(exp).not.toContain(id('class', 'a.ts', 'Hidden'));
  });

  it('emits same-file inherits/implements edges; cross-file parents only in meta.heritage', async () => {
    const v = await parseSnippet(
      ts,
      'a.ts',
      `interface I {}\nclass P {}\nclass A extends P implements I {}\nclass B extends Remote implements Elsewhere {}\n`,
    );
    const A = id('class', 'a.ts', 'A');
    const B = id('class', 'a.ts', 'B');
    expect(has(v, 'inherits', A, id('class', 'a.ts', 'P'))).toBe(true);
    expect(has(v, 'implements', A, id('interface', 'a.ts', 'I'))).toBe(true);
    expect(v.edgesOf('inherits').filter((e) => e.from === B)).toHaveLength(0);
    expect(v.edgesOf('implements').filter((e) => e.from === B)).toHaveLength(0);
    expect(meta(v, 'class', 'B').heritage).toEqual({
      extends: ['Remote'],
      implements: ['Elsewhere'],
    });
  });

  it('captures `implements I1, I2<X>`', async () => {
    const v = await parseSnippet(ts, 'a.ts', `class C implements I1, I2<X> {}\n`);
    expect(meta(v, 'class', 'C').heritage.implements).toEqual(['I1', 'I2']);
  });
});

describe('TypeScript adapter metadata', () => {
  const sig = (v: ParsedView, kind: string, sym: string) => v.node(kind, sym)!.signature;

  it('records line ranges for functions, methods and decorated classes', async () => {
    const v = await parseSnippet(
      ts,
      'm.ts',
      [
        'function a() {', // 1
        '  return 1;', // 2
        '}', // 3
        '', // 4
        '@Component({})', // 5
        'export class K {', // 6
        '  @Input()', // 7
        '  foo(): void {', // 8
        '  }', // 9
        '}', // 10
        '',
      ].join('\n'),
    );
    const a = v.node('function', 'a')!;
    expect([a.startLine, a.endLine]).toEqual([1, 3]);
    const k = v.node('class', 'K')!;
    expect(k.startLine).toBe(5);
    expect(k.endLine).toBe(10);
    const foo = v.node('method', 'K.foo')!;
    expect([foo.startLine, foo.endLine]).toEqual([7, 9]);
  });

  it('range of an exported function includes the export keyword; file node spans the file', async () => {
    const v = await parseSnippet(ts, 'm.ts', `\n\nexport function f() {\n}\n`);
    const f = v.node('function', 'f')!;
    expect([f.startLine, f.endLine]).toEqual([3, 4]);
    const file = v.node('file')!;
    expect([file.startLine, file.endLine]).toEqual([1, 4]);
  });

  it('builds signatures for each kind', async () => {
    const v = await parseSnippet(
      ts,
      'm.ts',
      [
        'export async function load<T>(id:   string,\n  n = 1): Promise<T | null> { return null; }',
        'const arrow = async (x: number): Promise<void> => {};',
        'let plain = function (a, b) {};',
        'export abstract class Repo<T> extends Base<T> implements I1, I2 {}',
        'interface Box<T> extends A, B { v: T }',
        'type Pair<A> = { first: A; second: A };',
        'enum Color { Red, Green, Blue }',
        'namespace NS { export const x = 1; }',
        'class C { async find(id: string): Promise<User | null> { return null; } }',
        '',
      ].join('\n'),
    );
    expect(sig(v, 'function', 'load')).toBe('async load<T>(id: string, n = 1): Promise<T | null>');
    expect(sig(v, 'function', 'arrow')).toBe('const arrow = async (x: number): Promise<void> =>');
    expect(sig(v, 'function', 'plain')).toBe('let plain = (a, b) =>');
    expect(sig(v, 'class', 'Repo')).toBe(
      'abstract class Repo<T> extends Base<T> implements I1, I2',
    );
    expect(sig(v, 'interface', 'Box')).toBe('interface Box<T> extends A, B');
    expect(sig(v, 'type', 'Pair')).toBe('type Pair<A> = { first: A; second: A }');
    expect(sig(v, 'type', 'Color')).toBe('enum Color { Red, Green, Blue }');
    expect(sig(v, 'module', 'NS')).toBe('namespace NS');
    expect(sig(v, 'method', 'C.find')).toBe('async find(id: string): Promise<User | null>');
  });

  it('truncates long type alias right-hand sides', async () => {
    const v = await parseSnippet(ts, 'm.ts', `type L = ${'"abcdefghij" | '.repeat(30)}"z";\n`);
    expect(sig(v, 'type', 'L')!.length).toBeLessThanOrEqual(200);
    expect(sig(v, 'type', 'L')!.startsWith('type L = "abcdefghij" |')).toBe(true);
  });

  it('extracts JSDoc first paragraph, looking above export, and falls back to // comments', async () => {
    const v = await parseSnippet(
      ts,
      'm.ts',
      [
        '/**',
        ' * Adds two numbers.',
        ' * Really.',
        ' *',
        ' * @param a first',
        ' */',
        'export function add(a: number, b: number) { return a + b; }',
        '',
        '// Subtracts b from a.',
        '// Carefully.',
        'function sub(a: number, b: number) { return a - b; }',
        '',
        'function none() {}',
        '',
      ].join('\n'),
    );
    expect(v.node('function', 'add')!.doc).toBe('Adds two numbers. Really.');
    expect(v.node('function', 'add')!.description).toBe('Adds two numbers. Really.');
    expect(v.node('function', 'sub')!.doc).toBe('Subtracts b from a. Carefully.');
    expect(v.node('function', 'none')!.doc).toBeUndefined();
  });

  it('records member modifiers (private static async, getter/setter, abstract)', async () => {
    const v = await parseSnippet(
      ts,
      'm.ts',
      [
        'abstract class A {',
        '  private static async load(x: number): Promise<void> {}',
        '  get size(): number { return 1; }',
        '  set size(v: number) {}',
        '  abstract run(): void;',
        '  protected readonly handler = (e: Event) => {};',
        '}',
        '',
      ].join('\n'),
    );
    const load = v.node('method', 'A.load')!;
    expect(load.modifiers).toEqual(['private', 'static', 'async']);
    expect(load.signature).toBe('private static async load(x: number): Promise<void>');
    expect(v.node('method', 'A.size')!.modifiers).toEqual(['getter', 'setter']);
    expect(v.node('method', 'A.run')!.modifiers).toEqual(['abstract']);
    expect(v.node('class', 'A')!.modifiers).toEqual(['abstract']);
    expect(v.node('method', 'A.handler')!.modifiers).toEqual(['protected', 'readonly']);
  });

  it('marks exported symbols (matching exports edges) and default exports', async () => {
    const v = await parseSnippet(
      ts,
      'm.ts',
      `export function a() {}\nfunction b() {}\nfunction c() {}\nexport { c }\nfunction d() {}\nexport default d;\nexport default function named() {}\n`,
    );
    expect(v.node('function', 'a')!.exported).toBe(true);
    expect(v.node('function', 'b')!.exported).toBe(false);
    expect(v.node('function', 'c')!.exported).toBe(true);
    expect(v.node('function', 'd')!.exported).toBe(true);
    for (const n of v.nodes.filter((x) => x.kind === 'function')) {
      const hasEdge = v.edgesOf('exports').some((e) => e.to === n.id);
      expect(!!n.exported).toBe(hasEdge);
    }
    expect(v.node('function', 'named')!.modifiers).toContain('default');
    expect(meta(v, 'function', 'named').isDefault).toBe(true);
    expect(meta(v, 'function', 'd').isDefault).toBe(true);
  });

  it('fills metadata for JavaScript and object-literal methods', async () => {
    const v = await parseSnippet(
      js,
      'm.js',
      `/** The api. */\nconst api = {\n  async get(id) { return id; },\n  post: (x) => x,\n};\nmodule.exports = { api };\n`,
    );
    const g = v.node('method', 'api.get')!;
    expect(g.signature).toBe('async get(id)');
    expect(g.startLine).toBe(3);
    expect(v.node('method', 'api.post')!.signature).toBe('post: (x) =>');
  });
});
