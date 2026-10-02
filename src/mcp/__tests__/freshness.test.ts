import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GraphDb } from '../../graph/db';
import { Parser } from '../../parser/index';
import { ensureFresh, resetFreshnessThrottle } from '../freshness';

let root: string;
let db: GraphDb;

const abs = (f: string) => path.join(root, f);
const write = (f: string, body: string, mtimeOffsetMs = 0) => {
  fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
  fs.writeFileSync(abs(f), body);
  // Guarantee a distinct mtime even on coarse filesystems.
  const t = new Date(Date.now() + mtimeOffsetMs);
  fs.utimesSync(abs(f), t, t);
};
const names = () => db.getAllNodes().map((n) => n.name);
const opts = { throttleMs: 0 };

beforeEach(async () => {
  delete process.env.CGB_NO_AUTOREFRESH;
  resetFreshnessThrottle();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-fresh-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  write('src/a.ts', 'export function alpha() { return 1; }\n');
  write('src/b.ts', 'export function beta() { return 2; }\n');
  db = new GraphDb(root);
  await db.init();
  await new Parser(db, root).scanAll();
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureFresh', () => {
  it('does nothing when nothing changed', async () => {
    expect(await ensureFresh(root, db, opts)).toEqual({ reparsed: 0, removed: 0, skipped: false });
  });

  it('re-parses a modified file', async () => {
    expect(names()).toContain('alpha');
    write('src/a.ts', 'export function alphaRenamed() { return 1; }\n', 5000);
    const r = await ensureFresh(root, db, opts);
    expect(r).toMatchObject({ reparsed: 1, removed: 0, skipped: false });
    expect(names()).toContain('alphaRenamed');
    expect(names()).not.toContain('alpha');
  });

  it('picks up a new untracked file via git', async () => {
    write('src/c.ts', 'export function gamma() { return 3; }\n');
    const r = await ensureFresh(root, db, opts);
    expect(r.reparsed).toBe(1);
    expect(names()).toContain('gamma');
  });

  it('ignores new files in ignored directories', async () => {
    write('dist/x.ts', 'export function ghost() {}\n');
    write('src/types.d.ts', 'export declare function ghost2(): void;\n');
    const r = await ensureFresh(root, db, opts);
    expect(r.reparsed).toBe(0);
    expect(names()).not.toContain('ghost');
  });

  it('removes deleted files from the graph', async () => {
    fs.rmSync(abs('src/b.ts'));
    const r = await ensureFresh(root, db, opts);
    expect(r).toMatchObject({ removed: 1, skipped: false });
    expect(names()).not.toContain('beta');
    expect(db.getFile(abs('src/b.ts'))).toBeNull();
  });

  it('sets skipped when the time budget is exceeded, and stays stale', async () => {
    write('src/a.ts', 'export function alpha2() {}\n', 5000);
    const r = await ensureFresh(root, db, { ...opts, budgetMs: 0 });
    expect(r.skipped).toBe(true);
    expect(names()).not.toContain('alpha2');
  });

  it('sets skipped when more than maxFiles changed', async () => {
    write('src/a.ts', 'export function alpha3() {}\n', 5000);
    write('src/c.ts', 'export function gamma3() {}\n');
    const r = await ensureFresh(root, db, { ...opts, maxFiles: 1 });
    expect(r.skipped).toBe(true);
  });

  it('throttles repeat checks for the same root', async () => {
    await ensureFresh(root, db); // default 2 s throttle
    write('src/a.ts', 'export function alpha4() {}\n', 5000);
    const second = await ensureFresh(root, db);
    expect(second).toEqual({ reparsed: 0, removed: 0, skipped: false });
    expect(names()).not.toContain('alpha4');
    resetFreshnessThrottle();
    expect((await ensureFresh(root, db)).reparsed).toBe(1);
  });

  it('is disabled by CGB_NO_AUTOREFRESH=1', async () => {
    write('src/a.ts', 'export function alpha5() {}\n', 5000);
    process.env.CGB_NO_AUTOREFRESH = '1';
    try {
      expect(await ensureFresh(root, db, opts)).toEqual({
        reparsed: 0,
        removed: 0,
        skipped: false,
      });
      expect(names()).not.toContain('alpha5');
    } finally {
      delete process.env.CGB_NO_AUTOREFRESH;
    }
  });

  it('falls back to stat-ing known files without git', async () => {
    fs.rmSync(abs('.git'), { recursive: true, force: true });
    write('src/a.ts', 'export function alpha6() {}\n', 5000);
    write('src/new.ts', 'export function undiscovered() {}\n');
    const r = await ensureFresh(root, db, opts);
    expect(r.reparsed).toBe(1);
    expect(names()).toContain('alpha6');
    expect(names()).not.toContain('undiscovered');
  });
});
