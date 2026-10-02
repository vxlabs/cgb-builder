/**
 * Python language adapter.
 *
 * Extracts:
 *  - import / from … import statements → imports edges
 *  - class definitions                  → class nodes + inherits edges
 *  - function / method definitions      → function / method nodes
 */

import * as fs from 'fs';
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

export class PythonAdapter implements LanguageAdapter {
  readonly language = 'python' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'python');
    this.src = source;

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      startLine: 1,
      endLine: source.replace(/\r?\n$/, '').split(/\r?\n/).length,
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
    const name = node.childForFieldName('name')?.text ?? '';
    return {
      ...nodeRange(node),
      signature: oneLine(header.replace(/[{:;=]+$/, '').trim()),
      doc: leadingDocComment(node, this.src, 'python'),
      exported: !name.startsWith('_') || (name.startsWith('__') && name.endsWith('__')),
    };
  }

  private extractImports(
    root: Parser.SyntaxNode,
    filePath: string,
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

      if (moduleName.startsWith('.')) {
        // Relative import: resolve to local files; never create an external node.
        const targets = this.resolveRelative(filePath, node.text);
        if (targets.length === 0) {
          debug('parser', `python: unresolved relative import ${moduleName} in ${filePath}`);
        }
        for (const target of targets) {
          const toId = makeNodeId('file', target);
          const edgeId = makeEdgeId(fileNodeId, 'imports', toId);
          if (edges.some((e) => e.id === edgeId)) continue;
          edges.push({
            id: edgeId,
            fromId: fileNodeId,
            toId,
            kind: 'imports',
            reason: `imports ${moduleName}`,
          });
        }
        continue;
      }
      const topModule = moduleName.replace(/^\.+/, '').split('.')[0] || moduleName;
      const extId = makeNodeId('external_dep', topModule);

      if (!nodes.find((n) => n.id === extId)) {
        nodes.push({
          id: extId,
          kind: 'external_dep',
          name: topModule,
          filePath: topModule,
          description: `Python module: ${moduleName}`,
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
        reason: `imports ${moduleName}`,
      });
    }
  }

  /**
   * Resolve `from .b import x` / `from . import x` / `from ..pkg.mod import z` against the
   * importing file's package directory. Tries `<path>.py` then `<path>/__init__.py`.
   */
  private resolveRelative(filePath: string, stmt: string): string[] {
    const m = /^from\s+(\.+)([\w.]*)\s+import\s+([\s\S]*)$/.exec(stmt.trim());
    if (!m) return [];
    let base = path.dirname(filePath);
    for (let i = 1; i < m[1].length; i++) base = path.dirname(base);
    const tryModule = (p: string): string | null => {
      for (const c of [p + '.py', path.join(p, '__init__.py')]) {
        if (fs.existsSync(c)) return c;
      }
      return null;
    };
    if (m[2]) {
      const hit = tryModule(path.join(base, ...m[2].split('.')));
      return hit ? [hit] : [];
    }
    // from . import a, b as c -> each name may be a submodule; else the package __init__
    const names = m[3]
      .replace(/[()]/g, ' ')
      .split(',')
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter((n) => n && n !== '*');
    const out: string[] = [];
    for (const n of names) {
      const hit = tryModule(path.join(base, n));
      if (hit) out.push(hit);
    }
    if (out.length === 0) {
      const init = path.join(base, '__init__.py');
      if (fs.existsSync(init)) out.push(init);
    }
    return out;
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
        ...this.meta(node),
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
        ...this.meta(node),
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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
      const cur = stack.pop()!;
      if (types.includes(cur.type)) results.push(cur);
      for (const child of cur.children) stack.push(child);
    }
    return results;
  }
}
