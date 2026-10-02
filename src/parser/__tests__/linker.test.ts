import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDb } from '../../graph/db.js';
import { Parser, PARSER_VERSION } from '../index.js';
import { hashContent } from '../utils.js';
import type { GraphNode } from '../../types.js';

let root: string;
let db: GraphDb;
let parser: Parser;

const p = (rel: string): string => path.join(root, rel);
const write = (rel: string, src: string): void => {
  fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
  fs.writeFileSync(p(rel), src);
};
const fn = (rel: string, sym: string): string => `function:${p(rel)}#${sym}`;
const cls = (rel: string, sym: string): string => `class:${p(rel)}#${sym}`;
const meth = (rel: string, sym: string): string => `method:${p(rel)}#${sym}`;
const ifc = (rel: string, sym: string): string => `interface:${p(rel)}#${sym}`;
const fileId = (rel: string): string => `file:${p(rel)}`;

function targets(fromId: string, kind: string): string[] {
  return db
    .getEdgesFromByKind(fromId, kind)
    .map((e) => e.toId)
    .sort();
}

function dangling(): number {
  const ids = new Set(db.getAllNodes().map((n) => n.id));
  return db.getAllEdges().filter((e) => !ids.has(e.fromId) || !ids.has(e.toId)).length;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-linker-'));
  db = new GraphDb(root);
  await db.init();
  parser = new Parser(db, root);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Linker: calls', () => {
  it('resolves same-file calls, new, and counts unresolved on the caller', async () => {
    write(
      'a.ts',
      `function helper() {}
class Widget {}
export function main() {
  helper();
  helper();
  new Widget();
  console.log('x');
  other.thing();
}
helper();
`,
    );
    await parser.scanAll();
    const main = fn('a.ts', 'main');
    expect(targets(main, 'calls')).toEqual([cls('a.ts', 'Widget'), fn('a.ts', 'helper')].sort());
    expect(db.getEdgesFromByKind(main, 'calls')).toHaveLength(2); // duplicate call = one edge
    const reasons = db
      .getEdgesFromByKind(main, 'calls')
      .map((e) => e.reason)
      .sort();
    expect(reasons).toEqual(['call', 'new']);
    const meta = JSON.parse(db.getNode(main)?.meta ?? '{}') as Record<string, unknown>;
    expect(meta['unresolvedCalls']).toBe(2);
    expect(meta['unresolvedSample']).toEqual(['console.log', 'other.thing']);
    // module-level call is attributed to the file node
    expect(targets(fileId('a.ts'), 'calls')).toEqual([fn('a.ts', 'helper')]);
  });

  it('prefers the isDefault symbol for a default import with a different local name', async () => {
    write('lib2.ts', `export function other() {}\nexport default function realDefault() {}\n`);
    write('use2.ts', `import whatever from './lib2';\nexport function run() { whatever(); }\n`);
    await parser.scanAll();
    expect(targets(fn('use2.ts', 'run'), 'calls')).toEqual([fn('lib2.ts', 'realDefault')]);
  });

  it('resolves named, aliased and default imports', async () => {
    write('lib.ts', `export function f() {}\nexport default function() {}\nexport class K {}\n`);
    write(
      'use.ts',
      `import { f as g, K } from './lib';\nimport dd from './lib';\nexport function run() { g(); dd(); new K(); }\n`,
    );
    await parser.scanAll();
    expect(targets(fn('use.ts', 'run'), 'calls')).toEqual(
      [fn('lib.ts', 'f'), fn('lib.ts', 'default'), cls('lib.ts', 'K')].sort(),
    );
    const viaG = db
      .getEdgesFromByKind(fn('use.ts', 'run'), 'calls')
      .find((e) => e.toId === fn('lib.ts', 'f'));
    expect(viaG?.reason).toBe('call via g');
  });

  it('resolves namespace imports and static/object-literal members', async () => {
    write(
      'lib.ts',
      `export function f() {}\nexport class Util { static make() {} }\nexport const api = { get() {} };\n`,
    );
    write(
      'use.ts',
      `import * as ns from './lib';\nimport { Util, api } from './lib';\nexport function run() { ns.f(); ns.Util.make(); Util.make(); api.get(); }\n`,
    );
    await parser.scanAll();
    expect(targets(fn('use.ts', 'run'), 'calls')).toEqual(
      [fn('lib.ts', 'f'), meth('lib.ts', 'Util.make'), meth('lib.ts', 'api.get')].sort(),
    );
  });

  it('resolves through barrel re-exports (named and export *)', async () => {
    write('impl/one.ts', `export function one() {}\n`);
    write('impl/two.ts', `export function two() {}\n`);
    write('impl/index.ts', `export { one } from './one';\nexport * from './two';\n`);
    write(
      'use.ts',
      `import { one, two } from './impl';\nexport function run() { one(); two(); }\n`,
    );
    await parser.scanAll();
    expect(targets(fn('use.ts', 'run'), 'calls')).toEqual(
      [fn('impl/one.ts', 'one'), fn('impl/two.ts', 'two')].sort(),
    );
  });

  it('resolves this.m() to own class and inherited parent in another file', async () => {
    write('base.ts', `export class Base { shared() {} }\n`);
    write(
      'child.ts',
      `import { Base } from './base';
export class Child extends Base {
  own() {}
  run() { this.own(); this.shared(); super.shared(); }
}
`,
    );
    await parser.scanAll();
    expect(targets(meth('child.ts', 'Child.run'), 'calls')).toEqual(
      [meth('child.ts', 'Child.own'), meth('base.ts', 'Base.shared')].sort(),
    );
    expect(targets(cls('child.ts', 'Child'), 'inherits')).toEqual([cls('base.ts', 'Base')]);
  });

  it('resolves cross-file implements and interface extends', async () => {
    write('types.ts', `export interface Repo {}\nexport interface Named {}\n`);
    write(
      'impl.ts',
      `import { Repo } from './types';\nimport * as t from './types';\nexport class R implements Repo {}\nexport interface N2 extends t.Named {}\n`,
    );
    await parser.scanAll();
    expect(targets(cls('impl.ts', 'R'), 'implements')).toEqual([ifc('types.ts', 'Repo')]);
    expect(targets(ifc('impl.ts', 'N2'), 'inherits')).toEqual([ifc('types.ts', 'Named')]);
  });
});

describe('Linker: incremental correctness', () => {
  it('removes deleted files on scanAll with no dangling edges', async () => {
    write('lib.ts', `export function f() {}\n`);
    write('use.ts', `import { f } from './lib';\nexport function run() { f(); }\n`);
    await parser.scanAll();
    expect(targets(fn('use.ts', 'run'), 'calls')).toEqual([fn('lib.ts', 'f')]);

    fs.rmSync(p('lib.ts'));
    await parser.scanAll();
    expect(db.getFile(p('lib.ts'))).toBeNull();
    expect(db.getNodesByFile(p('lib.ts'))).toHaveLength(0);
    expect(targets(fn('use.ts', 'run'), 'calls')).toEqual([]);
    expect(dangling()).toBe(0);
  });

  it('removeFile prunes incoming edges', async () => {
    write('lib.ts', `export function f() {}\n`);
    write('use.ts', `import { f } from './lib';\nexport function run() { f(); }\n`);
    await parser.scanAll();
    parser.removeFile(p('lib.ts'));
    expect(dangling()).toBe(0);
    expect(targets(fn('use.ts', 'run'), 'calls')).toEqual([]);
  });

  it('re-parsing a callee keeps the caller edge while the symbol exists, prunes it when removed', async () => {
    write('lib.ts', `export function f() {}\nexport function g() {}\n`);
    write('use.ts', `import { f, g } from './lib';\nexport function run() { f(); g(); }\n`);
    await parser.scanAll();
    expect(targets(fn('use.ts', 'run'), 'calls')).toEqual(
      [fn('lib.ts', 'f'), fn('lib.ts', 'g')].sort(),
    );

    write('lib.ts', `export function f() { /* changed */ }\n`);
    await parser.parseFiles([p('lib.ts')]);
    expect(targets(fn('use.ts', 'run'), 'calls')).toEqual([fn('lib.ts', 'f')]);
    expect(dangling()).toBe(0);
  });

  it('does not duplicate or leak nodes on repeated full scans', async () => {
    write('a.ts', `export function a() { b(); }\nfunction b() {}\n`);
    await parser.scanAll();
    const before: GraphNode[] = db.getAllNodes();
    const edgesBefore = db.getAllEdges().length;
    await parser.scanAll(true);
    expect(db.getAllNodes()).toHaveLength(before.length);
    expect(db.getAllEdges()).toHaveLength(edgesBefore);
  });
});

describe('Parser version invalidation', () => {
  it('mixes PARSER_VERSION into the stored hash so an old hash forces a reparse', async () => {
    const src = 'export function a() {}\n';
    write('v.ts', src);
    await parser.scanAll();
    const stored = db.getFile(p('v.ts'))?.contentHash;
    expect(stored).toBe(hashContent(`${PARSER_VERSION}\n${src}`));
    expect(stored).not.toBe(hashContent(src));
    // simulate a row written by an older parser
    const row = db.getFile(p('v.ts'))!;
    db.upsertFile({ ...row, contentHash: hashContent(src), parsedAt: 1 });
    await parser.scanAll();
    expect(db.getFile(p('v.ts'))?.contentHash).toBe(stored);
  });
});
