/**
 * Java language adapter.
 *
 * Extracts:
 *  - import declarations        → imports edges
 *  - class / enum definitions   → class nodes + inherits / implements edges
 *  - interface definitions      → interface nodes
 *  - method declarations        → method nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';

export class JavaAdapter implements LanguageAdapter {
  readonly language = 'java' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'java');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `Java source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'java',
      meta: '{}',
    });

    this.extractImports(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractClasses(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractInterfaces(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractMethods(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'java', nodes, edges };
  }

  private extractImports(
    root: Parser.SyntaxNode,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByType(root, 'import_declaration')) {
      const text = node.text
        .replace(/^import\s+(static\s+)?/, '')
        .replace(/;$/, '')
        .trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);

      const topPkg = text.split('.')[0];
      const extId = makeNodeId('external_dep', topPkg);

      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: topPkg,
          filePath: topPkg,
          description: `Java package: ${text}`,
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
        reason: `imports ${text}`,
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
    for (const node of this.findByTypes(root, ['class_declaration', 'enum_declaration'])) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const className = nameNode.text;
      const classId = makeNodeId('class', filePath, className);
      const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));

      nodes.push({
        id: classId,
        kind: 'class',
        name: className,
        filePath,
        description: `Class ${className}. ${snippet}`,
        isExternal: false,
        language: 'java',
        meta: JSON.stringify({ isEnum: node.type === 'enum_declaration' }),
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', classId),
        fromId: fileNodeId,
        toId: classId,
        kind: 'exports',
        reason: `defines class ${className}`,
      });

      // extends
      const superclass = node.childForFieldName('superclass');
      if (superclass) {
        const parentName = superclass.text.replace(/^extends\s+/, '').trim();
        const parentId = makeNodeId('class', filePath, parentName);
        edges.push({
          id: makeEdgeId(classId, 'inherits', parentId),
          fromId: classId,
          toId: parentId,
          kind: 'inherits',
          reason: `extends ${parentName}`,
        });
      }

      // implements
      const interfaces = node.childForFieldName('interfaces');
      if (interfaces) {
        const text = interfaces.text.replace(/^implements\s+/, '');
        for (const ifaceName of text.split(',').map((s) => s.trim())) {
          if (!ifaceName) continue;
          const ifaceId = makeNodeId('interface', filePath, ifaceName);
          edges.push({
            id: makeEdgeId(classId, 'implements', ifaceId),
            fromId: classId,
            toId: ifaceId,
            kind: 'implements',
            reason: `implements ${ifaceName}`,
          });
        }
      }
    }
  }

  private extractInterfaces(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    for (const node of this.findByType(root, 'interface_declaration')) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const ifaceName = nameNode.text;
      const ifaceId = makeNodeId('interface', filePath, ifaceName);

      nodes.push({
        id: ifaceId,
        kind: 'interface',
        name: ifaceName,
        filePath,
        description: `Interface ${ifaceName}`,
        isExternal: false,
        language: 'java',
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', ifaceId),
        fromId: fileNodeId,
        toId: ifaceId,
        kind: 'exports',
        reason: `defines interface ${ifaceName}`,
      });
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
    for (const node of this.findByTypes(root, ['method_declaration', 'constructor_declaration'])) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const methodName = nameNode.text;
      if (seen.has(methodName)) continue;
      seen.add(methodName);

      const methodId = makeNodeId('method', filePath, methodName);
      nodes.push({
        id: methodId,
        kind: 'method',
        name: methodName,
        filePath,
        description: `Method ${methodName} in ${path.basename(filePath)}`,
        isExternal: false,
        language: 'java',
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', methodId),
        fromId: fileNodeId,
        toId: methodId,
        kind: 'exports',
        reason: `defines method ${methodName}`,
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
