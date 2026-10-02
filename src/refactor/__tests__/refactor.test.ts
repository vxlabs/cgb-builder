import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../../graph/db.js';
import { Parser } from '../../parser/index.js';
import {
  RefactorAnalyzer,
  applyRefactor,
  applyRefactorAsync,
  _expirePendingRefactorForTest,
} from '../index.js';

const LIB = `// greet is the helper
export function greet(name: string): string {
  return 'greet ' + name; // greet
}
function unusedHelper(): number {
  return 1;
}
export function neverUsed(): number {
  return 2;
}
`;
const A = `import { greet } from './lib';
export function runA(): string {
  return greet('a'); // calls greet
}
`;
const B = `import { greet, neverUsed } from './lib';
export const msg = 'call greet now';
export function runB(): string {
  return greet('b') + "greet" + neverUsed();
}
`;
const INDEX = `import { runA } from './a';
import { runB } from './b';
export function main(): string {
  return runA() + runB();
}
`;

describe('refactor', () => {
  let root: string;
  let outside: string;
  let db: GraphDb;

  const write = (rel: string, body: string) => fs.writeFileSync(path.join(root, rel), body, 'utf8');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-refactor-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-outside-')));
    write('lib.ts', LIB);
    write('a.ts', A);
    write('b.ts', B);
    write('index.ts', INDEX);
    db = new GraphDb(root);
    await db.init();
    const files = ['lib.ts', 'a.ts', 'b.ts', 'index.ts'].map((f) => path.join(root, f));
    await new Parser(db, root).parseFiles(files, true);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const greetId = () => db.getNodesByName('greet').find((n) => n.kind === 'function')!.id;

  describe('rename', () => {
    it('renames declaration, call sites and import specifiers but not strings or comments', async () => {
      const analyzer = new RefactorAnalyzer(db, root);
      const preview = analyzer.renamePreviewWithEdits(greetId(), 'hello')!;
      expect(preview).toBeTruthy();
      const files = new Set(preview.items.map((i) => i.file));
      expect(files).toEqual(new Set(['lib.ts', 'a.ts', 'b.ts']));
      expect(preview.items.every((i) => !path.isAbsolute(i.file))).toBe(true);

      const res = await applyRefactorAsync(preview.refactorId, root, db);
      expect(res.status).toBe('applied');
      expect(res.reparsed).toBe(true);
      expect([...(res.files ?? [])].sort()).toEqual(['a.ts', 'b.ts', 'lib.ts']);

      expect(read('lib.ts')).toBe(LIB.replace('function greet(', 'function hello('));
      expect(read('a.ts')).toBe(
        "import { hello } from './lib';\nexport function runA(): string {\n  return hello('a'); // calls greet\n}\n",
      );
      const b = read('b.ts');
      expect(b).toContain("import { hello, neverUsed } from './lib';");
      expect(b).toContain("'call greet now'");
      expect(b).toContain('hello(\'b\') + "greet"');
      // graph reflects the new name after re-parse
      expect(db.getNodesByName('hello').length).toBeGreaterThan(0);
      expect(db.getNodesByName('greet').filter((n) => n.kind === 'function')).toHaveLength(0);
    });

    it('rejects invalid new identifiers', () => {
      expect(() =>
        new RefactorAnalyzer(db, root).renamePreviewWithEdits(greetId(), 'not valid'),
      ).toThrow();
    });

    it('never falls back to whole-file replacement when the range is unknown', () => {
      const n = db.getNode(greetId())!;
      db.upsertNode({ ...n, startLine: undefined, endLine: undefined });
      const preview = new RefactorAnalyzer(db, root).renamePreviewWithEdits(n.id, 'hello')!;
      expect(preview.warnings.length).toBeGreaterThan(0);
      const lib = preview.items.filter((i) => i.file === 'lib.ts');
      expect(lib).toHaveLength(1);
      expect(lib[0].confidence).toBe('low');
    });

    it('aborts everything when a previewed line drifted', () => {
      const preview = new RefactorAnalyzer(db, root).renamePreviewWithEdits(greetId(), 'hello')!;
      const drifted = B.replace("greet('b')", "greet('b2')");
      write('b.ts', drifted);
      const res = applyRefactor(preview.refactorId, root);
      expect(res.status).toBe('error');
      expect(res.conflicts?.length).toBeGreaterThan(0);
      expect(read('lib.ts')).toBe(LIB);
      expect(read('a.ts')).toBe(A);
      expect(read('b.ts')).toBe(drifted);
    });

    it('rejects a path outside the root', () => {
      const out = path.join(outside, 'outside.ts');
      fs.writeFileSync(out, 'export function evil() {}\n');
      db.upsertNode({
        id: 'function:evil',
        kind: 'function',
        name: 'evil',
        filePath: out,
        description: '',
        isExternal: false,
        language: 'typescript',
        meta: '{}',
        updatedAt: 1,
        startLine: 1,
        endLine: 1,
      });
      const preview = new RefactorAnalyzer(db, root).renamePreviewWithEdits(
        'function:evil',
        'good',
      )!;
      expect(preview.items[0].file.startsWith('..')).toBe(true);
      const res = applyRefactor(preview.refactorId, root);
      expect(res.status).toBe('error');
      expect(res.error).toMatch(/traversal|outside/i);
      expect(fs.readFileSync(out, 'utf8')).toBe('export function evil() {}\n');
    });

    it('rejects a path that escapes the root through a link', () => {
      fs.writeFileSync(path.join(outside, 'x.ts'), 'export function evil() {}\n');
      try {
        fs.symlinkSync(outside, path.join(root, 'linkdir'), 'junction');
      } catch (e) {
        process.stderr.write(`skipping link test: ${String(e)}\n`);
        return;
      }
      db.upsertNode({
        id: 'function:evil',
        kind: 'function',
        name: 'evil',
        filePath: path.join(root, 'linkdir', 'x.ts'),
        description: '',
        isExternal: false,
        language: 'typescript',
        meta: '{}',
        updatedAt: 1,
        startLine: 1,
        endLine: 1,
      });
      const preview = new RefactorAnalyzer(db, root).renamePreviewWithEdits(
        'function:evil',
        'good',
      )!;
      const res = applyRefactor(preview.refactorId, root);
      expect(res.status).toBe('error');
      expect(fs.readFileSync(path.join(outside, 'x.ts'), 'utf8')).toBe(
        'export function evil() {}\n',
      );
    });

    it('expires previews', () => {
      const preview = new RefactorAnalyzer(db, root).renamePreviewWithEdits(greetId(), 'hello')!;
      _expirePendingRefactorForTest(preview.refactorId);
      expect(applyRefactor(preview.refactorId, root).status).toBe('expired');
      expect(read('lib.ts')).toBe(LIB);
    });

    it('reports unknown ids', () => {
      expect(applyRefactor('deadbeef', root).status).toBe('not_found');
    });
  });

  describe('dead code', () => {
    it('reports an unexported uncalled function and not exported or called ones', () => {
      const dead = new RefactorAnalyzer(db, root).deadCode(100).map((d) => d.name);
      expect(dead).toContain('unusedHelper');
      expect(dead).not.toContain('neverUsed');
      expect(dead).not.toContain('greet');
      expect(dead).not.toContain('main');
    });

    it('reports exported symbols with no callers and no importers as unusedExports', async () => {
      write('orphan.ts', 'export function lonely(): number {\n  return 1;\n}\n');
      await new Parser(db, root).parseFiles([path.join(root, 'orphan.ts')], true);
      const a = new RefactorAnalyzer(db, root);
      const unused = a.unusedExports(100).map((d) => d.name);
      expect(unused).toContain('lonely');
      expect(unused).not.toContain('greet');
      expect(a.deadCode(100).map((d) => d.name)).not.toContain('lonely');
    });
  });
});
