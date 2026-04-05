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
import type { CommunityRecord } from '../types.js';

export type { CommunityRecord };

// ─── Legacy Community type (kept for backward compat with wiki/server) ────────

export interface Community {
  id: string;
  label: string;
  files: string[];
  nodeCount: number;
  hubs: Array<{ name: string; filePath: string; fanIn: number }>;
  role: 'ui' | 'service' | 'data' | 'util' | 'config' | 'test' | 'unknown';
  cohesion?: number;
  dominantLanguage?: string | null;
}

export interface ArchitectureOverview {
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
    const communities = this.detectSync();
    const now = Date.now();

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
      const fileSet = new Set(comm.files);
      const nodes = this.db.getAllNodes().filter((n) => fileSet.has(n.filePath));
      for (const node of nodes) {
        this.db.updateNodeCommunity(node.id, id);
      }
    }

    return inserted;
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
    const orphans = this.engine.orphans().slice(0, 10).map((n) => n.filePath);

    // Cross-community coupling
    const coupling = this.computeCoupling(communities);

    const healthNotes: string[] = [];
    if (cycles.length > 0) healthNotes.push(`${cycles.length} circular dependency cycle(s) detected`);
    if (orphans.length > 0) healthNotes.push(`${orphans.length} orphan file(s) with no connections`);

    const largestCommunity = communities[0];
    if (largestCommunity && largestCommunity.nodeCount > stats.files * 0.5) {
      healthNotes.push('Over 50% of files belong to a single community — consider splitting into modules');
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

  private detectSync(): Community[] {
    try {
      return this.runLouvainSync(0, null);
    } catch {
      // Fallback to file-based connected components if graphology unavailable
      return this.fallbackDetect();
    }
  }

  private runLouvainSync(level: number, parentLabel: string | null): Community[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: Graph } = require('graphology') as { default: new (opts: { type: string }) => IGraph };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: louvain } = require('graphology-communities-louvain') as {
      default: (g: IGraph, opts?: { resolution?: number }) => Record<string, number>;
    };

    const allNodes = this.db.getAllNodes().filter((n) => !n.isExternal);
    if (allNodes.length === 0) return [];

    const graph: IGraph = new Graph({ type: 'undirected' });
    for (const node of allNodes) {
      graph.addNode(node.id, { label: node.name, filePath: node.filePath, language: node.language });
    }

    const allEdges = this.db.getAllEdges();
    const nodeIds = new Set(allNodes.map((n) => n.id));
    for (const edge of allEdges) {
      if (!nodeIds.has(edge.fromId) || !nodeIds.has(edge.toId)) continue;
      if (edge.fromId === edge.toId) continue;
      const weight = EDGE_WEIGHTS[edge.kind] ?? 0.3;
      const edgeKey = `${edge.fromId}--${edge.toId}`;
      if (!graph.hasEdge(edgeKey)) {
        try {
          graph.addEdgeWithKey(edgeKey, edge.fromId, edge.toId, { weight });
        } catch {
          // duplicate — ignore
        }
      }
    }

    const partition = louvain(graph, { resolution: 1.0 });

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

      const memberNodes = memberIds.map((id) => this.db.getNode(id)).filter(Boolean) as ReturnType<
        GraphDb['getNode']
      >[];
      const validNodes = memberNodes.filter((n): n is NonNullable<typeof n> => n !== null);

      // Two-stage: split large communities with sub-graph Louvain
      if (level === 0 && validNodes.length > SPLIT_THRESHOLD) {
        const subCommunities = this.splitLargeCommunity(validNodes, communityIndex);
        communities.push(...subCommunities);
        communityIndex += subCommunities.length;
        continue;
      }

      const files = [...new Set(validNodes.map((n) => n.filePath))];
      const label = parentLabel
        ? `${parentLabel}/${this.deriveName(validNodes)}`
        : this.deriveName(validNodes);
      const role = this.inferRole(files);
      const hubs = this.findHubs(validNodes.map((n) => n.filePath));
      const cohesion = this.computeCohesion(memberIds);
      const dominantLanguage = this.dominantLanguage(validNodes);

      communities.push({
        id: `community-${communityIndex++}`,
        label,
        files,
        nodeCount: validNodes.length,
        hubs,
        role,
        cohesion,
        dominantLanguage,
      });
    }

    return communities.sort((a, b) => b.nodeCount - a.nodeCount);
  }

  private splitLargeCommunity(
    nodes: NonNullable<ReturnType<GraphDb['getNode']>>[],
    startIdx: number,
  ): Community[] {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: Graph } = require('graphology') as { default: new (opts: { type: string }) => IGraph };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: louvain } = require('graphology-communities-louvain') as {
        default: (g: IGraph, opts?: { resolution?: number }) => Record<string, number>;
      };

      const nodeSet = new Set(nodes.map((n) => n.id));
      const subGraph: IGraph = new Graph({ type: 'undirected' });
      for (const node of nodes) {
        subGraph.addNode(node.id);
      }

      const allEdges = this.db.getAllEdges();
      for (const edge of allEdges) {
        if (!nodeSet.has(edge.fromId) || !nodeSet.has(edge.toId)) continue;
        if (edge.fromId === edge.toId) continue;
        const weight = EDGE_WEIGHTS[edge.kind] ?? 0.3;
        const edgeKey = `${edge.fromId}--${edge.toId}`;
        if (!subGraph.hasEdge(edgeKey)) {
          try {
            subGraph.addEdgeWithKey(edgeKey, edge.fromId, edge.toId, { weight });
          } catch {
            // ignore
          }
        }
      }

      const partition = louvain(subGraph, { resolution: 1.0 });
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
        const memberNodes = memberIds.map((id) => this.db.getNode(id)).filter(Boolean) as NonNullable<
          ReturnType<GraphDb['getNode']>
        >[];
        const files = [...new Set(memberNodes.map((n) => n.filePath))];
        const label = `${parentLabel}/${this.deriveName(memberNodes)}`;
        result.push({
          id: `community-${i++}`,
          label,
          files,
          nodeCount: memberNodes.length,
          hubs: this.findHubs(files),
          role: this.inferRole(files),
          cohesion: this.computeCohesion(memberIds),
          dominantLanguage: this.dominantLanguage(memberNodes),
        });
      }
      return result.sort((a, b) => b.nodeCount - a.nodeCount);
    } catch {
      // Fallback: return the large community as-is
      const files = [...new Set(nodes.map((n) => n.filePath))];
      return [
        {
          id: `community-${startIdx}`,
          label: this.deriveName(nodes),
          files,
          nodeCount: nodes.length,
          hubs: this.findHubs(files),
          role: this.inferRole(files),
          cohesion: this.computeCohesion(nodes.map((n) => n.id)),
          dominantLanguage: this.dominantLanguage(nodes),
        },
      ];
    }
  }

  // ─── Private: naming & metrics ────────────────────────────────────────────

  private deriveName(nodes: NonNullable<ReturnType<GraphDb['getNode']>>[]): string {
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

  private computeCohesion(nodeIds: string[]): number {
    if (nodeIds.length < 2) return 1;
    const idSet = new Set(nodeIds);
    let internal = 0;
    let external = 0;
    for (const nodeId of nodeIds) {
      const edges = [...this.db.getEdgesFrom(nodeId), ...this.db.getEdgesTo(nodeId)];
      for (const edge of edges) {
        const other = edge.fromId === nodeId ? edge.toId : edge.fromId;
        if (idSet.has(other)) internal++;
        else external++;
      }
    }
    internal = Math.floor(internal / 2); // undirected: counted twice
    return internal + external === 0 ? 1 : internal / (internal + external);
  }

  private dominantLanguage(
    nodes: NonNullable<ReturnType<GraphDb['getNode']>>[],
  ): string | null {
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

  private findHubs(files: string[]): Community['hubs'] {
    const fileSet = new Set(files);
    const nodes = this.db.getNodesByKind(['file', 'class', 'function', 'method']);
    const hubs: Community['hubs'] = [];
    for (const node of nodes) {
      if (!fileSet.has(node.filePath) || node.isExternal) continue;
      const fanIn =
        this.db.getEdgesToByKind(node.id, 'calls').length +
        this.db.getEdgesToByKind(node.id, 'imports').length;
      if (fanIn > 0) hubs.push({ name: node.name, filePath: node.filePath, fanIn });
    }
    return hubs.sort((a, b) => b.fanIn - a.fanIn).slice(0, 5);
  }

  private computeCoupling(communities: Community[]): Array<{ from: string; to: string; edges: number }> {
    const nodeToComm = new Map<string, string>();
    for (const comm of communities) {
      const nodes = this.db.getAllNodes().filter((n) => comm.files.includes(n.filePath));
      for (const n of nodes) nodeToComm.set(n.id, comm.label);
    }

    const counts = new Map<string, number>();
    for (const edge of this.db.getAllEdges()) {
      const fromComm = nodeToComm.get(edge.fromId);
      const toComm = nodeToComm.get(edge.toId);
      if (!fromComm || !toComm || fromComm === toComm) continue;
      const key = [fromComm, toComm].sort().join('|||');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([key, edges]) => {
        const [from, to] = key.split('|||');
        return { from, to, edges };
      })
      .sort((a, b) => b.edges - a.edges);
  }

  // ─── Fallback: Union-Find (when graphology unavailable) ───────────────────

  private fallbackDetect(): Community[] {
    const files = this.db.getAllFiles().map((f) => f.filePath);
    if (files.length === 0) return [];

    const parent = new Map<string, string>();
    for (const fp of files) parent.set(fp, fp);

    const find = (x: string): string => {
      const p = parent.get(x) ?? x;
      if (p !== x) parent.set(x, find(p));
      return parent.get(x) ?? x;
    };
    const union = (a: string, b: string): void => { parent.set(find(a), find(b)); };

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
        hubs: this.findHubs(members),
        role: this.inferRole(members),
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

// ─── Minimal graphology interface (avoid full type dep at runtime) ─────────────

interface IGraph {
  addNode(key: string, attrs?: Record<string, unknown>): void;
  addEdgeWithKey(key: string, from: string, to: string, attrs?: Record<string, unknown>): void;
  hasEdge(key: string): boolean;
}
