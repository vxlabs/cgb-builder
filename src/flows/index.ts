/**
 * Flows module: entry-point detection, call-chain tracing, criticality scoring.
 *
 * Entry points are functions/methods with no inbound `calls` edges from within
 * the project (i.e. only called from external tests or user input boundaries).
 *
 * Call chains are traced by following `calls` and `exports` edges depth-first.
 *
 * Criticality is a composite score derived from:
 *   - fan-out (calls out to many others → higher criticality)
 *   - fan-in  (called by many others → higher criticality)
 *   - transitiveSize (how many nodes depend on this one)
 */

import type { GraphDb } from '../graph/db.js';
import type { GraphNode } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EntryPoint {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  fanOut: number;
  fanIn: number;
  signature?: string;
  startLine?: number;
  endLine?: number;
  exported?: boolean;
}

export interface CallChainStep {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  depth: number;
  signature?: string;
  startLine?: number;
}

export interface CriticalityScore {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  fanIn: number;
  fanOut: number;
  score: number;
  label: 'critical' | 'high' | 'medium' | 'low';
}

// ─── FlowsAnalyzer ────────────────────────────────────────────────────────────

export class FlowsAnalyzer {
  constructor(private readonly db: GraphDb) {}

  /**
   * Find all entry points: functions/methods/files that have no inbound
   * `calls` edges (i.e. they are the "top" of a call chain).
   * Exported functions/methods with zero callers rank first (they are the
   * public entry surface); the remaining no-caller nodes follow. Within each
   * group results are sorted by fan-out descending, capped at `limit`.
   */
  entryPoints(limit = 30): EntryPoint[] {
    const allFunctions = this.db.getNodesByKind(['function', 'method', 'file']);
    const results: EntryPoint[] = [];

    for (const node of allFunctions) {
      if (node.isExternal) continue;
      const inbound = this.db.getEdgesToByKind(node.id, 'calls');
      if (inbound.length > 0) continue; // has callers → not an entry point

      const outbound = this.db.getEdgesFromByKind(node.id, 'calls');
      results.push({
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        kind: node.kind,
        fanOut: outbound.length,
        fanIn: 0,
        ...rangeFields(node),
        ...(node.exported !== undefined ? { exported: node.exported } : {}),
      });
    }

    const rank = (e: EntryPoint): number => (e.exported === true && e.kind !== 'file' ? 0 : 1);
    return results.sort((a, b) => rank(a) - rank(b) || b.fanOut - a.fanOut).slice(0, limit);
  }

  /**
   * Trace the call chain starting from the given nodeId.
   * Returns up to `maxDepth` levels of calls.
   */
  callChain(nodeId: string, maxDepth = 5): CallChainStep[] {
    const visited = new Set<string>();
    const result: CallChainStep[] = [];
    this.traceChain(nodeId, 0, maxDepth, visited, result);
    return result;
  }

  /**
   * Score all non-external function/method nodes by criticality.
   * Returns top `limit` nodes sorted by score descending.
   */
  criticalityScores(limit = 20): CriticalityScore[] {
    const nodes = this.db.getNodesByKind(['function', 'method', 'class', 'interface']);
    const scores: CriticalityScore[] = [];

    for (const node of nodes) {
      if (node.isExternal) continue;
      const fanIn =
        this.db.getEdgesToByKind(node.id, 'calls').length +
        this.db.getEdgesToByKind(node.id, 'imports').length;
      const fanOut =
        this.db.getEdgesFromByKind(node.id, 'calls').length +
        this.db.getEdgesFromByKind(node.id, 'imports').length;

      // Score: fan-in has higher weight (being called by many = critical)
      const score = fanIn * 3 + fanOut;

      let label: CriticalityScore['label'] = 'low';
      if (score >= 30) label = 'critical';
      else if (score >= 15) label = 'high';
      else if (score >= 5) label = 'medium';

      scores.push({
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        kind: node.kind,
        fanIn,
        fanOut,
        score,
        label,
      });
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private traceChain(
    nodeId: string,
    depth: number,
    maxDepth: number,
    visited: Set<string>,
    result: CallChainStep[],
  ): void {
    if (depth > maxDepth || visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = this.db.getNode(nodeId);
    if (!node) return;

    result.push({
      id: node.id,
      name: node.name,
      filePath: node.filePath,
      kind: node.kind,
      depth,
      ...(node.signature !== undefined ? { signature: node.signature } : {}),
      ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
    });

    const callEdges = this.db.getEdgesFromByKind(nodeId, 'calls');
    for (const edge of callEdges) {
      this.traceChain(edge.toId, depth + 1, maxDepth, visited, result);
    }
  }
}

// ─── Large functions helper ───────────────────────────────────────────────────

export interface LargeFunction {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  fanIn: number;
  fanOut: number;
  /** Estimated complexity: high fan-in + high fan-out */
  complexityScore: number;
  /** Lines of code (endLine - startLine + 1); undefined when the node has no range */
  loc?: number;
  signature?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Find the largest functions/methods in the graph. Nodes with line ranges are
 * ranked by LOC (ties broken by connectivity); nodes without ranges follow,
 * ranked by connectivity (fan-in + 2 * fan-out).
 */
export function findLargeFunctions(db: GraphDb, limit = 20): LargeFunction[] {
  const nodes = db.getNodesByKind(['function', 'method']);
  const results: LargeFunction[] = [];

  for (const node of nodes) {
    if (node.isExternal) continue;
    const fanIn = db.getEdgesToByKind(node.id, 'calls').length;
    const fanOut = db.getEdgesFromByKind(node.id, 'calls').length;
    const complexityScore = fanIn + fanOut * 2;
    const hasRange = node.startLine !== undefined && node.endLine !== undefined;
    results.push({
      id: node.id,
      name: node.name,
      filePath: node.filePath,
      kind: node.kind,
      fanIn,
      fanOut,
      complexityScore,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
      ...(hasRange ? { loc: node.endLine! - node.startLine! + 1 } : {}),
      ...rangeFields(node),
    });
  }

  return results
    .sort((a, b) => {
      if (a.loc !== undefined && b.loc !== undefined) {
        return b.loc - a.loc || b.complexityScore - a.complexityScore;
      }
      if (a.loc !== undefined) return -1;
      if (b.loc !== undefined) return 1;
      return b.complexityScore - a.complexityScore;
    })
    .slice(0, limit);
}

/** Optional signature/range fields, omitted when the node does not carry them. */
function rangeFields(node: GraphNode): {
  signature?: string;
  startLine?: number;
  endLine?: number;
} {
  return {
    ...(node.signature !== undefined ? { signature: node.signature } : {}),
    ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
    ...(node.endLine !== undefined ? { endLine: node.endLine } : {}),
  };
}
