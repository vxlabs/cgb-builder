/**
 * Kotlin language adapter.
 *
 * Extracts:
 *  - import declarations        → imports edges
 *  - class / object / interface → class / interface nodes
 *  - fun declarations           → function / method nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';
import type { NodeKind } from '../../types.js';

export class KotlinAdapter implements LanguageAdapter {
  readonly language = 'kotlin' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'kotlin');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `Kotlin source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'kotlin',
      meta: '{}',
    });

    this.extractImports(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractClasses(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractFunctions(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'kotlin', nodes, edges };
  }

  private extractImports(
    root: Parser.SyntaxNode,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByType(root, 'import_header')) {
      // import_header: "import" + identifier
      const identifiers = this.findByType(node, 'identifier');
      if (!identifiers.length) continue;
      const fullPath = node.text.replace(/^import\s+/, '').trim();
      const rootPkg = fullPath.split('.')[0];
      if (!rootPkg || seen.has(rootPkg)) continue;
      seen.add(rootPkg);

      const extId = makeNodeId('external_dep', rootPkg);
      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: rootPkg,
          filePath: rootPkg,
          description: `Kotlin package: ${rootPkg}`,
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
        reason: `imports ${rootPkg}`,
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
    const typeMap: Array<[string, NodeKind, string]> = [
      ['class_declaration', 'class', 'Class'],
      ['object_declaration', 'class', 'Object'],
      ['interface_declaration', 'interface', 'Interface'],
    ];

    for (const [nodeType, kind, label] of typeMap) {
      for (const node of this.findByType(root, nodeType)) {
        const nameNode = node.childForFieldName('name') ??
          this.findByType(node, 'simple_identifier')[0];
        if (!nameNode) continue;
        const className = nameNode.text;
        const nodeId = makeNodeId(kind, filePath, className);
        const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));

        nodes.push({
          id: nodeId,
          kind,
          name: className,
          filePath,
          description: `${label} ${className}. ${snippet}`,
          isExternal: false,
          language: 'kotlin',
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
    for (const node of this.findByType(root, 'function_declaration')) {
      const nameNode = node.childForFieldName('name') ??
        this.findByType(node, 'simple_identifier')[0];
      if (!nameNode) continue;
      const fnName = nameNode.text;
      if (seen.has(fnName)) continue;
      seen.add(fnName);

      const insideClass = this.findAncestorOfTypes(node, [
        'class_declaration',
        'object_declaration',
        'interface_declaration',
      ]);
      const kind = insideClass ? 'method' : 'function';
      const fnId = makeNodeId(kind, filePath, fnName);

      nodes.push({
        id: fnId,
        kind,
        name: fnName,
        filePath,
        description: `${kind === 'method' ? 'Method' : 'Function'} ${fnName} in ${path.basename(filePath)}`,
        isExternal: false,
        language: 'kotlin',
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', fnId),
        fromId: fileNodeId,
        toId: fnId,
        kind: 'exports',
        reason: `defines fun ${fnName}`,
      });
    }
  }

  private findAncestorOfTypes(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode | null {
    let cur: Parser.SyntaxNode | null = node.parent;
    while (cur) {
      if (types.includes(cur.type)) return cur;
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
