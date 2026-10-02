/**
 * Tests for CommunityDetector: weighted Louvain, determinism, hubs, coupling,
 * persistence, and the connected-components fallback.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDb } from '../../graph/db.js';
import { GraphEngine } from '../../graph/engine.js';
import { CommunityDetector } from '../index.js';
import type { GraphNode, GraphEdge } from '../../types.js';

const NOW = Date.now();
const SIZE = 5;

function fileNode(dir: string, name: string): GraphNode {
  const filePath = `/root/${dir}/${name}.ts`;
  return {
    id: `file:${filePath}`,
    kind: 'file',
    name: `${name}.ts`,
    filePath,
    description: '',
    isExternal: false,
    language: 'typescript',
    meta: '{}',
    updatedAt: NOW,
  };
}

function edge(from: GraphNode, to: GraphNode, kind: GraphEdge['kind']): GraphEdge {
  return {
    id: `${from.id}|${kind}|${to.id}`,
    fromId: from.id,
    toId: to.id,
    kind,
    reason: '',
    updatedAt: NOW,
  };
}

interface Fixture {
  db: GraphDb;
  detector: CommunityDetector;
  tmpDir: string;
  alpha: GraphNode[];
  beta: GraphNode[];
}

/** Two dense 5-file clusters (alpha, beta) joined by a single import edge. */
async function buildFixture(): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-communities-test-'));
  const db = new GraphDb(tmpDir);
  await db.init();

  const alpha = Array.from({ length: SIZE }, (_, i) => fileNode('alpha', `a${i}`));
  const beta = Array.from({ length: SIZE }, (_, i) => fileNode('beta', `b${i}`));

  for (const group of [alpha, beta]) {
    for (const n of group) {
      db.upsertNode(n);
      db.upsertFile({
        filePath: n.filePath,
        language: 'typescript',
        contentHash: 'h',
        mtime: NOW,
        nodeCount: 1,
        edgeCount: 0,
        parsedAt: NOW,
      });
    }
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        db.upsertEdge(edge(group[j], group[i], 'calls'));
      }
      // index 0 is the hub: everyone imports it
      if (i > 0) db.upsertEdge(edge(group[i], group[0], 'imports'));
    }
  }
  // single bridge
  db.upsertEdge(edge(alpha[SIZE - 1], beta[0], 'imports'));

  const detector = new CommunityDetector(db, new GraphEngine(db));
  return { db, detector, tmpDir, alpha, beta };
}

describe('CommunityDetector (Louvain)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await buildFixture();
  });

  afterEach(() => {
    fx.db.close();
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it('runs Louvain and finds exactly the two clusters', () => {
    const comms = fx.detector.detect();
    expect(comms).toHaveLength(2);
    for (const c of comms) expect(c.algorithm).toBe('louvain');

    const fileSets = comms.map((c) => [...c.files].sort());
    expect(fileSets).toContainEqual(fx.alpha.map((n) => n.filePath).sort());
    expect(fileSets).toContainEqual(fx.beta.map((n) => n.filePath).sort());
    for (const c of comms) expect(c.nodeCount).toBe(SIZE);
  });

  it('is deterministic across runs', () => {
    const a = fx.detector.detect().map((c) => [...c.files].sort().join(','));
    const b = fx.detector.detect().map((c) => [...c.files].sort().join(','));
    expect(b).toEqual(a);
  });

  it('reports the highest fan-in node as the first hub of each community', () => {
    const comms = fx.detector.detect();
    const alphaComm = comms.find((c) => c.files.some((f) => f.includes('/alpha/')))!;
    const betaComm = comms.find((c) => c.files.some((f) => f.includes('/beta/')))!;
    expect(alphaComm.hubs[0].name).toBe('a0.ts');
    expect(betaComm.hubs[0].name).toBe('b0.ts');
    // hubs are sorted by descending fan-in
    for (const c of comms) {
      const fanIns = c.hubs.map((h) => h.fanIn);
      expect(fanIns).toEqual([...fanIns].sort((x, y) => y - x));
    }
  });

  it('computes small but non-zero coupling between the clusters', () => {
    const overview = fx.detector.overview();
    expect(overview.algorithm).toBe('louvain');
    expect(overview.coupling).toBeDefined();
    expect(overview.coupling).toHaveLength(1);
    const [pair] = overview.coupling!;
    expect(pair.edges).toBe(1);
    expect(pair.from).not.toBe(pair.to);
  });

  it('persists communities and assigns community ids to nodes', () => {
    const recs = fx.detector.detectAndPersist();
    expect(recs).toHaveLength(2);
    expect(fx.db.getCommunities()).toHaveLength(2);
    const members = recs.map((r) => fx.db.getCommunityMembers(r.id).length);
    expect(members).toEqual([SIZE, SIZE]);
  });
});

describe('CommunityDetector (fallback)', () => {
  let fx: Fixture;
  let stderr: jest.SpyInstance;

  beforeEach(async () => {
    fx = await buildFixture();
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    jest.dontMock('graphology-communities-louvain');
    fx.db.close();
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it('falls back to connected-components when the louvain loader fails', () => {
    jest.isolateModules(() => {
      jest.doMock('graphology-communities-louvain', () => {
        throw new Error('simulated loader failure');
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../index.js') as typeof import('../index.js');
      const detector = new mod.CommunityDetector(fx.db, new GraphEngine(fx.db));
      const comms = detector.detect();
      expect(comms.length).toBeGreaterThan(0);
      for (const c of comms) expect(c.algorithm).toBe('connected-components');
      expect(detector.overview().algorithm).toBe('connected-components');
    });
    const written = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('[cgb:communities]');
    expect(written).toContain('connected-components');
  });
});
