/**
 * Community detection using weighted Louvain algorithm (graphology).
 *
 * Replaces Union-Find connected components with proper modularity-optimising
 * Louvain, weighted by edge kind. Two-stage detection splits large communities
 * (>50 nodes) with a sub-graph pass (level=1).
 *
 * Also provides an architecture overview: cross-community coupling matrix,
 * cycle detection, and health scoring.
 */

import type { GraphDb } from '../graph/db.js';
import type { GraphEngine } from '../graph/engine.js';
import type { CommunityRecord, GraphNode, GraphEdge } from '../types.js';
import { debug, warnOnce } from '../util/log.js';

export type { CommunityRecord };

// ─── Legacy Community type (kept for backward compat with wiki/server) ────────

export type CommunityAlgorithm = 'louvain' | 'connected-components';

export interface Community {
  id: string;
  label: string;
  files: string[];
  nodeCount: number;
  hubs: Array<{ name: string; filePath: string; fanIn: number }>;
  role: 'ui' | 'service' | 'data' | 'util' | 'config' | 'test' | 'unknown';
  cohesion?: number;
  dominantLanguage?: string | null;
  /** Which algorithm produced this community. */
  algorithm: CommunityAlgorithm;
}

export interface ArchitectureOverview {
  algorithm: CommunityAlgorithm;
  totalFiles: number;
  totalNodes: number;
  communities: Community[];
  layers: Array<{ layer: string; nodeCount: number; kinds: Record<string, number> }>;
  cycles: string[][];
  orphans: string[];
  healthScore: number;
  healthNotes: string[];
  coupling?: Array<{ from: string; to: string; edges: number }>;
}

// ─── Edge weights for Louvain ─────────────────────────────────────────────────

const EDGE_WEIGHTS: Record<string, number> = {
  calls: 1.0,
  inherits: 0.8,
  implements: 0.7,
  depends_on: 0.6,
  imports: 0.5,
  tested_by: 0.4,
  contains: 0.3,
};

const MIN_COMMUNITY_SIZE = 2;
const SPLIT_THRESHOLD = 50;

// ─── CommunityDetector ────────────────────────────────────────────────────────

export class CommunityDetector {
  constructor(
    private readonly db: GraphDb,
    private readonly engine: GraphEngine,
  ) {}

  /**
   * Detect and persist communities using weighted Louvain.
   * Clears existing community data, writes community rows, and assigns
   * community_id to every node in the DB.
   * Returns communities sorted by size descending.
   */
  detectAndPersist(): CommunityRecord[] {
    return this.detectAndPersistWithResult().records;
  }

  /** Same as detectAndPersist but also returns the detected communities (single detection pass). */
  detectAndPersistWithResult(): { records: CommunityRecord[]; communities: Community[] } {
    const communities = this.detectSync();
    const now = Date.now();

    // Load nodes once and index by file (was one getAllNodes() per community).
    const nodesByFile = new Map<string, GraphNode[]>();
    for (const n of this.db.getAllNodes()) {
      const list = nodesByFile.get(n.filePath);
      if (list) list.push(n);
      else nodesByFile.set(n.filePath, [n]);
    }

    this.db.clearCommunities();
    const inserted: CommunityRecord[] = [];

    for (const comm of communities) {
      const rec: Omit<CommunityRecord, 'id'> = {
        name: comm.label,
        level: 0,
        parentId: null,
        cohesion: comm.cohesion ?? 0,
        size: comm.nodeCount,
        dominantLanguage: comm.dominantLanguage ?? null,
        description: `${comm.role} community with ${comm.nodeCount} nodes`,
        createdAt: now,
      };
      const id = this.db.upsertCommunity(rec);
      inserted.push({ ...rec, id });

      // Assign community_id to every node in this community's files
      for (const fp of new Set(comm.files)) {
        for (const node of nodesByFile.get(fp) ?? []) {
          this.db.updateNodeCommunity(node.id, id);
        }
      }
    }

    return { records: inserted, communities };
  }

  /**
   * Detect communities using weighted Louvain. Returns legacy Community[] shape
   * for backward compat with MCP handlers that don't persist.
   */
  detect(): Community[] {
    return this.detectSync();
  }

  /**
   * Build a high-level architecture overview.
   */
  overview(): ArchitectureOverview {
    const stats = this.db.getStats();
    const communities = this.detectSync();
    const layers = this.engine.layers().slice(0, 20);
    const cycles = this.engine.detectCycles().slice(0, 5);
    const orphans = this.engine
      .orphans()
      .slice(0, 10)
      .map((n) => n.filePath);

    // Cross-community coupling
    const coupling = this.computeCoupling(communities);

    const healthNotes: string[] = [];
    if (cycles.length > 0)
      healthNotes.push(`${cycles.length} circular dependency cycle(s) detected`);
    if (orphans.length > 0)
      healthNotes.push(`${orphans.length} orphan file(s) with no connections`);

    const largestCommunity = communities[0];
    if (largestCommunity && largestCommunity.nodeCount > stats.files * 0.5) {
      healthNotes.push(
        'Over 50% of files belong to a single community — consider splitting into modules',
      );
    }

    const heavyCoupling = coupling.filter((c) => c.edges > 10);
    if (heavyCoupling.length > 0) {
      healthNotes.push(
        `${heavyCoupling.length} community pair(s) are tightly coupled (>10 cross-edges) — consider reducing dependencies`,
      );
    }

    let healthScore = 100;
    healthScore -= cycles.length * 10;
    healthScore -= Math.floor(orphans.length * 2);
    healthScore -= heavyCoupling.length * 5;
    if (largestCommunity && largestCommunity.nodeCount > stats.files * 0.7) healthScore -= 15;
    healthScore = Math.max(0, healthScore);

    return {
      algorithm: communities[0]?.algorithm ?? this.lastAlgorithm,
      totalFiles: stats.files,
      totalNodes: stats.nodes,
      communities,
      layers,
      cycles,
      orphans,
      healthScore,
      healthNotes,
      coupling: coupling.slice(0, 20),
    };
  }

  // ─── Private: Louvain run ─────────────────────────────────────────────────

  /** Algorithm used by the most recent detection run. */
  private lastAlgorithm: CommunityAlgorithm = 'louvain';

  private detectSync(): Community[] {
    const ctx = this.loadContext();
    try {
      const result = this.runLouvainSync(ctx);
      this.lastAlgorithm = 'louvain';
      return result;
    } catch (err) {
      // Fallback to file-based connected components if graphology is unavailable or fails
      warnOnce(
        'communities',
        'fallback',
        'Louvain unavailable; falling back to connected-components (import-based) communities',
        err,
      );
      this.lastAlgorithm = 'connected-components';
      return this.fallbackDetect(ctx);
    }
  }

  /** Load nodes/edges once and precompute degree and adjacency lookups. */
  private loadContext(): DetectContext {
    const allNodes = this.db.getAllNodes();
    const allEdges = this.db.getAllEdges();
    const fanIn = new Map<string, number>();
    const edgesByNode = new Map<string, GraphEdge[]>();
    const push = (id: string, e: GraphEdge): void => {
      const list = edgesByNode.get(id);
      if (list) list.push(e);
      else edgesByNode.set(id, [e]);
    };
    for (const e of allEdges) {
      push(e.fromId, e);
      if (e.toId !== e.fromId) push(e.toId, e);
      if (e.kind === 'calls' || e.kind === 'imports') {
        fanIn.set(e.toId, (fanIn.get(e.toId) ?? 0) + 1);
      }
    }
    const hubNodesByFile = new Map<string, GraphNode[]>();
    const nodesById = new Map<string, GraphNode>();
    for (const n of allNodes) {
      nodesById.set(n.id, n);
      if (n.isExternal) continue;
      if (n.kind === 'file' || n.kind === 'class' || n.kind === 'function' || n.kind === 'method') {
        const list = hubNodesByFile.get(n.filePath);
        if (list) list.push(n);
        else hubNodesByFile.set(n.filePath, [n]);
      }
    }
    return { allNodes, allEdges, fanIn, edgesByNode, hubNodesByFile, nodesById };
  }

  private runLouvainSync(ctx: DetectContext): Community[] {
    const { Graph, louvain } = loadGraphology();

    const allNodes = ctx.allNodes.filter((n) => !n.isExternal);
    if (allNodes.length === 0) return [];

    const graph = buildGraph(Graph, allNodes, ctx.allEdges);
    const partition = louvain(graph, louvainOptions());

    // Group nodes by community index
    const groups = new Map<number, string[]>();
    for (const [nodeId, communityIdx] of Object.entries(partition)) {
      const list = groups.get(communityIdx) ?? [];
      list.push(nodeId);
      groups.set(communityIdx, list);
    }

    const communities: Community[] = [];
    let communityIndex = 0;

    for (const [, memberIds] of groups) {
      if (memberIds.length < MIN_COMMUNITY_SIZE) continue;

      const validNodes = memberIds
        .map((id) => ctx.nodesById.get(id))
        .filter((n): n is GraphNode => n !== undefined);

      // Two-stage: split large communities with sub-graph Louvain
      if (validNodes.length > SPLIT_THRESHOLD) {
        const subCommunities = this.splitLargeCommunity(validNodes, communityIndex, ctx);
        communities.push(...subCommunities);
        communityIndex += subCommunities.length;
        continue;
      }

      const files = [...new Set(validNodes.map((n) => n.filePath))];
      communities.push({
        id: `community-${communityIndex++}`,
        label: this.deriveName(validNodes),
        files,
        nodeCount: validNodes.length,
        hubs: this.findHubs(files, ctx),
        role: this.inferRole(files),
        cohesion: this.computeCohesion(memberIds, ctx),
        dominantLanguage: this.dominantLanguage(validNodes),
        algorithm: 'louvain',
      });
    }

    return communities.sort((a, b) => b.nodeCount - a.nodeCount);
  }

  private splitLargeCommunity(
    nodes: GraphNode[],
    startIdx: number,
    ctx: DetectContext,
  ): Community[] {
    const asWhole = (): Community[] => {
      const files = [...new Set(nodes.map((n) => n.filePath))];
      return [
        {
          id: `community-${startIdx}`,
          label: this.deriveName(nodes),
          files,
          nodeCount: nodes.length,
          hubs: this.findHubs(files, ctx),
          role: this.inferRole(files),
          cohesion: this.computeCohesion(
            nodes.map((n) => n.id),
            ctx,
          ),
          dominantLanguage: this.dominantLanguage(nodes),
          algorithm: 'louvain',
        },
      ];
    };

    try {
      const { Graph, louvain } = loadGraphology();
      const subGraph = buildGraph(Graph, nodes, ctx.allEdges);
      const partition = louvain(subGraph, louvainOptions());
      const groups = new Map<number, string[]>();
      for (const [nodeId, idx] of Object.entries(partition)) {
        const list = groups.get(idx) ?? [];
        list.push(nodeId);
        groups.set(idx, list);
      }

      const result: Community[] = [];
      let i = startIdx;
      const parentLabel = this.deriveName(nodes);

      for (const [, memberIds] of groups) {
        if (memberIds.length < MIN_COMMUNITY_SIZE) continue;
        const memberNodes = memberIds
          .map((id) => ctx.nodesById.get(id))
          .filter((n): n is GraphNode => n !== undefined);
        const files = [...new Set(memberNodes.map((n) => n.filePath))];
        result.push({
          id: `community-${i++}`,
          label: `${parentLabel}/${this.deriveName(memberNodes)}`,
          files,
          nodeCount: memberNodes.length,
          hubs: this.findHubs(files, ctx),
          role: this.inferRole(files),
          cohesion: this.computeCohesion(memberIds, ctx),
          dominantLanguage: this.dominantLanguage(memberNodes),
          algorithm: 'louvain',
        });
      }
      return result.length > 0 ? result.sort((a, b) => b.nodeCount - a.nodeCount) : asWhole();
    } catch (err) {
      // Return the large community as-is
      debug('communities', 'sub-community split failed; keeping community whole', err);
      return asWhole();
    }
  }

  // ─── Private: naming & metrics ────────────────────────────────────────────

  private deriveName(nodes: GraphNode[]): string {
    if (nodes.length === 0) return 'cluster';

    // 1. Common directory prefix
    const dirs = nodes.map((n) => {
      const parts = n.filePath.replace(/\\/g, '/').split('/');
      parts.pop();
      return parts.join('/');
    });
    const common = this.commonPrefix(dirs);
    if (common) {
      const tail = common.split('/').filter(Boolean).pop();
      if (tail && tail.length > 2) return tail;
    }

    // 2. Dominant class name (>40% of nodes are classes/interfaces)
    const classNodes = nodes.filter((n) => n.kind === 'class' || n.kind === 'interface');
    if (classNodes.length / nodes.length > 0.4 && classNodes[0]) {
      return classNodes[0].name;
    }

    // 3. Keyword extraction from node names
    const names = nodes.map((n) => n.name).join(' ');
    const keywords = names.match(/[A-Z][a-z]+|[a-z]+/g) ?? [];
    const freq = new Map<string, number>();
    for (const kw of keywords) {
      if (kw.length < 3) continue;
      freq.set(kw, (freq.get(kw) ?? 0) + 1);
    }
    const topKw = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topKw && topKw[1] >= 2) return topKw[0];

    // 4. Fallback
    return `cluster-${nodes.length}`;
  }

  private commonPrefix(strs: string[]): string {
    if (strs.length === 0) return '';
    let prefix = strs[0];
    for (const s of strs.slice(1)) {
      while (!s.startsWith(prefix)) {
        prefix = prefix.slice(0, prefix.lastIndexOf('/'));
        if (!prefix) return '';
      }
    }
    return prefix;
  }

  private computeCohesion(nodeIds: string[], ctx: DetectContext): number {
    if (nodeIds.length < 2) return 1;
    const idSet = new Set(nodeIds);
    let internal = 0;
    let external = 0;
    for (const nodeId of nodeIds) {
      for (const edge of ctx.edgesByNode.get(nodeId) ?? []) {
        const other = edge.fromId === nodeId ? edge.toId : edge.fromId;
        if (idSet.has(other)) internal++;
        else external++;
      }
    }
    internal = Math.floor(internal / 2); // undirected: counted twice
    return internal + external === 0 ? 1 : internal / (internal + external);
  }

  private dominantLanguage(nodes: GraphNode[]): string | null {
    const freq = new Map<string, number>();
    for (const n of nodes) {
      if (n.language) freq.set(n.language, (freq.get(n.language) ?? 0) + 1);
    }
    if (freq.size === 0) return null;
    return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  private inferRole(files: string[]): Community['role'] {
    const paths = files.join(' ').toLowerCase();
    if (/\/(test|__tests?__|spec)\//i.test(paths) || /\.(test|spec)\./i.test(paths)) return 'test';
    if (/\/(component|page|view|ui|screen)\//i.test(paths)) return 'ui';
    if (/\/(service|controller|handler|api|route)\//i.test(paths)) return 'service';
    if (/\/(model|entity|schema|repo|database|db|store)\//i.test(paths)) return 'data';
    if (/\/(config|settings|env)\//i.test(paths)) return 'config';
    if (/\/(util|helper|common|shared|lib)\//i.test(paths)) return 'util';
    return 'unknown';
  }

  private findHubs(files: string[], ctx: DetectContext): Community['hubs'] {
    const hubs: Community['hubs'] = [];
    for (const fp of new Set(files)) {
      for (const node of ctx.hubNodesByFile.get(fp) ?? []) {
        const fanIn = ctx.fanIn.get(node.id) ?? 0;
        if (fanIn > 0) hubs.push({ name: node.name, filePath: node.filePath, fanIn });
      }
    }
    return hubs.sort((a, b) => b.fanIn - a.fanIn).slice(0, 5);
  }

  private computeCoupling(
    communities: Community[],
  ): Array<{ from: string; to: string; edges: number }> {
    // Build file -> community index once, then nodeId -> community via the node's file.
    const fileToComm = new Map<string, number>();
    communities.forEach((comm, idx) => {
      for (const fp of comm.files) fileToComm.set(fp, idx);
    });
    const nodeToComm = new Map<string, number>();
    for (const n of this.db.getAllNodes()) {
      const idx = fileToComm.get(n.filePath);
      if (idx !== undefined) nodeToComm.set(n.id, idx);
    }

    const counts = new Map<string, { a: number; b: number; edges: number }>();
    for (const edge of this.db.getAllEdges()) {
      const fromComm = nodeToComm.get(edge.fromId);
      const toComm = nodeToComm.get(edge.toId);
      if (fromComm === undefined || toComm === undefined || fromComm === toComm) continue;
      const a = Math.min(fromComm, toComm);
      const b = Math.max(fromComm, toComm);
      const key = `${a}|${b}`;
      const entry = counts.get(key);
      if (entry) entry.edges++;
      else counts.set(key, { a, b, edges: 1 });
    }

    return [...counts.values()]
      .map(({ a, b, edges }) => {
        const [from, to] = [communities[a].label, communities[b].label].sort();
        return { from, to, edges };
      })
      .sort((x, y) => y.edges - x.edges);
  }

  // ─── Fallback: Union-Find (when graphology unavailable) ───────────────────

  private fallbackDetect(ctx: DetectContext): Community[] {
    const files = this.db.getAllFiles().map((f) => f.filePath);
    if (files.length === 0) return [];

    const parent = new Map<string, string>();
    for (const fp of files) parent.set(fp, fp);

    const find = (x: string): string => {
      const p = parent.get(x) ?? x;
      if (p !== x) parent.set(x, find(p));
      return parent.get(x) ?? x;
    };
    const union = (a: string, b: string): void => {
      parent.set(find(a), find(b));
    };

    const fileNodes = this.db.getNodesByKind(['file']);
    for (const node of fileNodes) {
      const edges = this.db.getEdgesFromByKind(node.id, 'imports');
      for (const edge of edges) {
        const toNode = this.db.getNode(edge.toId);
        if (!toNode || toNode.isExternal) continue;
        union(node.filePath, toNode.filePath);
      }
    }

    const groups = new Map<string, string[]>();
    for (const fp of files) {
      const root = find(fp);
      const g = groups.get(root) ?? [];
      g.push(fp);
      groups.set(root, g);
    }

    const communities: Community[] = [];
    let idx = 0;
    for (const [, members] of groups) {
      communities.push({
        id: `community-${idx++}`,
        label: this.communityLabelFromFiles(members),
        files: members,
        nodeCount: members.length,
        hubs: this.findHubs(members, ctx),
        role: this.inferRole(members),
        algorithm: 'connected-components',
      });
    }
    return communities.sort((a, b) => b.nodeCount - a.nodeCount);
  }

  private communityLabelFromFiles(files: string[]): string {
    if (files.length === 1) {
      const parts = files[0].split(/[/\\]/);
      return parts[parts.length - 1];
    }
    const parts = files.map((f) => f.split(/[/\\]/));
    const minLen = Math.min(...parts.map((p) => p.length));
    const common: string[] = [];
    for (let i = 0; i < minLen; i++) {
      if (parts.every((p) => p[i] === parts[0][i])) common.push(parts[0][i]);
      else break;
    }
    if (common.length >= 2) return common[common.length - 1];
    return `cluster-${files.length}-files`;
  }
}

// ─── Graphology loading & graph construction ──────────────────────────────────

interface DetectContext {
  allNodes: GraphNode[];
  allEdges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
  /** calls + imports edges pointing at each node. */
  fanIn: Map<string, number>;
  edgesByNode: Map<string, GraphEdge[]>;
  hubNodesByFile: Map<string, GraphNode[]>;
}

interface IGraph {
  addNode(key: string, attrs?: Record<string, unknown>): void;
  hasNode(key: string): boolean;
  hasEdge(source: string, target: string): boolean;
  addEdge(source: string, target: string, attrs?: Record<string, unknown>): void;
  getEdgeAttribute(source: string, target: string, name: string): unknown;
  setEdgeAttribute(source: string, target: string, name: string, value: unknown): void;
}

type GraphCtor = new (opts: { type: string }) => IGraph;
type LouvainFn = (g: IGraph, opts?: Record<string, unknown>) => Record<string, number>;

/** Tolerant CJS/ESM interop: under CommonJS these packages export the constructor/function directly. */
function pick<T>(mod: unknown, named?: string): T {
  const m = mod as Record<string, unknown> | null | undefined;
  const candidate = (m && (m.default ?? (named ? m[named] : undefined))) ?? m;
  return candidate as T;
}

function loadGraphology(): { Graph: GraphCtor; louvain: LouvainFn } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- untyped third-party/dynamic value; behaviour unchanged
  const Graph = pick<GraphCtor>(require('graphology'), 'Graph');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- untyped third-party/dynamic value; behaviour unchanged
  const louvain = pick<LouvainFn>(require('graphology-communities-louvain'));
  if (typeof Graph !== 'function') throw new Error('graphology did not export a Graph constructor');
  if (typeof louvain !== 'function')
    throw new Error('graphology-communities-louvain did not export a function');
  return { Graph, louvain };
}

/** Small seeded PRNG (mulberry32) so Louvain results are deterministic. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function louvainOptions(): Record<string, unknown> {
  return { resolution: 1, getEdgeWeight: 'weight', randomWalk: false, rng: seededRng(0xc0ffee) };
}

/**
 * Build an undirected weighted graph. Parallel edges between the same pair
 * (any direction, any kind) are merged by summing their weights.
 */
function buildGraph(Graph: GraphCtor, nodes: GraphNode[], edges: GraphEdge[]): IGraph {
  const graph = new Graph({ type: 'undirected' });
  for (const node of nodes) graph.addNode(node.id);
  for (const edge of edges) {
    if (edge.fromId === edge.toId) continue;
    if (!graph.hasNode(edge.fromId) || !graph.hasNode(edge.toId)) continue;
    const weight = EDGE_WEIGHTS[edge.kind] ?? 0.3;
    if (graph.hasEdge(edge.fromId, edge.toId)) {
      const prev = graph.getEdgeAttribute(edge.fromId, edge.toId, 'weight') as number;
      graph.setEdgeAttribute(edge.fromId, edge.toId, 'weight', prev + weight);
    } else {
      graph.addEdge(edge.fromId, edge.toId, { weight });
    }
  }
  return graph;
}
