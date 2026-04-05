/**
 * C / C++ language adapter (handles both .c/.h and .cpp/.hpp files).
 *
 * Extracts:
 *  - #include directives           → imports edges
 *  - struct / union / enum / class → class nodes
 *  - function definitions          → function / method nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile, SupportedLanguage } from '../../types.js';
import type { NodeKind } from '../../types.js';

export class CAdapter implements LanguageAdapter {
  readonly language: SupportedLanguage;

  constructor(lang: 'c' | 'cpp' = 'c') {
    this.language = lang;
  }

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const lang = this.language as 'c' | 'cpp';
    const tree = await treeSitterEngine.parse(source, lang);

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `${lang.toUpperCase()} source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: lang,
      meta: '{}',
    });

    this.extractIncludes(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractTypes(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractFunctions(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: lang, nodes, edges };
  }

  private extractIncludes(
    root: Parser.SyntaxNode,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByType(root, 'preproc_include')) {
      const pathNode =
        node.childForFieldName('path') ?? node.namedChildren[0];
      if (!pathNode) continue;
      const rawPath = pathNode.text.replace(/^[<"']|[>"']$/g, '');
      if (!rawPath || seen.has(rawPath)) continue;
      seen.add(rawPath);

      const extId = makeNodeId('external_dep', rawPath);
      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: rawPath.split('/').pop() ?? rawPath,
          filePath: rawPath,
          description: `Header: ${rawPath}`,
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
        reason: `includes ${rawPath}`,
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
    const typeMap: Array<[string, NodeKind]> = [
      ['struct_specifier', 'class'],
      ['union_specifier', 'class'],
      ['enum_specifier', 'class'],
      ['class_specifier', 'class'], // C++ only
    ];

    for (const [nodeType, kind] of typeMap) {
      for (const node of this.findByType(root, nodeType)) {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const typeName = nameNode.text;
        const nodeId = makeNodeId(kind, filePath, typeName);
        const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));
        const label = nodeType === 'class_specifier' ? 'Class' : nodeType.replace('_specifier', '');

        nodes.push({
          id: nodeId,
          kind,
          name: typeName,
          filePath,
          description: `${label} ${typeName}. ${snippet}`,
          isExternal: false,
          language: this.language,
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
    for (const node of this.findByType(root, 'function_definition')) {
      const declarator = node.childForFieldName('declarator');
      if (!declarator) continue;
      // Walk to find the function name node
      const nameNode = this.findByTypes(declarator, ['identifier', 'field_identifier'])[0];
      if (!nameNode) continue;
      const fnName = nameNode.text;
      if (seen.has(fnName)) continue;
      seen.add(fnName);

      const insideClass = this.findAncestorOfType(node, 'class_specifier');
      const kind = insideClass ? 'method' : 'function';
      const fnId = makeNodeId(kind, filePath, fnName);

      nodes.push({
        id: fnId,
        kind,
        name: fnName,
        filePath,
        description: `${kind === 'method' ? 'Method' : 'Function'} ${fnName} in ${path.basename(filePath)}`,
        isExternal: false,
        language: this.language,
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', fnId),
        fromId: fileNodeId,
        toId: fnId,
        kind: 'exports',
        reason: `defines function ${fnName}`,
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
