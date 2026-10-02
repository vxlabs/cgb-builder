/**
 * Test helpers for language adapters. Not a test file (jest only matches *.test.ts).
 */
import * as path from 'path';
import type { LanguageAdapter } from '../adapter.js';
import type { GraphEdge, GraphNode, EdgeKind } from '../../types.js';

export const FIXTURE_ROOT: string = path.resolve('/cgb-fixture');

export type ViewNode = Omit<GraphNode, 'updatedAt'>;
export type ViewEdge = Omit<GraphEdge, 'updatedAt'>;

export interface ParsedView {
  filePath: string;
  nodes: ViewNode[];
  edges: ViewEdge[];
  kinds: Record<string, number>;
  ids: Set<string>;
  /** Find a node by kind and (optionally) name or id-symbol suffix (`#symbol`). */
  node(kind: string, symbol?: string): ViewNode | undefined;
  edgesOf(kind: EdgeKind): Array<{ from: string; to: string }>;
}

export async function parseSnippet(
  adapter: LanguageAdapter,
  relPath: string,
  source: string,
): Promise<ParsedView> {
  const filePath = path.join(FIXTURE_ROOT, relPath);
  const parsed = await adapter.parse(filePath, source);
  const kinds: Record<string, number> = {};
  for (const n of parsed.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  return {
    filePath,
    nodes: parsed.nodes,
    edges: parsed.edges,
    kinds,
    ids: new Set(parsed.nodes.map((n) => n.id)),
    node: (kind, symbol) =>
      parsed.nodes.find(
        (n) =>
          n.kind === kind &&
          (symbol === undefined || n.name === symbol || n.id.endsWith(`#${symbol}`)),
      ),
    edgesOf: (kind) =>
      parsed.edges.filter((e) => e.kind === kind).map((e) => ({ from: e.fromId, to: e.toId })),
  };
}
