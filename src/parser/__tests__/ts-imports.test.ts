import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TypeScriptAdapter } from '../adapters/typescript.js';
import { findTsPathConfig, expandPathAlias, clearTsConfigCache } from '../ts-config.js';

let root: string;

function write(rel: string, content = ''): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  clearTsConfigCache();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-tsimp-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ts-config', () => {
  it('returns null when no config exists', () => {
    // root is under os.tmpdir(); make sure nothing above has a config by using a nested dir
    const cfg = findTsPathConfig(path.join(root, 'a'));
    // tolerate an unrelated config above tmpdir, but it must not be ours
    expect(cfg === null || !cfg.configDir.startsWith(root)).toBe(true);
  });

  it('parses JSONC with comments and trailing commas, paths + baseUrl', () => {
    write(
      'tsconfig.json',
      `{
        // comment
        "compilerOptions": {
          /* block */ "baseUrl": "./src",
          "paths": { "@/*": ["./*"], "~lib/*": ["lib/*",], "url": ["http://x//y"] },
        },
      }`,
    );
    const cfg = findTsPathConfig(path.join(root, 'src', 'deep'));
    expect(cfg).not.toBeNull();
    expect(cfg!.configDir).toBe(root);
    expect(cfg!.baseUrl).toBe(path.join(root, 'src'));
    expect(expandPathAlias(cfg!, '@/utils/x')).toEqual([path.join(root, 'src', 'utils', 'x')]);
    expect(expandPathAlias(cfg!, '~lib/a')).toEqual([path.join(root, 'src', 'lib', 'a')]);
    expect(expandPathAlias(cfg!, 'nope')).toEqual([]);
  });

  it('picks the most specific pattern', () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: { '*': ['gen/*'], '@app/*': ['app/*'], '@app/special': ['s.ts'] },
        },
      }),
    );
    const cfg = findTsPathConfig(root)!;
    expect(expandPathAlias(cfg, '@app/special')).toEqual([path.join(root, 's.ts')]);
    expect(expandPathAlias(cfg, '@app/x')).toEqual([path.join(root, 'app', 'x')]);
    expect(expandPathAlias(cfg, 'other')).toEqual([path.join(root, 'gen', 'other')]);
  });

  it('follows relative extends chains and ignores package extends', () => {
    write(
      'base/tsconfig.base.json',
      JSON.stringify({ compilerOptions: { paths: { '@b/*': ['b/*'] } } }),
    );
    write('tsconfig.mid.json', JSON.stringify({ extends: './base/tsconfig.base' }));
    write(
      'pkg/tsconfig.json',
      JSON.stringify({ extends: ['@tsconfig/node20/tsconfig.json', '../tsconfig.mid.json'] }),
    );
    const cfg = findTsPathConfig(path.join(root, 'pkg'))!;
    expect(cfg.configDir).toBe(path.join(root, 'pkg'));
    // paths declared in base/ resolve relative to base/ when there is no baseUrl
    expect(expandPathAlias(cfg, '@b/x')).toEqual([path.join(root, 'base', 'b', 'x')]);
  });

  it('finds jsconfig.json and caches per directory', () => {
    write('jsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.' } }));
    const a = findTsPathConfig(root);
    expect(a!.baseUrl).toBe(root);
    expect(findTsPathConfig(root)).toBe(a);
  });
});

describe('TypeScript import resolution', () => {
  const adapter = new TypeScriptAdapter('typescript');

  async function parse(rel: string, source: string) {
    const filePath = write(rel, source);
    const parsed = await adapter.parse(filePath, source);
    const file = parsed.nodes.find((n) => n.kind === 'file')!;
    const meta = JSON.parse(file.meta) as {
      imports: Array<Record<string, unknown>>;
      reexports: Array<Record<string, unknown>>;
    };
    const importEdges = parsed.edges.filter((e) => e.kind === 'imports');
    return { parsed, meta, importEdges, fileId: file.id };
  }

  it('resolves .js suffix to .ts, directory to index.ts, and .mts', async () => {
    const util = write('src/util.ts');
    const idx = write('src/lib/index.ts');
    const esm = write('src/esm.mts');
    const { meta, importEdges } = await parse(
      'src/main.ts',
      `import { a } from './util.js';\nimport b from './lib';\nimport { c } from './esm.mjs';\n`,
    );
    expect(meta.imports.map((i) => i.source)).toEqual([util, idx, esm]);
    expect(importEdges.map((e) => e.toId).sort()).toEqual(
      [util, idx, esm].map((p) => `file:${p}`).sort(),
    );
    expect(meta.imports[0]).toMatchObject({ local: 'a', imported: 'a', isExternal: false });
    expect(meta.imports[1]).toMatchObject({ local: 'b', imported: 'default' });
  });

  it('resolves @/ aliases through tsconfig paths', async () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    );
    const x = write('src/utils/x.ts');
    const { meta, parsed } = await parse(
      'src/app.ts',
      `import { f } from '@/utils/x';\nimport g from '@/missing';\n`,
    );
    expect(meta.imports).toHaveLength(1);
    expect(meta.imports[0]).toMatchObject({ source: x, isExternal: false });
    expect(parsed.nodes.filter((n) => n.kind === 'external_dep')).toHaveLength(0);
  });

  it('resolves bare imports via baseUrl', async () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: 'src' } }));
    const m = write('src/models/user.ts');
    const { meta } = await parse(
      'src/app.ts',
      `import { U } from 'models/user';\nimport z from 'zod';\n`,
    );
    expect(meta.imports[0]).toMatchObject({ source: m, isExternal: false });
    expect(meta.imports[1]).toMatchObject({ source: 'zod', isExternal: true });
  });

  it('keeps scoped package names and maps builtins to node:<name>', async () => {
    const { meta, parsed } = await parse(
      'a.ts',
      `import x from '@scope/pkg/sub';\nimport fs from 'node:fs';\nimport p from 'fs';\nimport fp from 'fs/promises';\nimport l from 'lodash/fp';\n`,
    );
    expect(meta.imports.map((i) => i.source)).toEqual([
      '@scope/pkg',
      'node:fs',
      'node:fs',
      'node:fs',
      'lodash',
    ]);
    const names = parsed.nodes
      .filter((n) => n.kind === 'external_dep')
      .map((n) => n.name)
      .sort();
    expect(names).toEqual(['@scope/pkg', 'lodash', 'node:fs']);
  });

  it('records export * and named re-exports', async () => {
    const a = write('a.ts');
    const b = write('b.ts');
    const { meta, importEdges } = await parse(
      'index.ts',
      `export * from './a';\nexport * as ns from './a';\nexport { x as y, z } from './b';\nexport type { T } from './b';\n`,
    );
    expect(meta.reexports).toEqual([
      { source: a, isExternal: false, imported: '*', exported: '*' },
      { source: a, isExternal: false, imported: '*', exported: 'ns' },
      { source: b, isExternal: false, imported: 'x', exported: 'y' },
      { source: b, isExternal: false, imported: 'z', exported: 'z' },
      { source: b, isExternal: false, imported: 'T', exported: 'T' },
    ]);
    expect(importEdges.map((e) => e.reason).every((r) => r?.startsWith('re-export'))).toBe(true);
    expect(importEdges).toHaveLength(2);
  });

  it('captures dynamic import with a string literal only', async () => {
    const lazy = write('lazy.ts');
    const { meta } = await parse(
      'main.ts',
      `async function f(n: string) { const m = await import('./lazy'); await import(n); return m; }\n`,
    );
    expect(meta.imports).toEqual([
      { source: lazy, isExternal: false, local: 'm', imported: '*', dynamic: true },
    ]);
  });

  it('captures require bindings', async () => {
    const c = write('c.js');
    const jsAdapter = new TypeScriptAdapter('javascript');
    const filePath = write('main.js', '');
    const src = `const { a, b: bb } = require('./c');\nconst whole = require('./c');\nrequire('./c');\n`;
    const parsed = await jsAdapter.parse(filePath, src);
    const meta = JSON.parse(parsed.nodes.find((n) => n.kind === 'file')!.meta) as {
      imports: Array<Record<string, unknown>>;
    };
    const rows = meta.imports.map((i) => [i.local, i.imported]);
    expect(rows).toEqual([
      ['a', 'a'],
      ['bb', 'b'],
      ['whole', '*'],
      ['', '*'],
    ]);
    expect(meta.imports.every((i) => i.source === c)).toBe(true);
  });

  it('flags type-only imports and still emits the file edge', async () => {
    const t = write('types.ts');
    const { meta, importEdges } = await parse(
      'main.ts',
      `import type { A } from './types';\nimport { type B, C } from './types';\nimport D from './types';\nimport './types';\n`,
    );
    expect(meta.imports.map((i) => [i.local, i.typeOnly ?? false])).toEqual([
      ['A', true],
      ['B', true],
      ['C', false],
      ['D', false],
      ['', false],
    ]);
    expect(importEdges.map((e) => e.toId)).toEqual([`file:${t}`]);
  });

  it('handles namespace and default+named imports', async () => {
    write('m.ts');
    const { meta } = await parse(
      'main.ts',
      `import * as ns from './m';\nimport d, { e as f } from './m';\n`,
    );
    expect(meta.imports.map((i) => [i.local, i.imported])).toEqual([
      ['ns', '*'],
      ['d', 'default'],
      ['f', 'e'],
    ]);
  });
});
