/**
 * Ruby language adapter.
 *
 * Extracts:
 *  - require / require_relative → imports edges
 *  - class / module definitions  → class nodes
 *  - method definitions (def)   → method / function nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';

export class RubyAdapter implements LanguageAdapter {
  readonly language = 'ruby' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'ruby');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `Ruby source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'ruby',
      meta: '{}',
    });

    this.extractRequires(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractClasses(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractMethods(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'ruby', nodes, edges };
  }

  private extractRequires(
    root: Parser.SyntaxNode,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByType(root, 'call')) {
      const method = node.childForFieldName('method');
      if (!method || !['require', 'require_relative'].includes(method.text)) continue;
      const argsNode = node.childForFieldName('arguments');
      if (!argsNode) continue;
      const firstArg = argsNode.firstNamedChild;
      if (!firstArg) continue;
      const rawPath = firstArg.text.replace(/^['"]|['"]$/g, '');
      if (!rawPath || seen.has(rawPath)) continue;
      seen.add(rawPath);

      const extId = makeNodeId('external_dep', rawPath);
      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: rawPath.split('/').pop() ?? rawPath,
          filePath: rawPath,
          description: `Ruby dependency: ${rawPath}`,
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
        reason: `requires ${rawPath}`,
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
    for (const nodeType of ['class', 'module'] as const) {
      for (const node of this.findByType(root, nodeType)) {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const className = nameNode.text;
        const kind = nodeType === 'module' ? 'module' : 'class';
        const nodeId = makeNodeId(kind, filePath, className);
        const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));

        nodes.push({
          id: nodeId,
          kind,
          name: className,
          filePath,
          description: `${nodeType === 'module' ? 'Module' : 'Class'} ${className}. ${snippet}`,
          isExternal: false,
          language: 'ruby',
          meta: '{}',
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', nodeId),
          fromId: fileNodeId,
          toId: nodeId,
          kind: 'exports',
          reason: `defines ${kind} ${className}`,
        });
      }
    }
  }

  private extractMethods(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const nodeType of ['method', 'singleton_method'] as const) {
      for (const node of this.findByType(root, nodeType)) {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const methodName = nameNode.text;
        if (seen.has(methodName)) continue;
        seen.add(methodName);

        const insideClass =
          this.findAncestorOfType(node, 'class') || this.findAncestorOfType(node, 'module');
        const kind = insideClass ? 'method' : 'function';
        const fnId = makeNodeId(kind, filePath, methodName);

        nodes.push({
          id: fnId,
          kind,
          name: methodName,
          filePath,
          description: `${kind === 'method' ? 'Method' : 'Function'} ${methodName} in ${path.basename(filePath)}`,
          isExternal: false,
          language: 'ruby',
          meta: '{}',
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', fnId),
          fromId: fileNodeId,
          toId: fnId,
          kind: 'exports',
          reason: `defines ${kind} ${methodName}`,
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
