/**
 * Go language adapter.
 *
 * Extracts:
 *  - import declarations     → imports edges
 *  - struct / type definitions → class nodes
 *  - interface definitions    → interface nodes
 *  - function declarations    → function nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';

export class GoAdapter implements LanguageAdapter {
  readonly language = 'go' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'go');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `Go source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'go',
      meta: '{}',
    });

    this.extractImports(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractTypes(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractFunctions(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'go', nodes, edges };
  }

  private extractImports(
    root: Parser.SyntaxNode,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByType(root, 'import_spec')) {
      // path field contains the quoted import path
      const pathNode = node.childForFieldName('path') ?? node.firstNamedChild;
      if (!pathNode) continue;
      const rawPath = pathNode.text.replace(/^["']|["']$/g, '');
      if (!rawPath || seen.has(rawPath)) continue;
      seen.add(rawPath);

      // Go imports are always external packages or local module paths
      const pkgName = rawPath.split('/').pop() ?? rawPath;
      const extId = makeNodeId('external_dep', rawPath);

      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: pkgName,
          filePath: rawPath,
          description: `Go package: ${rawPath}`,
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
        reason: `imports ${rawPath}`,
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
    for (const node of this.findByType(root, 'type_declaration')) {
      for (const spec of this.findByType(node, 'type_spec')) {
        const nameNode = spec.childForFieldName('name');
        if (!nameNode) continue;
        const typeName = nameNode.text;
        const typeNode = spec.childForFieldName('type');
        const isInterface = typeNode?.type === 'interface_type';
        const kind = isInterface ? 'interface' : 'class';
        const nodeId = makeNodeId(kind, filePath, typeName);
        const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));

        nodes.push({
          id: nodeId,
          kind,
          name: typeName,
          filePath,
          description: `${isInterface ? 'Interface' : 'Struct'} ${typeName}. ${snippet}`,
          isExternal: false,
          language: 'go',
          meta: '{}',
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', nodeId),
          fromId: fileNodeId,
          toId: nodeId,
          kind: 'exports',
          reason: `defines ${kind} ${typeName}`,
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
    for (const node of this.findByTypes(root, ['function_declaration', 'method_declaration'])) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const fnName = nameNode.text;
      if (seen.has(fnName)) continue;
      seen.add(fnName);

      const kind = node.type === 'method_declaration' ? 'method' : 'function';
      const fnId = makeNodeId(kind, filePath, fnName);

      nodes.push({
        id: fnId,
        kind,
        name: fnName,
        filePath,
        description: `${kind === 'method' ? 'Method' : 'Function'} ${fnName} in ${path.basename(filePath)}`,
        isExternal: false,
        language: 'go',
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

  private findByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
    return this.findByTypes(node, [type]);
  }

  private findByTypes(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    const stack: Parser.SyntaxNode[] = [node];
    while (stack.length) {
      const cur = stack.pop()!;
      if (types.includes(cur.type)) results.push(cur);
      for (const child of cur.children) stack.push(child);
    }
    return results;
  }
}
