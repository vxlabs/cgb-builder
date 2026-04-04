/**
 * Graph traversal engine.
 * Provides deps, callers, callees, impact analysis, and shortest-path queries
 * built on top of the GraphDb.
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

export class GraphEngine {
  constructor(private readonly db: GraphDb) {}

  // ─── Public queries ────────────────────────────────────────────────────────

  /**
   * Return all dependencies (imports) of a node.
   * depth=1 → direct imports only; depth>1 → transitive.
   */
  deps(nodeId: string, depth = 3): DepsResult | null {
    const target = this.db.getNode(nodeId);
    if (!target) return null;

    const direct = this.directDeps(nodeId);
    const transitive = depth > 1 ? this.transitiveDeps(nodeId, depth) : [];

    return { target, direct, transitive };
  }

  /**
   * Return all nodes that call a given function/method node.
   */
  callers(nodeId: string): CallersResult | null {
    const target = this.db.getNode(nodeId);
    if (!target) return null;

    const callEdges = this.db.getEdgesToByKind(nodeId, 'calls');
    const callers = callEdges
      .map((edge) => {
        const node = this.db.getNode(edge.fromId);
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
    const callees = callEdges
      .map((edge) => {
        const node = this.db.getNode(edge.toId);
        return node ? { node, reason: edge.reason } : null;
      })
      .filter((x): x is { node: GraphNode; reason: string } => x !== null);

    return { target, callees };
  }

  /**
   * Impact analysis: find all nodes that would be affected if nodeId changed.
   * Traverses the reverse import/dependency graph.
   */
  impact(nodeId: string, maxDepth = 10): ImpactResult | null {
    const target = this.db.getNode(nodeId);
    if (!target) return null;

    const visited = new Map<string, { node: GraphNode; depth: number; path: GraphNode[] }>();
    const queue: Array<{ id: string; depth: number; path: GraphNode[] }> = [
      { id: nodeId, depth: 0, path: [target] },
    ];

    while (queue.length) {
      const { id, depth, path } = queue.shift()!;
      if (depth >= maxDepth) continue;

      // Find all nodes that import this node
      const incomingImports = this.db.getEdgesToByKind(id, 'imports');
      // Also find nodes that export symbols from this file (they re-export)
      const incomingExports = this.db.getEdgesToByKind(id, 'exports');

      for (const edge of [...incomingImports, ...incomingExports]) {
        if (edge.fromId === nodeId) continue; // skip self
        if (visited.has(edge.fromId)) continue;

        const node = this.db.getNode(edge.fromId);
        if (!node) continue;

        visited.set(edge.fromId, { node, depth: depth + 1, path: [...path, node] });
        queue.push({ id: edge.fromId, depth: depth + 1, path: [...path, node] });
      }
    }

    return {
      target,
      affected: Array.from(visited.values()).sort((a, b) => a.depth - b.depth),
    };
  }

  /**
   * Find the shortest dependency path between two nodes using BFS.
   */
  path(fromId: string, toId: string): PathResult | null {
    const from = this.db.getNode(fromId);
    const to = this.db.getNode(toId);
    if (!from || !to) return null;

    // BFS
    const visited = new Set<string>([fromId]);
    const queue: Array<{ id: string; path: GraphNode[]; edges: GraphEdge[] }> = [
      { id: fromId, path: [from], edges: [] },
    ];

    while (queue.length) {
      const { id, path, edges } = queue.shift()!;
      if (id === toId) {
        return { from, to, path, edges };
      }

      const outEdges = this.db.getEdgesFrom(id);
      for (const edge of outEdges) {
        if (visited.has(edge.toId)) continue;
        const next = this.db.getNode(edge.toId);
        if (!next) continue;
        visited.add(edge.toId);
        queue.push({ id: edge.toId, path: [...path, next], edges: [...edges, edge] });
      }
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
    const allNodes = this.db.getAllNodes().filter((n) => !n.isExternal && n.kind === 'file');
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
      layerMap.get(layer)!.push(node);
    }

    return Array.from(layerMap.entries())
      .map(([layer, nodes]) => {
        const allKindNodes = nodes.flatMap((n) => this.db.getNodesByFile(n.filePath));
        const kinds: Record<string, number> = {};
        for (const n of allKindNodes) {
          kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
        }
        return { layer, nodeCount: nodes.length, kinds };
      })
      .sort((a, b) => b.nodeCount - a.nodeCount);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private directDeps(nodeId: string): GraphNode[] {
    const edges = this.db.getEdgesFromByKind(nodeId, 'imports');
    return edges.map((e) => this.db.getNode(e.toId)).filter((n): n is GraphNode => n !== null);
  }

  private transitiveDeps(nodeId: string, maxDepth: number): GraphNode[] {
    const visited = new Set<string>([nodeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
    const result: GraphNode[] = [];

    while (queue.length) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const edges = this.db.getEdgesFromByKind(id, 'imports');
      for (const edge of edges) {
        if (visited.has(edge.toId)) continue;
        visited.add(edge.toId);

        const node = this.db.getNode(edge.toId);
        if (node) {
          result.push(node);
          queue.push({ id: edge.toId, depth: depth + 1 });
        }
      }
    }

    return result;
  }
}
