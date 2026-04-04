/**
 * C# language adapter.
 *
 * Extracts:
 *  - using directives          → imports edges
 *  - class / record definitions → class nodes + inherits / implements edges
 *  - interface definitions      → interface nodes
 *  - method declarations        → method nodes
 *  - namespace declarations     → module nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';

// ─── CSharpAdapter ────────────────────────────────────────────────────────────

export class CSharpAdapter implements LanguageAdapter {
  readonly language = 'csharp' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'csharp');
    const langObj = await treeSitterEngine.loadLanguage('csharp');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    // File node
    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `C# source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'csharp',
      meta: '{}',
    });

    // ── Using directives ─────────────────────────────────────────────────────
    this.extractUsings(tree, langObj, filePath, fileNodeId, nodes, edges);

    // ── Namespaces ───────────────────────────────────────────────────────────
    this.extractNamespaces(tree, langObj, filePath, fileNodeId, nodes, edges);

    // ── Classes & Records ────────────────────────────────────────────────────
    this.extractClasses(tree, langObj, filePath, fileNodeId, nodes, edges, source);

    // ── Interfaces ───────────────────────────────────────────────────────────
    this.extractInterfaces(tree, langObj, filePath, fileNodeId, nodes, edges);

    // ── Methods ──────────────────────────────────────────────────────────────
    this.extractMethods(tree, langObj, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'csharp', nodes, edges };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private extractUsings(
    tree: Parser.Tree,
    _lang: Parser.Language,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      // Use a simpler approach for usings — walk the tree manually
      const usingNodes = this.findNodesByType(tree.rootNode, 'using_directive');
      const seen = new Set<string>();

      for (const usingNode of usingNodes) {
        const nameText = usingNode.text
          .replace(/^using\s+(static\s+)?/, '')
          .replace(/;$/, '')
          .trim();
        if (!nameText || seen.has(nameText)) continue;
        seen.add(nameText);

        // Top-level namespace (first segment)
        const topNs = nameText.split('.')[0];
        const extId = makeNodeId('external_dep', topNs);

        if (!nodes.find((n) => n.id === extId)) {
          nodes.push({
            id: extId,
            kind: 'external_dep',
            name: topNs,
            filePath: topNs,
            description: `Namespace: ${nameText}`,
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
          reason: `using ${nameText}`,
        });
      }
    } catch {
      // Gracefully skip
    }
  }

  private extractNamespaces(
    tree: Parser.Tree,
    _lang: Parser.Language,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      const nsNodes = this.findNodesByType(tree.rootNode, 'namespace_declaration');
      for (const nsNode of nsNodes) {
        const nameNode = nsNode.childForFieldName('name');
        if (!nameNode) continue;
        const nsName = nameNode.text;
        const nsId = makeNodeId('module', filePath, nsName);

        nodes.push({
          id: nsId,
          kind: 'module',
          name: nsName,
          filePath,
          description: `Namespace ${nsName}`,
          isExternal: false,
          language: 'csharp',
          meta: '{}',
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', nsId),
          fromId: fileNodeId,
          toId: nsId,
          kind: 'exports',
          reason: `declares namespace ${nsName}`,
        });
      }
    } catch {
      // Gracefully skip
    }
  }

  private extractClasses(
    tree: Parser.Tree,
    _lang: Parser.Language,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
    source: string,
  ): void {
    try {
      const classNodes = [
        ...this.findNodesByType(tree.rootNode, 'class_declaration'),
        ...this.findNodesByType(tree.rootNode, 'record_declaration'),
      ];

      for (const classNode of classNodes) {
        const nameNode = classNode.childForFieldName('name');
        if (!nameNode) continue;
        const className = nameNode.text;
        const classId = makeNodeId('class', filePath, className);
        const snippet = truncate(source.slice(classNode.startIndex, classNode.startIndex + 120));

        nodes.push({
          id: classId,
          kind: 'class',
          name: className,
          filePath,
          description: `Class ${className}. ${snippet}`,
          isExternal: false,
          language: 'csharp',
          meta: JSON.stringify({ isRecord: classNode.type === 'record_declaration' }),
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', classId),
          fromId: fileNodeId,
          toId: classId,
          kind: 'exports',
          reason: `defines class ${className}`,
        });

        // Base list (extends / implements)
        const baseList = classNode.childForFieldName('bases');
        if (baseList) {
          for (const child of baseList.namedChildren) {
            const baseName = child.text.split('<')[0].trim(); // strip generics
            if (!baseName) continue;
            // We can't tell if it's a class or interface statically without type info,
            // so use a generic "class" node as target and mark reason clearly
            const parentId = makeNodeId('class', filePath, baseName);
            edges.push({
              id: makeEdgeId(classId, 'inherits', parentId),
              fromId: classId,
              toId: parentId,
              kind: 'inherits',
              reason: `inherits or implements ${baseName}`,
            });
          }
        }
      }
    } catch {
      // Gracefully skip
    }
  }

  private extractInterfaces(
    tree: Parser.Tree,
    _lang: Parser.Language,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      const ifaceNodes = this.findNodesByType(tree.rootNode, 'interface_declaration');
      for (const ifaceNode of ifaceNodes) {
        const nameNode = ifaceNode.childForFieldName('name');
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
          language: 'csharp',
          meta: '{}',
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', ifaceId),
          fromId: fileNodeId,
          toId: ifaceId,
          kind: 'exports',
          reason: `defines interface ${ifaceName}`,
        });

        // Base interfaces
        const baseList = ifaceNode.childForFieldName('bases');
        if (baseList) {
          for (const child of baseList.namedChildren) {
            const baseName = child.text.split('<')[0].trim();
            if (!baseName) continue;
            const baseId = makeNodeId('interface', filePath, baseName);
            edges.push({
              id: makeEdgeId(ifaceId, 'inherits', baseId),
              fromId: ifaceId,
              toId: baseId,
              kind: 'inherits',
              reason: `extends interface ${baseName}`,
            });
          }
        }
      }
    } catch {
      // Gracefully skip
    }
  }

  private extractMethods(
    tree: Parser.Tree,
    _lang: Parser.Language,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      const methodNodes = [
        ...this.findNodesByType(tree.rootNode, 'method_declaration'),
        ...this.findNodesByType(tree.rootNode, 'constructor_declaration'),
      ];
      const seen = new Set<string>();

      for (const methodNode of methodNodes) {
        const nameNode = methodNode.childForFieldName('name');
        if (!nameNode) continue;
        const methodName = nameNode.text;
        if (seen.has(methodName)) continue;
        seen.add(methodName);

        const returnTypeNode = methodNode.childForFieldName('type');
        const returnType = returnTypeNode?.text ?? 'void';

        const methodId = makeNodeId('method', filePath, methodName);

        nodes.push({
          id: methodId,
          kind: 'method',
          name: methodName,
          filePath,
          description: `Method ${methodName}: ${returnType}`,
          isExternal: false,
          language: 'csharp',
          meta: JSON.stringify({ returnType }),
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', methodId),
          fromId: fileNodeId,
          toId: methodId,
          kind: 'exports',
          reason: `defines method ${methodName}`,
        });
      }
    } catch {
      // Gracefully skip
    }
  }

  /** Walk the tree recursively to find all nodes of a given type */
  private findNodesByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    const stack: Parser.SyntaxNode[] = [node];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.type === type) {
        results.push(current);
      }
      for (const child of current.children) {
        stack.push(child);
      }
    }
    return results;
  }
}
