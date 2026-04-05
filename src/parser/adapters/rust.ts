/**
 * Rust language adapter.
 *
 * Extracts:
 *  - use declarations        → imports edges
 *  - struct / enum / trait   → class / interface nodes
 *  - fn declarations         → function / method nodes
 *  - impl blocks             → method nodes attached to parent type
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';
import type { NodeKind } from '../../types.js';

export class RustAdapter implements LanguageAdapter {
  readonly language = 'rust' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'rust');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `Rust source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'rust',
      meta: '{}',
    });

    this.extractUses(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractTypes(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractFunctions(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'rust', nodes, edges };
  }

  private extractUses(
    root: Parser.SyntaxNode,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByType(root, 'use_declaration')) {
      const text = node.text.replace(/^use\s+/, '').replace(/;$/, '').trim();
      const rootCrate = text.split('::')[0];
      if (!rootCrate || seen.has(rootCrate)) continue;
      seen.add(rootCrate);

      const extId = makeNodeId('external_dep', rootCrate);
      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: rootCrate,
          filePath: rootCrate,
          description: `Rust crate: ${rootCrate}`,
          isExternal: true,
          language: null,
          meta: '{}',
        });
      }

      edges.push({
        id: makeEdgeId(fileNodeId, 'imports', extId),
        fromId: fileNodeId,
        toId: extId,
        kind: 'imports',
        reason: `uses ${rootCrate}`,
      });
    }
  }

  private extractTypes(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
    source: string,
  ): void {
    const typeNodes: Array<[NodeKind, 'struct_item' | 'enum_item' | 'trait_item']> = [
      ['class', 'struct_item'],
      ['class', 'enum_item'],
      ['interface', 'trait_item'],
    ];

    for (const [kind, nodeType] of typeNodes) {
      for (const node of this.findByType(root, nodeType)) {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const typeName = nameNode.text;
        const nodeId = makeNodeId(kind, filePath, typeName);
        const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));
        const label = nodeType === 'trait_item' ? 'Trait' : nodeType === 'enum_item' ? 'Enum' : 'Struct';

        nodes.push({
          id: nodeId,
          kind,
          name: typeName,
          filePath,
          description: `${label} ${typeName}. ${snippet}`,
          isExternal: false,
          language: 'rust',
          meta: '{}',
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', nodeId),
          fromId: fileNodeId,
          toId: nodeId,
          kind: 'exports',
          reason: `defines ${label} ${typeName}`,
        });
      }
    }
  }

  private extractFunctions(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByType(root, 'function_item')) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const fnName = nameNode.text;
      if (seen.has(fnName)) continue;
      seen.add(fnName);

      // Determine if inside an impl block → method, otherwise function
      const parentImpl = this.findAncestorOfType(node, 'impl_item');
      const kind = parentImpl ? 'method' : 'function';
      const fnId = makeNodeId(kind, filePath, fnName);

      nodes.push({
        id: fnId,
        kind,
        name: fnName,
        filePath,
        description: `${kind === 'method' ? 'Method' : 'Function'} ${fnName} in ${path.basename(filePath)}`,
        isExternal: false,
        language: 'rust',
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', fnId),
        fromId: fileNodeId,
        toId: fnId,
        kind: 'exports',
        reason: `defines fn ${fnName}`,
      });
    }
  }

  private findAncestorOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    let cur: Parser.SyntaxNode | null = node.parent;
    while (cur) {
      if (cur.type === type) return cur;
      cur = cur.parent;
    }
    return null;
  }

  private findByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    const stack: Parser.SyntaxNode[] = [node];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur.type === type) results.push(cur);
      for (const child of cur.children) stack.push(child);
    }
    return results;
  }
}
