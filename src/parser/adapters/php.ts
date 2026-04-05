/**
 * PHP language adapter.
 *
 * Extracts:
 *  - use / require / include    → imports edges
 *  - class / interface / trait  → class / interface nodes
 *  - function / method defs     → function / method nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';
import type { NodeKind } from '../../types.js';

export class PhpAdapter implements LanguageAdapter {
  readonly language = 'php' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'php');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `PHP source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'php',
      meta: '{}',
    });

    this.extractUses(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractClasses(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractFunctions(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'php', nodes, edges };
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
      const nameNode = node.firstNamedChild;
      if (!nameNode) continue;
      const ns = nameNode.text.replace(/^\\/, '');
      const rootNs = ns.split('\\')[0];
      if (!rootNs || seen.has(rootNs)) continue;
      seen.add(rootNs);

      const extId = makeNodeId('external_dep', rootNs);
      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: rootNs,
          filePath: rootNs,
          description: `PHP namespace: ${rootNs}`,
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
        reason: `uses namespace ${rootNs}`,
      });
    }
  }

  private extractClasses(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
    source: string,
  ): void {
    const typeMap: Array<[string, NodeKind]> = [
      ['class_declaration', 'class'],
      ['interface_declaration', 'interface'],
      ['trait_declaration', 'class'],
    ];

    for (const [nodeType, kind] of typeMap) {
      for (const node of this.findByType(root, nodeType)) {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const className = nameNode.text;
        const nodeId = makeNodeId(kind, filePath, className);
        const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));
        const label = nodeType === 'interface_declaration' ? 'Interface' : nodeType === 'trait_declaration' ? 'Trait' : 'Class';

        nodes.push({
          id: nodeId,
          kind,
          name: className,
          filePath,
          description: `${label} ${className}. ${snippet}`,
          isExternal: false,
          language: 'php',
          meta: '{}',
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', nodeId),
          fromId: fileNodeId,
          toId: nodeId,
          kind: 'exports',
          reason: `defines ${label} ${className}`,
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
    for (const nodeType of ['function_definition', 'method_declaration']) {
      for (const node of this.findByType(root, nodeType)) {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const fnName = nameNode.text;
        if (seen.has(fnName)) continue;
        seen.add(fnName);

        const insideClass = this.findAncestorOfType(node, 'class_declaration') ||
          this.findAncestorOfType(node, 'trait_declaration');
        const kind = insideClass ? 'method' : 'function';
        const fnId = makeNodeId(kind, filePath, fnName);

        nodes.push({
          id: fnId,
          kind,
          name: fnName,
          filePath,
          description: `${kind === 'method' ? 'Method' : 'Function'} ${fnName} in ${path.basename(filePath)}`,
          isExternal: false,
          language: 'php',
          meta: '{}',
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', fnId),
          fromId: fileNodeId,
          toId: fnId,
          kind: 'exports',
          reason: `defines ${kind} ${fnName}`,
        });
      }
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
