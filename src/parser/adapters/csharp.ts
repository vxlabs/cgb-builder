/**
 * C# language adapter.
 *
 * Extracts:
 *  - using directives          → imports edges
 *  - class / record definitions → class nodes + inherits / implements edges
 *  - interface definitions      → interface nodes
 *  - method declarations        → method nodes + contains edges
 *  - method invocations         → calls edges
 *  - namespace declarations     → module nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { debug } from '../../util/log.js';
import {
  makeNodeId,
  makeEdgeId,
  fileDisplayName,
  truncate,
  nodeRange,
  oneLine,
  leadingDocComment,
} from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';

// ─── CSharpAdapter ────────────────────────────────────────────────────────────

export class CSharpAdapter implements LanguageAdapter {
  readonly language = 'csharp' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'csharp');
    this.src = source;
    const langObj = await treeSitterEngine.loadLanguage('csharp');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    // File node
    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      startLine: 1,
      endLine: source.replace(/\r?\n$/, '').split(/\r?\n/).length,
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

    // ── Classes & Records (with methods + calls inside) ─────────────────────
    this.extractClasses(tree, langObj, filePath, fileNodeId, nodes, edges, source);

    // ── Interfaces ───────────────────────────────────────────────────────────
    this.extractInterfaces(tree, langObj, filePath, fileNodeId, nodes, edges);

    // ── Top-level methods (not inside a class) ──────────────────────────────
    this.extractTopLevelMethods(tree, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'csharp', nodes, edges };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private src = '';

  /** Line range, signature, doc comment and export flag for a declaration node. */
  private meta(
    node: Parser.SyntaxNode,
  ): Pick<GraphNode, 'startLine' | 'endLine' | 'signature' | 'doc' | 'exported'> {
    const body =
      node.childForFieldName('body') ?? node.namedChildren.find((c) => /body|block/.test(c.type));
    const header = body
      ? this.src.slice(node.startIndex, body.startIndex)
      : ((node.text.split('{')[0] ?? '').split(/\r?\n/)[0] ?? '');
    return {
      ...nodeRange(node),
      signature: oneLine(header.replace(/[{:;=]+$/, '').trim()),
      doc: leadingDocComment(node, this.src, 'slash'),
      exported: node.children.some((c) => c.type === 'modifier' && c.text === 'public'),
    };
  }

  private extractUsings(
    tree: Parser.Tree,
    _lang: Parser.Language,
    _filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      const usingNodes = this.findNodesByType(tree.rootNode, 'using_directive');
      const seen = new Set<string>();

      for (const usingNode of usingNodes) {
        const nameText = usingNode.text
          .replace(/^using\s+(static\s+)?/, '')
          .replace(/;$/, '')
          .trim();
        if (!nameText || seen.has(nameText)) continue;
        seen.add(nameText);

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
    } catch (err) {
      debug('parser', 'csharp extraction step failed', err);
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
      // Also handle file-scoped namespaces
      const fileScopedNs = this.findNodesByType(tree.rootNode, 'file_scoped_namespace_declaration');
      const allNs = [...nsNodes, ...fileScopedNs];

      for (const nsNode of allNs) {
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
          ...this.meta(nsNode),
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
    } catch (err) {
      debug('parser', 'csharp extraction step failed', err);
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
          ...this.meta(classNode),
          isExternal: false,
          language: 'csharp',
          meta: JSON.stringify({ isRecord: classNode.type === 'record_declaration' }),
        });

        // file contains class
        edges.push({
          id: makeEdgeId(fileNodeId, 'contains', classId),
          fromId: fileNodeId,
          toId: classId,
          kind: 'contains',
          reason: `file defines class ${className}`,
        });

        // Base list (extends / implements)
        const baseList = classNode.childForFieldName('bases');
        if (baseList) {
          for (const child of baseList.namedChildren) {
            const baseName = child.text.split('<')[0].trim();
            if (!baseName) continue;
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

        // Extract methods inside this class
        this.extractClassMethods(classNode, filePath, classId, className, nodes, edges);
      }
    } catch (err) {
      debug('parser', 'csharp extraction step failed', err);
    }
  }

  private extractClassMethods(
    classNode: Parser.SyntaxNode,
    filePath: string,
    classId: string,
    className: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      const methodNodes = [
        ...this.findNodesByType(classNode, 'method_declaration'),
        ...this.findNodesByType(classNode, 'constructor_declaration'),
      ];
      const seenMethods = new Set<string>();

      for (const methodNode of methodNodes) {
        const nameNode = methodNode.childForFieldName('name');
        const methodName = nameNode?.text ?? className; // constructor uses class name
        const qualifiedName = `${className}.${methodName}`;
        if (seenMethods.has(qualifiedName)) continue;
        seenMethods.add(qualifiedName);

        const returnTypeNode = methodNode.childForFieldName('type');
        const returnType = returnTypeNode?.text ?? 'void';

        const methodId = makeNodeId('method', filePath, qualifiedName);

        nodes.push({
          id: methodId,
          kind: 'method',
          name: methodName,
          filePath,
          description: `${className}.${methodName}(${this.extractParams(methodNode)}): ${returnType}`,
          ...this.meta(methodNode),
          isExternal: false,
          language: 'csharp',
          meta: JSON.stringify({ returnType, className }),
        });

        // class contains method
        edges.push({
          id: makeEdgeId(classId, 'contains', methodId),
          fromId: classId,
          toId: methodId,
          kind: 'contains',
          reason: `${className} defines method ${methodName}`,
        });

        // Extract calls from this method body
        this.extractCalls(methodNode, filePath, methodId, nodes, edges);
      }
    } catch (err) {
      debug('parser', 'csharp extraction step failed', err);
    }
  }

  private extractCalls(
    methodNode: Parser.SyntaxNode,
    filePath: string,
    callerMethodId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      const invocations = this.findNodesByType(methodNode, 'invocation_expression');
      const seenCalls = new Set<string>();

      for (const invocation of invocations) {
        // Parse the invocation to get the method being called
        // Patterns: obj.Method(...), Method(...), this.Method(...), base.Method(...)
        const funcNode = invocation.childForFieldName('function');
        if (!funcNode) continue;

        let calledName = '';
        if (funcNode.type === 'member_access_expression') {
          const nameChild = funcNode.childForFieldName('name');
          calledName = nameChild?.text ?? '';
        } else if (funcNode.type === 'identifier') {
          calledName = funcNode.text;
        } else {
          calledName = funcNode.text;
        }

        if (!calledName || calledName.length > 60) continue;
        if (seenCalls.has(calledName)) continue;
        seenCalls.add(calledName);

        // Try to find a matching method node in the same file
        const targetId = this.findMethodTarget(calledName, filePath, nodes);
        if (targetId) {
          const edgeId = makeEdgeId(callerMethodId, 'calls', targetId);
          if (!edges.find((e) => e.id === edgeId)) {
            edges.push({
              id: edgeId,
              fromId: callerMethodId,
              toId: targetId,
              kind: 'calls',
              reason: `calls ${calledName}`,
            });
          }
        }
      }

      // Also extract object_creation_expression (new Foo())
      const creations = this.findNodesByType(methodNode, 'object_creation_expression');
      for (const creation of creations) {
        const typeNode = creation.childForFieldName('type');
        if (!typeNode) continue;
        const typeName = typeNode.text.split('<')[0].trim();
        if (!typeName || typeName.length > 60 || seenCalls.has(`new:${typeName}`)) continue;
        seenCalls.add(`new:${typeName}`);

        // Link to the class constructor or class itself
        const targetClassId = this.findClassTarget(typeName, filePath, nodes);
        if (targetClassId) {
          const edgeId = makeEdgeId(callerMethodId, 'calls', targetClassId);
          if (!edges.find((e) => e.id === edgeId)) {
            edges.push({
              id: edgeId,
              fromId: callerMethodId,
              toId: targetClassId,
              kind: 'calls',
              reason: `instantiates ${typeName}`,
            });
          }
        }
      }
    } catch (err) {
      debug('parser', 'csharp extraction step failed', err);
    }
  }

  private findMethodTarget(
    methodName: string,
    filePath: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
  ): string | null {
    // Look for a method node matching the name in the same file
    for (const n of nodes) {
      if (n.kind === 'method' && n.name === methodName && n.filePath === filePath) {
        return n.id;
      }
    }
    return null;
  }

  private findClassTarget(
    className: string,
    filePath: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
  ): string | null {
    for (const n of nodes) {
      if (n.kind === 'class' && n.name === className && n.filePath === filePath) {
        return n.id;
      }
    }
    return null;
  }

  private extractParams(methodNode: Parser.SyntaxNode): string {
    try {
      const paramList = methodNode.childForFieldName('parameters');
      if (!paramList) return '';
      const params: string[] = [];
      for (const child of paramList.namedChildren) {
        if (child.type === 'parameter') {
          const typeNode = child.childForFieldName('type');
          const nameNode = child.childForFieldName('name');
          if (typeNode && nameNode) {
            params.push(`${typeNode.text} ${nameNode.text}`);
          }
        }
      }
      return truncate(params.join(', '), 80);
    } catch (err) {
      debug('parser', 'csharp extraction step failed', err);
      return '';
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
          ...this.meta(ifaceNode),
          isExternal: false,
          language: 'csharp',
          meta: '{}',
        });

        // file contains interface
        edges.push({
          id: makeEdgeId(fileNodeId, 'contains', ifaceId),
          fromId: fileNodeId,
          toId: ifaceId,
          kind: 'contains',
          reason: `file defines interface ${ifaceName}`,
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

        // Extract method signatures from interface
        const methodDecls = this.findNodesByType(ifaceNode, 'method_declaration');
        for (const methodNode of methodDecls) {
          const methNameNode = methodNode.childForFieldName('name');
          if (!methNameNode) continue;
          const methodName = methNameNode.text;
          const qualifiedName = `${ifaceName}.${methodName}`;
          const methodId = makeNodeId('method', filePath, qualifiedName);
          const returnTypeNode = methodNode.childForFieldName('type');
          const returnType = returnTypeNode?.text ?? 'void';

          nodes.push({
            id: methodId,
            kind: 'method',
            name: methodName,
            filePath,
            description: `${ifaceName}.${methodName}(${this.extractParams(methodNode)}): ${returnType}`,
            ...this.meta(methodNode),
            isExternal: false,
            language: 'csharp',
            meta: JSON.stringify({ returnType, interfaceName: ifaceName }),
          });

          edges.push({
            id: makeEdgeId(ifaceId, 'contains', methodId),
            fromId: ifaceId,
            toId: methodId,
            kind: 'contains',
            reason: `${ifaceName} declares method ${methodName}`,
          });
        }
      }
    } catch (err) {
      debug('parser', 'csharp extraction step failed', err);
    }
  }

  private extractTopLevelMethods(
    tree: Parser.Tree,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      // Only extract methods that are direct children of namespace or compilation_unit
      // (not inside a class — those are handled by extractClassMethods)
      const topLevelMethods: Parser.SyntaxNode[] = [];
      for (const child of tree.rootNode.children) {
        if (child.type === 'global_statement') {
          const localFuncs = this.findNodesByType(child, 'local_function_statement');
          topLevelMethods.push(...localFuncs);
        }
      }

      const seen = new Set<string>();
      for (const methodNode of topLevelMethods) {
        const nameNode = methodNode.childForFieldName('name');
        if (!nameNode) continue;
        const methodName = nameNode.text;
        if (seen.has(methodName)) continue;
        seen.add(methodName);

        const returnTypeNode = methodNode.childForFieldName('type');
        const returnType = returnTypeNode?.text ?? 'void';
        const methodId = makeNodeId('function', filePath, methodName);

        nodes.push({
          id: methodId,
          kind: 'function',
          name: methodName,
          filePath,
          description: `Top-level function ${methodName}: ${returnType}`,
          ...this.meta(methodNode),
          isExternal: false,
          language: 'csharp',
          meta: JSON.stringify({ returnType }),
        });

        edges.push({
          id: makeEdgeId(fileNodeId, 'contains', methodId),
          fromId: fileNodeId,
          toId: methodId,
          kind: 'contains',
          reason: `file defines function ${methodName}`,
        });
      }
    } catch (err) {
      debug('parser', 'csharp extraction step failed', err);
    }
  }

  /** Walk the tree recursively to find all nodes of a given type */
  private findNodesByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    const stack: Parser.SyntaxNode[] = [node];
    while (stack.length) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
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
