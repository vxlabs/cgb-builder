/**
 * Unit tests for git/changes.ts -- graph-aware change analysis.
 *
 * Uses a real (in-memory) GraphDb + GraphEngine populated with a small fixture:
 *
 *   src/auth.ts   --imports--> src/crypto.ts
 *   src/crypto.ts --imports--> src/utils.ts
 *   test/auth.test.ts --imports--> src/auth.ts   (test file)
 *
 * And a standalone file with no edges: src/config.ts
 *
 * Changes fixture:
 *   - src/auth.ts  modified  (+10/-2)
 *   - src/crypto.ts  added  (+30/-0)
 *   - src/unused.ts  deleted  (+0/-5)
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../../graph/db.js';
import { GraphEngine } from '../../graph/engine.js';
import type { GraphNode, GraphEdge } from '../../types.js';
import { analyzeChanges, collectBlastFiles } from '../changes.js';
import type { GitChange } from '../diff.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const NOW = Date.now();

function node(partial: Omit<GraphNode, 'updatedAt'>): GraphNode {
  return { ...partial, updatedAt: NOW };
}

function edge(partial: Omit<GraphEdge, 'updatedAt'>): GraphEdge {
  return { ...partial, updatedAt: NOW };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-git-test-'));
}

// ─── fixture ──────────────────────────────────────────────────────────────────

const ROOT = '/proj';

const F_AUTH    = `file:${ROOT}/src/auth.ts`;
const F_CRYPTO  = `file:${ROOT}/src/crypto.ts`;
const F_UTILS   = `file:${ROOT}/src/utils.ts`;
const F_CONFIG  = `file:${ROOT}/src/config.ts`;
const F_UNUSED  = `file:${ROOT}/src/unused.ts`;
const F_TEST    = `file:${ROOT}/test/auth.test.ts`;

const FIXTURE_NODES: GraphNode[] = [
  node({ id: F_AUTH,   kind: 'file', name: 'auth.ts',      filePath: `${ROOT}/src/auth.ts`,       description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: F_CRYPTO, kind: 'file', name: 'crypto.ts',    filePath: `${ROOT}/src/crypto.ts`,     description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: F_UTILS,  kind: 'file', name: 'utils.ts',     filePath: `${ROOT}/src/utils.ts`,      description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: F_CONFIG, kind: 'file', name: 'config.ts',    filePath: `${ROOT}/src/config.ts`,     description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: F_UNUSED, kind: 'file', name: 'unused.ts',    filePath: `${ROOT}/src/unused.ts`,     description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: F_TEST,   kind: 'file', name: 'auth.test.ts', filePath: `${ROOT}/test/auth.test.ts`, description: '', isExternal: false, language: 'typescript', meta: '{}' }),
];

const FIXTURE_EDGES: GraphEdge[] = [
  edge({ id: `${F_AUTH}|imports|${F_CRYPTO}`,  fromId: F_AUTH,   toId: F_CRYPTO, kind: 'imports', reason: 'crypto' }),
  edge({ id: `${F_CRYPTO}|imports|${F_UTILS}`, fromId: F_CRYPTO, toId: F_UTILS,  kind: 'imports', reason: 'utils'  }),
  edge({ id: `${F_TEST}|imports|${F_AUTH}`,    fromId: F_TEST,   toId: F_AUTH,   kind: 'imports', reason: 'test'   }),
];

// ─── test setup ───────────────────────────────────────────────────────────────

let tmpDir: string;
let db: GraphDb;
let engine: GraphEngine;

beforeAll(async () => {
  tmpDir = makeTmpDir();
  db = new GraphDb(tmpDir);
  await db.init();

  for (const n of FIXTURE_NODES) db.upsertNode(n);
  for (const e of FIXTURE_EDGES) db.upsertEdge(e);

  engine = new GraphEngine(db);
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── GIT_CHANGES fixture ──────────────────────────────────────────────────────

const GIT_CHANGES: GitChange[] = [
  {
    filePath: `${ROOT}/src/auth.ts`,
    status: 'modified',
    linesAdded: 10,
    linesRemoved: 2,
  },
  {
    filePath: `${ROOT}/src/crypto.ts`,
    status: 'added',
    linesAdded: 30,
    linesRemoved: 0,
  },
  {
    filePath: `${ROOT}/src/unused.ts`,
    status: 'deleted',
    linesAdded: 0,
    linesRemoved: 5,
  },
];

// ─── analyzeChanges ───────────────────────────────────────────────────────────

describe('analyzeChanges', () => {
  test('returns analysis with the correct number of change details', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    expect(analysis.changes).toHaveLength(3);
  });

  test('summary counters match the fixture', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    expect(analysis.summary.added).toBe(1);
    expect(analysis.summary.modified).toBe(1);
    expect(analysis.summary.deleted).toBe(1);
    expect(analysis.summary.totalChangedLines).toBe(10 + 2 + 30 + 5);
  });

  test('records per-file line counts', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    const auth = analysis.changes.find((c) => c.file.filePath.endsWith('auth.ts'));
    expect(auth).toBeDefined();
    expect(auth!.file.linesAdded).toBe(10);
    expect(auth!.file.linesRemoved).toBe(2);
  });

  test('computes a non-zero blast radius for auth.ts (has test importer)', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    const auth = analysis.changes.find((c) => c.file.filePath.endsWith('auth.ts'));
    // auth.ts is imported by auth.test.ts → blastRadius >= 1
    expect(auth!.blastRadius).toBeGreaterThanOrEqual(1);
  });

  test('identifies test file coverage for auth.ts', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    const auth = analysis.changes.find((c) => c.file.filePath.endsWith('auth.ts'));
    expect(auth!.hasTests).toBe(true);
  });

  test('deleted files preserve their status', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    const unused = analysis.changes.find((c) => c.file.filePath.endsWith('unused.ts'));
    expect(unused!.file.status).toBe('deleted');
  });

  test('overall risk is a valid band string', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    expect(['low', 'medium', 'high', 'critical']).toContain(analysis.overallRisk);
  });

  test('each change has a riskScore between 0 and 100', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    for (const c of analysis.changes) {
      expect(c.riskScore).toBeGreaterThanOrEqual(0);
      expect(c.riskScore).toBeLessThanOrEqual(100);
    }
  });

  test('changes are sorted by riskScore descending', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    for (let i = 1; i < analysis.changes.length; i++) {
      expect(analysis.changes[i - 1].riskScore).toBeGreaterThanOrEqual(analysis.changes[i].riskScore);
    }
  });

  test('returns empty analysis for zero git changes', () => {
    const analysis = analyzeChanges([], db, engine);
    expect(analysis.changes).toHaveLength(0);
    expect(analysis.summary.totalChangedLines).toBe(0);
    expect(analysis.overallRisk).toBe('low');
  });
});

// ─── collectBlastFiles ────────────────────────────────────────────────────────

describe('collectBlastFiles', () => {
  test('returns an array of file paths', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    const blast = collectBlastFiles(analysis, db);
    expect(Array.isArray(blast)).toBe(true);
  });

  test('does not include the originally changed files', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    const blast = collectBlastFiles(analysis, db);
    const changedPaths = new Set(analysis.changes.map((c) => c.file.filePath));
    for (const p of blast) {
      expect(changedPaths.has(p)).toBe(false);
    }
  });

  test('returns unique paths', () => {
    const analysis = analyzeChanges(GIT_CHANGES, db, engine);
    const blast = collectBlastFiles(analysis, db);
    expect(new Set(blast).size).toBe(blast.length);
  });

  test('returns empty array for empty analysis', () => {
    const emptyAnalysis = analyzeChanges([], db, engine);
    const blast = collectBlastFiles(emptyAnalysis, db);
    expect(blast).toEqual([]);
  });
});
