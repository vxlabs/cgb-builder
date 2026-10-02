/**
 * Tests for the headless-use features: DB directory option, root-relative storage,
 * programmatic API, JSON outputs, deterministic review-context and read-only MCP.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  GraphDb,
  openGraph,
  initGraph,
  CommunityDetector,
  FlowsAnalyzer,
  findLargeFunctions,
  WikiGenerator,
  buildReviewContext,
  relativizePaths,
} from '../index.js';
import { listTools, callTool, READ_ONLY_TOOLS } from '../mcp/server.js';
import * as providers from '../embed/providers.js';
import { hybridSearch, encodeVector } from '../embed/index.js';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'a.ts'),
    "import { b } from './b';\nexport function a(): number { return b() + 1; }\n",
  );
  fs.writeFileSync(
    path.join(root, 'src', 'b.ts'),
    "import { c } from './c';\nexport function b(): number { return c() + 1; }\n",
  );
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export function c(): number { return 1; }\n');
  fs.writeFileSync(
    path.join(root, 'src', 'a.test.ts'),
    "import { a } from './a';\nexport function t(): number { return a(); }\n",
  );
}

function git(root: string, cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: root,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

describe('GraphDb dbDir and portability', () => {
  const saved = process.env['CGB_DB_DIR'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CGB_DB_DIR'];
    else process.env['CGB_DB_DIR'] = saved;
  });

  it('honours dbDir > env CGB_DB_DIR > <root>/.cgb', async () => {
    const root = tmp('cgb-root-');
    const envDir = tmp('cgb-env-');
    const optDir = tmp('cgb-opt-');

    const d1 = new GraphDb(root);
    expect(d1.getDbDir()).toBe(path.join(root, '.cgb'));
    fs.rmSync(path.join(root, '.cgb'), { recursive: true });

    process.env['CGB_DB_DIR'] = envDir;
    expect(new GraphDb(root).getDbDir()).toBe(envDir);
    expect(new GraphDb(root, { dbDir: optDir }).getDbDir()).toBe(optDir);
    expect(fs.existsSync(path.join(root, '.cgb'))).toBe(false);
  });

  it('stores paths relative to the root and survives a root change', async () => {
    const rootA = tmp('cgb-wt-a-');
    const rootB = tmp('cgb-wt-b-');
    const dbDir = tmp('cgb-cache-');
    writeProject(rootA);
    writeProject(rootB);

    const first = await initGraph({ root: rootA, dbDir });
    expect(first.parsed).toBeGreaterThan(0);

    // No absolute root path may leak into the persisted DB.
    const raw = fs.readFileSync(path.join(dbDir, 'graph.db')).toString('latin1');
    expect(raw).not.toContain(rootA);
    expect(raw).not.toContain(JSON.stringify(rootA).slice(1, -1)); // JSON-escaped (meta)
    expect(raw).not.toContain(path.basename(rootA));
    expect(raw).toContain('src/a.ts');

    // Same cache, different worktree root: incremental rescan skips every file.
    const second = await initGraph({ root: rootB, dbDir });
    expect(second.parsed).toBe(0);
    expect(second.skipped).toBe(first.parsed + first.skipped);

    const g = await openGraph({ root: rootB, dbDir });
    try {
      const node = g.db.getNode(`file:${path.join(rootB, 'src', 'a.ts')}`);
      expect(node?.filePath).toBe(path.join(rootB, 'src', 'a.ts'));
      const deps = g.engine.deps(`file:${path.join(rootB, 'src', 'a.ts')}`, 3);
      expect(deps?.direct.map((d) => d.filePath)).toContain(path.join(rootB, 'src', 'b.ts'));
    } finally {
      g.close();
    }
    expect(fs.existsSync(path.join(rootB, '.cgb'))).toBe(false);
  });

  it('prunes files that disappeared since the cached scan', async () => {
    const root = tmp('cgb-prune-');
    const dbDir = tmp('cgb-prune-db-');
    writeProject(root);
    await initGraph({ root, dbDir });
    fs.rmSync(path.join(root, 'src', 'c.ts'));
    await initGraph({ root, dbDir });
    const g = await openGraph({ root, dbDir });
    try {
      expect(g.db.getNode(`file:${path.join(root, 'src', 'c.ts')}`)).toBeNull();
    } finally {
      g.close();
    }
  });

  it('readOnly never creates or writes the DB file', async () => {
    const root = tmp('cgb-ro-');
    const dbDir = path.join(tmp('cgb-ro-db-'), 'nested');
    await expect(openGraph({ root, dbDir, readOnly: true })).rejects.toThrow(/not found/);
    expect(fs.existsSync(dbDir)).toBe(false);

    writeProject(root);
    const real = tmp('cgb-ro-real-');
    await initGraph({ root, dbDir: real });
    const before = fs.readFileSync(path.join(real, 'graph.db'));
    const g = await openGraph({ root, dbDir: real, readOnly: true });
    g.db.persist();
    g.close();
    expect(fs.readFileSync(path.join(real, 'graph.db')).equals(before)).toBe(true);
  });
});

describe('library exports and JSON analyses', () => {
  it('exposes analyzers working over openGraph()', async () => {
    const root = tmp('cgb-lib-');
    const dbDir = tmp('cgb-lib-db-');
    writeProject(root);
    const stats = await initGraph({ root, dbDir });
    expect(stats.files).toBe(4);

    const g = await openGraph({ root, dbDir });
    try {
      const detector = new CommunityDetector(g.db, g.engine);
      const communities = relativizePaths(detector.detect(), root);
      expect(Array.isArray(communities)).toBe(true);
      expect(JSON.stringify(communities)).not.toContain(root);

      const overview = detector.overview();
      expect(overview.totalFiles).toBe(4);

      const flows = new FlowsAnalyzer(g.db);
      expect(Array.isArray(flows.entryPoints(5))).toBe(true);
      expect(Array.isArray(flows.criticalityScores(5))).toBe(true);
      expect(Array.isArray(findLargeFunctions(g.db, 5))).toBe(true);

      const wiki = new WikiGenerator(g.db, detector).generateJson(root);
      expect(wiki.length).toBeGreaterThan(0);
      for (const page of wiki) {
        expect(Object.keys(page).sort()).toEqual(['communityId', 'files', 'markdown', 'title']);
        expect(page.markdown).not.toContain(root);
        expect(page.markdown).not.toMatch(/Auto-generated by CGB on/);
        page.files.forEach((f) => {
          expect(path.isAbsolute(f)).toBe(false);
          expect(f).not.toContain('\\');
        });
      }
      expect(wiki[wiki.length - 1].communityId).toBe('index');
    } finally {
      g.close();
    }
  });

  it('review-context JSON is stable and root-independent', async () => {
    const root = tmp('cgb-rc-');
    const dbDir = tmp('cgb-rc-db-');
    writeProject(root);
    git(root, 'init -q');
    git(root, 'add -A');
    git(root, 'commit -q -m base');
    fs.appendFileSync(path.join(root, 'src', 'c.ts'), 'export const z = 2;\n');
    fs.appendFileSync(path.join(root, 'src', 'a.ts'), 'export const y = 2;\n');
    git(root, 'add -A');
    git(root, 'commit -q -m change');

    await initGraph({ root, dbDir });
    const run = async (): Promise<string> => {
      const g = await openGraph({ root, dbDir });
      try {
        const ctx = await buildReviewContext(root, g.db, g.engine, 'HEAD~1');
        return JSON.stringify(relativizePaths(ctx, root), null, 2);
      } finally {
        g.close();
      }
    };
    const a = await run();
    const b = await run();
    expect(a).toBe(b);
    expect(a).not.toContain(root);
    const parsed = JSON.parse(a) as { changedFiles: string[]; affectedFiles: string[] };
    expect(parsed.changedFiles).toEqual(['src/a.ts', 'src/c.ts']);
    expect([...parsed.affectedFiles].sort()).toEqual(parsed.affectedFiles);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('read-only MCP', () => {
  it('lists exactly the allowed tools', () => {
    const names = listTools({ readOnly: true }).map((t) => t.name);
    expect([...names].sort()).toEqual([...READ_ONLY_TOOLS].sort());
    for (const banned of [
      'cgb_init',
      'cgb_apply_refactor',
      'cgb_wiki_generate',
      'cgb_registry_register',
      'cgb_embed_build',
    ]) {
      expect(names).not.toContain(banned);
    }
    expect(listTools({}).map((t) => t.name)).toContain('cgb_init');
  });

  it('rejects mutating tools and does not modify the DB or root', async () => {
    const root = tmp('cgb-mcp-');
    const dbDir = tmp('cgb-mcp-db-');
    writeProject(root);
    await initGraph({ root, dbDir });
    const dbFile = path.join(dbDir, 'graph.db');
    const before = fs.readFileSync(dbFile);
    const opts = { readOnly: true, dbDir, root };

    const denied = await callTool('cgb_init', { root }, opts);
    expect((denied as { isError?: boolean }).isError).toBe(true);
    const denied2 = await callTool('cgb_embed_build', { root }, opts);
    expect((denied2 as { isError?: boolean }).isError).toBe(true);

    for (const tool of ['cgb_stats', 'cgb_communities', 'cgb_architecture', 'cgb_entry_points']) {
      const res = await callTool(tool, {}, opts);
      expect((res as { isError?: boolean }).isError).toBeUndefined();
    }
    const search = await callTool('cgb_search', { query: 'b' }, opts);
    expect(JSON.stringify(search)).toContain('b');

    expect(fs.readFileSync(dbFile).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(root, '.cgb'))).toBe(false);
    expect(fs.existsSync(path.join(dbDir, 'embed-meta.json'))).toBe(false);
  });

  it('refuses remote embedding providers when localOnly', async () => {
    const root = tmp('cgb-emb-');
    const dbDir = tmp('cgb-emb-db-');
    writeProject(root);
    await initGraph({ root, dbDir });
    const g = await openGraph({ root, dbDir });
    try {
      const some = g.db.getAllNodes()[0];
      g.db.upsertEmbedding({
        nodeId: some.id,
        vector: encodeVector([0.1, 0.2, 0.3]),
        textHash: 'x',
        provider: 'google',
      });
      fs.writeFileSync(path.join(dbDir, 'embed-meta.json'), JSON.stringify({ provider: 'google' }));
      const spy = jest.spyOn(providers, 'getProvider');
      await hybridSearch(g.db, 'b', { localOnly: true });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      g.close();
    }
  });
});
