import * as path from 'path';
import { shouldIgnore } from '../index';

describe('watcher shouldIgnore', () => {
  const root = path.resolve(path.sep, 'home', 'x', 'code_graph_builder');
  const ign = (rel: string) => shouldIgnore(root, path.join(root, rel));

  it('does not ignore files because a parent dir contains "build"', () => {
    expect(ign('src/index.ts')).toBe(false);
    expect(ign('src/cli/install.ts')).toBe(false);
    expect(shouldIgnore(root, root)).toBe(false);
  });

  it('ignores build/dependency directories', () => {
    expect(ign('node_modules/x.ts')).toBe(true);
    expect(ign('dist/a.js')).toBe(true);
    expect(ign('packages/a/build/out.js')).toBe(true);
    expect(ign('.git/HEAD')).toBe(true);
    expect(ign('.cgb/graph.db')).toBe(true);
    expect(ign('coverage/x.js')).toBe(true);
  });

  it('is segment-anchored', () => {
    expect(ign('src/distribution/a.ts')).toBe(false);
    expect(ign('src/rebuild.ts')).toBe(false);
    expect(ign('src/bin.ts')).toBe(false);
  });

  it('ignores minified and d.ts files, and paths outside root', () => {
    expect(ign('a.min.js')).toBe(true);
    expect(ign('types/a.d.ts')).toBe(true);
    expect(shouldIgnore(root, path.resolve(root, '..', 'other', 'a.ts'))).toBe(true);
  });
});
