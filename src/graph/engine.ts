/**
 * Graph traversal engine.
 * Provides deps, callers, callees, impact analysis, and shortest-path queries
 * built on top of the GraphDb.
 *
 * Traversals are level-batched: each BFS level collects its candidate ids,
 * then resolves them with a single `getNodesByIds` call instead of one
 * `getNode` per edge.
 */

import type { GraphDb } from './db.js';
import type {
  GraphNode,
  GraphEdge,
  DepsResult,
  CallersResult,
  CalleesResult,
  ImpactResult,
  PathResult,
} from '../types.js';

/** Safety cap on nodes collected by a single traversal. */
const DEFAULT_MAX_NODES = 5000;

export class GraphEngine {
  constructor(private readonly db: GraphDb) {}

  // ─── Public queries ────────────────────────────────────────────────────────

  /**
   * Return all dependencies (imports) of a node.
   * depth=1 → direct imports only; depth>1 → transitive.
   * Sets `truncated` when the transitive set hit `maxNodes`.
   */
  deps(nodeId: string, depth = 3, maxNodes = DEFAULT_MAX_NODES): DepsResult | null {
    const target = this.db.getNode(nodeId);
    if (!target) return null;

    const direct = this.directDeps(nodeId);
    if (depth <= 1) return { target, direct, transitive: [] };

    const { nodes, truncated } = this.transitiveDeps(nodeId, depth, maxNodes);
    const result: DepsResult = { target, direct, transitive: nodes };
    if (truncated) result.truncated = true;
    return result;
  }

  /**
   * Return all nodes that call a given function/method node.
   */
  callers(nodeId: string): CallersResult | null {
    const target = this.db.getNode(nodeId);
    if (!target) return null;

    const callEdges = this.db.getEdgesToByKind(nodeId, 'calls');
    const byId = this.nodeMap(callEdges.map((e) => e.fromId));
    const callers = callEdges
      .map((edge) => {
        const node = byId.get(edge.fromId);
        return node ? { node, reason: edge.reason } : null;
      })
      .filter((x): x is { node: GraphNode; reason: string } => x !== null);

    return { target, callers };
  }

  /**
   * Return all nodes called by a given function/method node.
   */
  callees(nodeId: string): CalleesResult | null {
    const target = this.db.getNode(nodeId);
    if (!target) return null;

    const callEdges = this.db.getEdgesFromByKind(nodeId, 'calls');
    const byId = this.nodeMap(callEdges.map((e) => e.toId));
    const callees = callEdges
      .map((edge) => {
        const node = byId.get(edge.toId);
        return node ? { node, reason: edge.reason } : null;
      })
      .filter((x): x is { node: GraphNode; reason: string } => x !== null);

    return { target, callees };
  }

  /**
   * Impact analysis: find all nodes that would be affected if nodeId changed.
   * Traverses the reverse import/dependency graph. Sets `truncated` when the
   * affected set hit `maxNodes`.
   */
  impact(nodeId: string, maxDepth = 10, maxNodes = DEFAULT_MAX_NODES): ImpactResult | null {
    const target = this.db.getNode(nodeId);
    if (!target) return null;

    const visited = new Map<string, { node: GraphNode; depth: number; path: GraphNode[] }>();
    let frontier: Array<{ id: string; path: GraphNode[] }> = [{ id: nodeId, path: [target] }];
    let depth = 0;
    let truncated = false;

    while (frontier.length && depth < maxDepth && !truncated) {
      // Collect candidate importers / re-exporters for the whole level.
      const candidates: Array<{ id: string; parentPath: GraphNode[] }> = [];
      const seen = new Set<string>();
      for (const { id, path } of frontier) {
        const incoming = [
          ...this.db.getEdgesToByKind(id, 'imports'),
          ...this.db.getEdgesToByKind(id, 'exports'),
        ];
        for (const edge of incoming) {
          if (edge.fromId === nodeId) continue; // skip self
          if (visited.has(edge.fromId) || seen.has(edge.fromId)) continue;
          seen.add(edge.fromId);
          candidates.push({ id: edge.fromId, parentPath: path });
        }
      }

      const byId = this.nodeMap(candidates.map((c) => c.id));
      const next: Array<{ id: string; path: GraphNode[] }> = [];
      for (const c of candidates) {
        const node = byId.get(c.id);
        if (!node) continue;
        if (visited.size >= maxNodes) {
          truncated = true;
          break;
        }
        const path = [...c.parentPath, node];
        visited.set(c.id, { node, depth: depth + 1, path });
        next.push({ id: c.id, path });
      }
      frontier = next;
      depth++;
    }

    const result: ImpactResult = {
      target,
      affected: Array.from(visited.values()).sort((a, b) => a.depth - b.depth),
    };
    if (truncated) result.truncated = true;
    return result;
  }

  /**
   * Find the shortest dependency path between two nodes using level-batched BFS.
   * Gives up (returns null) once `maxNodes` nodes have been visited.
   */
  path(fromId: string, toId: string, maxNodes = DEFAULT_MAX_NODES): PathResult | null {
    const from = this.db.getNode(fromId);
    const to = this.db.getNode(toId);
    if (!from || !to) return null;
    if (fromId === toId) return { from, to, path: [from], edges: [] };

    type Item = { id: string; path: GraphNode[]; edges: GraphEdge[] };
    const visited = new Set<string>([fromId]);
    let frontier: Item[] = [{ id: fromId, path: [from], edges: [] }];

    while (frontier.length) {
      const candidates: Array<{ edge: GraphEdge; parent: Item }> = [];
      const seen = new Set<string>();
      for (const item of frontier) {
        for (const edge of this.db.getEdgesFrom(item.id)) {
          if (visited.has(edge.toId) || seen.has(edge.toId)) continue;
          seen.add(edge.toId);
          candidates.push({ edge, parent: item });
        }
      }

      const byId = this.nodeMap(candidates.map((c) => c.edge.toId));
      const next: Item[] = [];
      for (const { edge, parent } of candidates) {
        const node = byId.get(edge.toId);
        if (!node) continue;
        visited.add(edge.toId);
        const path = [...parent.path, node];
        const edges = [...parent.edges, edge];
        if (edge.toId === toId) return { from, to, path, edges };
        next.push({ id: edge.toId, path, edges });
      }
      if (visited.size >= maxNodes) return null;
      frontier = next;
    }

    return null; // No path found
  }

  /**
   * Search for nodes by name, description, or file path.
   */
  search(query: string): GraphNode[] {
    return this.db.searchNodes(query);
  }

  /**
   * Find a node by its exact file path (returns the file node for that path).
   */
  findByFile(filePath: string): GraphNode[] {
    return this.db.getNodesByFile(filePath);
  }

  /**
   * Detect dependency cycles using DFS.
   * Returns arrays of node IDs representing each cycle found.
   */
  detectCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stack: string[] = [];

    const dfs = (id: string) => {
      visited.add(id);
      inStack.add(id);
      stack.push(id);

      const outEdges = this.db.getEdgesFromByKind(id, 'imports');
      for (const edge of outEdges) {
        if (!visited.has(edge.toId)) {
          dfs(edge.toId);
        } else if (inStack.has(edge.toId)) {
          // Found a cycle
          const cycleStart = stack.indexOf(edge.toId);
          if (cycleStart !== -1) {
            cycles.push([...stack.slice(cycleStart), edge.toId]);
          }
        }
      }

      stack.pop();
      inStack.delete(id);
    };

    for (const node of this.db.getAllNodes()) {
      if (!visited.has(node.id)) {
        dfs(node.id);
      }
    }

    return cycles;
  }

  /**
   * Find orphan nodes — nodes with no incoming or outgoing edges.
   */
  orphans(): GraphNode[] {
    const allNodes = this.db.getAllNodes();
    const allEdges = this.db.getAllEdges();

    const connected = new Set<string>();
    for (const edge of allEdges) {
      connected.add(edge.fromId);
      connected.add(edge.toId);
    }

    return allNodes.filter((n) => !connected.has(n.id) && !n.isExternal);
  }

  /**
   * Layer analysis: return a compact summary of the architectural layers.
   * Groups nodes by directory depth and kind to infer layering.
   */
  layers(): Array<{ layer: string; nodeCount: number; kinds: Record<string, number> }> {
    // One query, grouped in memory (instead of getNodesByFile per file).
    const everyNode = this.db.getAllNodes();
    const byFile = new Map<string, GraphNode[]>();
    for (const n of everyNode) {
      const list = byFile.get(n.filePath);
      if (list) list.push(n);
      else byFile.set(n.filePath, [n]);
    }

    const allNodes = everyNode.filter((n) => !n.isExternal && n.kind === 'file');
    const layerMap = new Map<string, GraphNode[]>();

    for (const node of allNodes) {
      // Use the top-level directory segment as the "layer"
      const parts = node.filePath.replace(/\\/g, '/').split('/');
      const srcIndex = parts.findIndex((p) => p === 'src');
      const layer =
        srcIndex !== -1 && parts[srcIndex + 1]
          ? parts[srcIndex + 1]
          : (parts[parts.length - 2] ?? 'root');

      if (!layerMap.has(layer)) layerMap.set(layer, []);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
      layerMap.get(layer)!.push(node);
    }

    return Array.from(layerMap.entries())
      .map(([layer, nodes]) => {
        const allKindNodes = nodes.flatMap((n) => byFile.get(n.filePath) ?? []);
        const kinds: Record<string, number> = {};
        for (const n of allKindNodes) {
          kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
        }
        return { layer, nodeCount: nodes.length, kinds };
      })
      .sort((a, b) => b.nodeCount - a.nodeCount);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Batch-fetch nodes by id into a map (missing ids are absent). */
  private nodeMap(ids: string[]): Map<string, GraphNode> {
    const map = new Map<string, GraphNode>();
    if (!ids.length) return map;
    for (const n of this.db.getNodesByIds(Array.from(new Set(ids)))) map.set(n.id, n);
    return map;
  }

  private directDeps(nodeId: string): GraphNode[] {
    const edges = this.db.getEdgesFromByKind(nodeId, 'imports');
    const byId = this.nodeMap(edges.map((e) => e.toId));
    return edges.map((e) => byId.get(e.toId)).filter((n): n is GraphNode => n !== undefined);
  }

  private transitiveDeps(
    nodeId: string,
    maxDepth: number,
    maxNodes: number,
  ): { nodes: GraphNode[]; truncated: boolean } {
    const visited = new Set<string>([nodeId]);
    const result: GraphNode[] = [];
    let frontier: string[] = [nodeId];
    let depth = 0;
    let truncated = false;

    while (frontier.length && depth < maxDepth && !truncated) {
      const candidates: string[] = [];
      for (const id of frontier) {
        for (const edge of this.db.getEdgesFromByKind(id, 'imports')) {
          if (visited.has(edge.toId)) continue;
          visited.add(edge.toId);
          candidates.push(edge.toId);
        }
      }
      const byId = this.nodeMap(candidates);
      const next: string[] = [];
      for (const id of candidates) {
        const node = byId.get(id);
        if (!node) continue;
        if (result.length >= maxNodes) {
          truncated = true;
          break;
        }
        result.push(node);
        next.push(id);
      }
      frontier = next;
      depth++;
    }

    return { nodes: result, truncated };
  }
}
