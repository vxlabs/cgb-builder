/**
 * Unit tests for GraphEngine — graph traversal logic.
 *
 * Uses a real GraphDb (in-memory sql.js) populated with a small fixture graph:
 *
 *   FileA --imports--> FileB --imports--> FileC --imports--> ExtLodash
 *   FileA --imports--> FileC
 *   FileA --exports--> ClassX
 *   ClassX --inherits--> ClassY  (ClassY lives in FileB)
 *   FileD  (orphan — no edges)
 *
 * This covers: deps, impact, path, search, cycles, orphans.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../db.js';
import { GraphEngine } from '../engine.js';
import type { GraphNode, GraphEdge } from '../../types.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-engine-test-'));
}

const NOW = Date.now();

function node(partial: Omit<GraphNode, 'updatedAt'>): GraphNode {
  return { ...partial, updatedAt: NOW };
}

function edge(partial: Omit<GraphEdge, 'updatedAt'>): GraphEdge {
  return { ...partial, updatedAt: NOW };
}

// ─── fixture ──────────────────────────────────────────────────────────────────

const FA = 'file:/root/a.ts';
const FB = 'file:/root/b.ts';
const FC = 'file:/root/c.ts';
const FD = 'file:/root/d.ts'; // orphan
const EXT = 'external_dep:lodash';
const CX = 'class:/root/a.ts#X';
const CY = 'class:/root/b.ts#Y';

const FIXTURE_NODES: GraphNode[] = [
  node({ id: FA,  kind: 'file',         name: 'a.ts',   filePath: '/root/a.ts', description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: FB,  kind: 'file',         name: 'b.ts',   filePath: '/root/b.ts', description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: FC,  kind: 'file',         name: 'c.ts',   filePath: '/root/c.ts', description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: FD,  kind: 'file',         name: 'd.ts',   filePath: '/root/d.ts', description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: EXT, kind: 'external_dep', name: 'lodash', filePath: 'lodash',     description: '', isExternal: true,  language: null,         meta: '{}' }),
  node({ id: CX,  kind: 'class',        name: 'X',      filePath: '/root/a.ts', description: '', isExternal: false, language: 'typescript', meta: '{}' }),
  node({ id: CY,  kind: 'class',        name: 'Y',      filePath: '/root/b.ts', description: '', isExternal: false, language: 'typescript', meta: '{}' }),
];

const FIXTURE_EDGES: GraphEdge[] = [
  edge({ id: `${FA}|imports|${FB}`, fromId: FA,  toId: FB,  kind: 'imports',  reason: 'imports b' }),
  edge({ id: `${FA}|imports|${FC}`, fromId: FA,  toId: FC,  kind: 'imports',  reason: 'imports c' }),
  edge({ id: `${FB}|imports|${FC}`, fromId: FB,  toId: FC,  kind: 'imports',  reason: 'imports c' }),
  edge({ id: `${FC}|imports|${EXT}`,fromId: FC,  toId: EXT, kind: 'imports',  reason: 'imports lodash' }),
  edge({ id: `${FA}|exports|${CX}`, fromId: FA,  toId: CX,  kind: 'exports',  reason: 'defines class X' }),
  edge({ id: `${CX}|inherits|${CY}`,fromId: CX,  toId: CY,  kind: 'inherits', reason: 'extends Y' }),
];

// ─── setup ────────────────────────────────────────────────────────────────────

async function buildFixtureDb(): Promise<{ db: GraphDb; engine: GraphEngine; tmpDir: string }> {
  const tmpDir = makeTmpDir();
  const db = new GraphDb(tmpDir);
  await db.init();
  for (const n of FIXTURE_NODES) db.upsertNode(n);
  for (const e of FIXTURE_EDGES) db.upsertEdge(e);
  const engine = new GraphEngine(db);
  return { db, engine, tmpDir };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('GraphEngine', () => {
  let db: GraphDb;
  let engine: GraphEngine;
  let tmpDir: string;

  beforeEach(async () => {
    ({ db, engine, tmpDir } = await buildFixtureDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── deps ──────────────────────────────────────────────────────────────────

  describe('deps()', () => {
    it('returns null for unknown node', () => {
      expect(engine.deps('file:/nonexistent')).toBeNull();
    });

    it('returns direct imports of FileA', () => {
      const result = engine.deps(FA, 1);
      expect(result).not.toBeNull();
      expect(result!.direct.map(n => n.id)).toContain(FB);
      expect(result!.direct.map(n => n.id)).toContain(FC);
    });

    it('returns transitive deps at depth 2', () => {
      const result = engine.deps(FA, 2);
      expect(result).not.toBeNull();
      // FA → FB → FC → EXT should all be reachable
      const allIds = [...result!.direct, ...result!.transitive].map(n => n.id);
      expect(allIds).toContain(FC);
      expect(allIds).toContain(EXT);
    });

    it('depth 1 does not include transitive deps', () => {
      const result = engine.deps(FA, 1);
      expect(result!.transitive).toHaveLength(0);
    });
  });

  // ── impact ────────────────────────────────────────────────────────────────

  describe('impact()', () => {
    it('returns null for unknown node', () => {
      expect(engine.impact('file:/nonexistent')).toBeNull();
    });

    it('FileC impacts FileA and FileB (they import it)', () => {
      const result = engine.impact(FC);
      expect(result).not.toBeNull();
      const affectedIds = result!.affected.map(a => a.node.id);
      expect(affectedIds).toContain(FA);
      expect(affectedIds).toContain(FB);
    });

    it('FileB impacts FileA', () => {
      const result = engine.impact(FB);
      expect(result).not.toBeNull();
      const affectedIds = result!.affected.map(a => a.node.id);
      expect(affectedIds).toContain(FA);
    });

    it('FileA has no importers (nothing depends on it)', () => {
      const result = engine.impact(FA);
      expect(result).not.toBeNull();
      expect(result!.affected).toHaveLength(0);
    });

    it('returns depth information', () => {
      const result = engine.impact(FC);
      const faEntry = result!.affected.find(a => a.node.id === FA);
      expect(faEntry).toBeDefined();
      expect(faEntry!.depth).toBeGreaterThan(0);
    });
  });

  // ── path ──────────────────────────────────────────────────────────────────

  describe('path()', () => {
    it('returns null when either node is missing', () => {
      expect(engine.path('file:/x', FB)).toBeNull();
      expect(engine.path(FA, 'file:/x')).toBeNull();
    });

    it('finds direct path A → B', () => {
      const result = engine.path(FA, FB);
      expect(result).not.toBeNull();
      expect(result!.path[0].id).toBe(FA);
      expect(result!.path[result!.path.length - 1].id).toBe(FB);
    });

    it('finds path A → C (via direct import)', () => {
      const result = engine.path(FA, FC);
      expect(result).not.toBeNull();
      expect(result!.path.length).toBeGreaterThanOrEqual(2);
    });

    it('returns null when no path exists', () => {
      // FD is an orphan; nothing points to or from it via imports
      expect(engine.path(FD, FA)).toBeNull();
    });
  });

  // ── search ────────────────────────────────────────────────────────────────

  describe('search()', () => {
    it('finds nodes by name', () => {
      const results = engine.search('b.ts');
      expect(results.some(n => n.id === FB)).toBe(true);
    });

    it('finds nodes by class name', () => {
      // Our fixture node name is 'X', description is empty — try searching 'X'
      const byName = engine.search('X');
      expect(byName.some(n => n.id === CX)).toBe(true);
    });

    it('returns empty array for no match', () => {
      expect(engine.search('zzz_no_match_zzz')).toHaveLength(0);
    });
  });

  // ── detectCycles ──────────────────────────────────────────────────────────

  describe('detectCycles()', () => {
    it('returns no cycles in fixture (acyclic graph)', () => {
      const cycles = engine.detectCycles();
      expect(cycles).toHaveLength(0);
    });

    it('detects a cycle when one is introduced', async () => {
      // Add a back-edge: FC → FA (creates cycle FA → FC → FA indirectly)
      db.upsertEdge(edge({
        id: `${FC}|imports|${FA}`,
        fromId: FC,
        toId: FA,
        kind: 'imports',
        reason: 'cycle edge',
      }));
      const cycles = engine.detectCycles();
      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  // ── orphans ───────────────────────────────────────────────────────────────

  describe('orphans()', () => {
    it('identifies FileD as an orphan', () => {
      const orphans = engine.orphans();
      expect(orphans.some(n => n.id === FD)).toBe(true);
    });

    it('does not mark connected files as orphans', () => {
      const orphans = engine.orphans();
      expect(orphans.some(n => n.id === FA)).toBe(false);
      expect(orphans.some(n => n.id === FB)).toBe(false);
      expect(orphans.some(n => n.id === FC)).toBe(false);
    });
  });

  // ── findByFile ────────────────────────────────────────────────────────────

  describe('findByFile()', () => {
    it('returns all nodes for the given file', () => {
      const nodes = engine.findByFile('/root/a.ts');
      const ids = nodes.map(n => n.id);
      expect(ids).toContain(FA);
      expect(ids).toContain(CX);
    });
  });
});
