/**
 * Python language adapter.
 *
 * Extracts:
 *  - import / from … import statements → imports edges
 *  - class definitions                  → class nodes + inherits edges
 *  - function / method definitions      → function / method nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';

export class PythonAdapter implements LanguageAdapter {
  readonly language = 'python' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'python');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `Python source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'python',
      meta: '{}',
    });

    this.extractImports(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractClasses(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractFunctions(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'python', nodes, edges };
  }

  private extractImports(
    root: Parser.SyntaxNode,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByTypes(root, ['import_statement', 'import_from_statement'])) {
      // Get module name from text
      const text = node.text;
      let moduleName: string | null = null;
      if (text.startsWith('from ')) {
        const match = /^from\s+([\w.]+)/.exec(text);
        if (match) moduleName = match[1];
      } else {
        const match = /^import\s+([\w.]+)/.exec(text);
        if (match) moduleName = match[1];
      }
      if (!moduleName || seen.has(moduleName)) continue;
      seen.add(moduleName);

      const isRelative = moduleName.startsWith('.');
      const topModule = moduleName.replace(/^\.+/, '').split('.')[0] || moduleName;
      const extId = makeNodeId('external_dep', topModule);

      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: topModule,
          filePath: topModule,
          description: `Python module: ${moduleName}`,
          isExternal: !isRelative,
          language: null,
          meta: '{}',
        });
      }

      edges.push({
        id: makeEdgeId(fileNodeId, 'imports', extId),
        fromId: fileNodeId,
        toId: extId,
        kind: 'imports',
        reason: `imports ${moduleName}`,
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
    for (const node of this.findByTypes(root, ['class_definition'])) {
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
        language: 'python',
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', classId),
        fromId: fileNodeId,
        toId: classId,
        kind: 'exports',
        reason: `defines class ${className}`,
      });

      // Superclasses from argument_list
      const argList = node.childForFieldName('superclasses');
      if (argList) {
        for (const child of argList.namedChildren) {
          const baseName = child.text.trim();
          if (!baseName || baseName === 'object') continue;
          const baseId = makeNodeId('class', filePath, baseName);
          edges.push({
            id: makeEdgeId(classId, 'inherits', baseId),
            fromId: classId,
            toId: baseId,
            kind: 'inherits',
            reason: `extends ${baseName}`,
          });
        }
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
    for (const node of this.findByTypes(root, ['function_definition'])) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const fnName = nameNode.text;
      if (seen.has(fnName)) continue;
      seen.add(fnName);

      const fnId = makeNodeId('function', filePath, fnName);
      nodes.push({
        id: fnId,
        kind: 'function',
        name: fnName,
        filePath,
        description: `Function ${fnName} in ${path.basename(filePath)}`,
        isExternal: false,
        language: 'python',
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
