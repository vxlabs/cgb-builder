import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../../graph/db.js';
import { GraphEngine } from '../../graph/engine.js';
import { BundleGenerator } from '../generator.js';
import type { GraphNode, GraphEdge } from '../../types.js';

function node(o: Partial<GraphNode> & { id: string; name: string }): GraphNode {
  return {
    kind: 'function',
    filePath: '',
    description: '',
    isExternal: false,
    language: 'typescript',
    meta: '{}',
    updatedAt: 1,
    ...o,
  };
}

function edge(kind: GraphEdge['kind'], fromId: string, toId: string, reason = ''): GraphEdge {
  return { id: `${fromId}|${kind}|${toId}`, fromId, toId, kind, reason, updatedAt: 1 } as GraphEdge;
}

describe('BundleGenerator', () => {
  let root: string;
  let db: GraphDb;
  let gen: BundleGenerator;
  let aPath: string;
  let bigPath: string;
  let bPath: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-bundle-'));
    fs.mkdirSync(path.join(root, 'src'));
    aPath = path.join(root, 'src', 'a.ts');
    bPath = path.join(root, 'src', 'b.ts');
    bigPath = path.join(root, 'src', 'big.ts');

    const aLines = [
      'import { helper } from "./b";',
      '',
      '/** Adds things. */',
      'export function target(x: number): number {',
      '  const y = helper(x);',
      '  return y + 1;',
      '}',
      '',
      'export function caller() {',
      '  return target(1);',
      '}',
    ];
    fs.writeFileSync(aPath, aLines.join('\n') + '\n');
    fs.writeFileSync(bPath, 'export function helper(n: number) {\n  return n * 2;\n}\n');
    const bigLines = Array.from({ length: 300 }, (_, i) => `// line ${i + 1}`);
    fs.writeFileSync(bigPath, bigLines.join('\n') + '\n');

    db = new GraphDb(root);
    await db.init();
    const fileA = node({
      id: `file:${aPath}`,
      kind: 'file',
      name: 'a.ts',
      filePath: aPath,
      startLine: 1,
      endLine: 11,
    });
    const fileB = node({
      id: `file:${bPath}`,
      kind: 'file',
      name: 'b.ts',
      filePath: bPath,
      startLine: 1,
      endLine: 3,
    });
    const fileBig = node({
      id: `file:${bigPath}`,
      kind: 'file',
      name: 'big.ts',
      filePath: bigPath,
      startLine: 1,
      endLine: 300,
    });
    const target = node({
      id: `function:${aPath}#target`,
      name: 'target',
      filePath: aPath,
      startLine: 4,
      endLine: 7,
      signature: 'export function target(x: number): number',
      doc: 'Adds things.',
      exported: true,
    });
    const caller = node({
      id: `function:${aPath}#caller`,
      name: 'caller',
      filePath: aPath,
      startLine: 9,
      endLine: 11,
      signature: 'export function caller()',
    });
    const helper = node({
      id: `function:${bPath}#helper`,
      name: 'helper',
      filePath: bPath,
      startLine: 1,
      endLine: 3,
      signature: 'export function helper(n: number)',
    });
    const bigFn = node({
      id: `function:${bigPath}#huge`,
      name: 'huge',
      filePath: bigPath,
      startLine: 1,
      endLine: 300,
      signature: 'function huge()',
    });
    const legacy = node({ id: `function:${bPath}#legacy`, name: 'legacy', filePath: bPath });
    for (const n of [fileA, fileB, fileBig, target, caller, helper, bigFn, legacy])
      db.upsertNode(n);
    db.upsertEdge(edge('imports', fileA.id, fileB.id, 'import'));
    db.upsertEdge(edge('calls', caller.id, target.id, 'call'));
    db.upsertEdge(edge('calls', target.id, helper.id, 'call'));

    gen = new BundleGenerator(db, new GraphEngine(db), root);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const text = (target: string, opts = {}) => gen.render(gen.generate(target, opts));

  it('symbol bundle contains only the symbol lines plus neighbour signatures', () => {
    const out = text(`function:${aPath}#target`);
    expect(out).toContain('const y = helper(x);');
    expect(out).toContain('return y + 1;');
    // other symbol bodies are not embedded as source
    expect(out).not.toContain('return target(1);');
    expect(out).not.toContain('return n * 2;');
    // callers / callees as signatures with ranges
    expect(out).toContain('export function caller()');
    expect(out).toContain('src/a.ts:9-11');
    expect(out).toContain('export function helper(n: number)');
    expect(out).toContain('src/b.ts:1-3');
    expect(out).toMatch(/≈ \d+ lines, \d+ chars/);
  });

  it('resolves a node id that was path-resolved against the project root (CLI behaviour)', () => {
    const mangled = path.resolve(root, `function:${aPath}#target`);
    const out = text(mangled);
    expect(out).toContain('const y = helper(x);');
    expect(out).not.toContain('return target(1);');
  });

  it('appends a truncation marker when the symbol exceeds maxTargetLines', () => {
    const out = text(`function:${bigPath}#huge`, { maxTargetLines: 10 });
    expect(out).toContain('// line 10');
    expect(out).not.toContain('// line 11\n');
    expect(out).toContain('… (290 more lines)');
  });

  it('file bundle for a big file has an outline and only the first maxTargetLines lines', () => {
    const out = text(bigPath, { maxTargetLines: 50 });
    expect(out).toContain('Symbols in');
    expect(out).toContain('function huge()');
    expect(out).toContain('L1-300');
    expect(out).toContain('// line 50');
    expect(out).not.toContain('// line 51\n');
    expect(out).toContain('… (250 more lines)');
  });

  it('file bundle for a small file includes the full source', () => {
    const out = text(aPath);
    expect(out).toContain('return target(1);');
    expect(out).toContain('Adds things.');
    expect(out).not.toContain('more lines)');
  });

  it('a symbol without ranges falls back to the file bundle', () => {
    const out = text(`function:${bPath}#legacy`);
    expect(out).toContain('**Target file:**');
    expect(out).toContain('return n * 2;');
  });

  it('dependency snippets are signature-only unless includeDependencySource, then capped', () => {
    const plain = text(aPath);
    expect(plain).toContain('src/b.ts:1-3');
    expect(plain).not.toMatch(/```ts\nexport function helper/);

    const withSrc = text(aPath, { includeDependencySource: true, maxDependencyLines: 2 });
    expect(withSrc).toContain('export function helper(n: number) {');
    expect(withSrc).toContain('… (1 more lines)');
  });
});
