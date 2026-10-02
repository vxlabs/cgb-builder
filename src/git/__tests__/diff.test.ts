import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { validateRef, getGitChanges } from '../diff.js';

describe('validateRef', () => {
  it.each(['main', 'HEAD~3', 'origin/feature-x', 'v1.2.0', 'HEAD^', '@{u}'])(
    'accepts %s',
    (ref) => {
      expect(validateRef(ref)).toBe(ref);
    },
  );

  it.each(['main; rm -rf /', '--output=x', '$(id)', '-x', 'a b', '', 'a`id`'])(
    'rejects %s',
    (ref) => {
      expect(() => validateRef(ref)).toThrow('Invalid git ref');
    },
  );
});

describe('getGitChanges', () => {
  it('rejects an injected base ref', async () => {
    await expect(getGitChanges('.', '--output=x')).rejects.toThrow('Invalid git ref');
  });
});

describe('getGitChanges working tree', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-diff-test-')));
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n'); // unstaged modification
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\ny\n'); // untracked
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('includes unstaged modifications and untracked files when no base is given', async () => {
    const changes = await getGitChanges(dir);
    const byName = new Map(changes.map((c) => [path.basename(c.filePath), c]));
    expect(byName.get('a.txt')).toMatchObject({
      status: 'modified',
      linesAdded: 1,
      linesRemoved: 0,
    });
    expect(byName.get('new.txt')).toMatchObject({
      status: 'added',
      linesAdded: 2,
      linesRemoved: 0,
    });
    expect(byName.has('b.txt')).toBe(false);
  });

  it('includes staged changes too', async () => {
    git('add', 'new.txt');
    const changes = await getGitChanges(dir);
    expect(changes.find((c) => c.filePath.endsWith('new.txt'))?.status).toBe('added');
  });

  it('with a base, merges working-tree changes unless includeWorkingTree is false', async () => {
    git('commit', '-q', '-am', 'second'); // commits a.txt
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\nmore\n'); // new working-tree change
    const withWt = await getGitChanges(dir, 'HEAD~1');
    const names = withWt.map((c) => path.basename(c.filePath)).sort();
    expect(names).toEqual(['a.txt', 'b.txt', 'new.txt']);
    const without = await getGitChanges(dir, 'HEAD~1', false);
    expect(without.map((c) => path.basename(c.filePath)).sort()).toEqual(['a.txt', 'new.txt']);
  });
});
