/**
 * TypeScript & JavaScript language adapter.
 *
 * Extracts:
 *  - import / require statements  → imports edges
 *  - export declarations           → exports edges
 *  - class / interface definitions → class / interface nodes + inherits / implements edges
 *  - function / method definitions → function / method nodes
 *  - function call expressions     → calls edges
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile, SupportedLanguage } from '../../types.js';

// ─── Tree-sitter queries ──────────────────────────────────────────────────────

/**
 * Queries written in tree-sitter query syntax (S-expression patterns).
 * We use broad patterns that work for both JS and TS.
 */

// Import statements: import ... from '...'  /  import('...')
const IMPORT_QUERY = `
[
  (import_statement source: (string) @import_path)
  (call_expression
    function: (identifier) @require_fn (#eq? @require_fn "require")
    arguments: (arguments (string) @import_path))
  (import_statement source: (string) @import_path)
]
`;

// Export declarations (to mark public API) — kept for future use
// const EXPORT_QUERY = `...

// Class declarations
const CLASS_QUERY = `
(class_declaration
  name: (type_identifier) @class_name
  (class_heritage
    (extends_clause value: (_) @extends_name) ?
    (implements_clause (type_identifier) @implements_name) *
  ) ?
) @class_decl
`;

// Interface declarations (TypeScript)
const INTERFACE_QUERY = `
(interface_declaration
  name: (type_identifier) @interface_name
  (extends_type_clause (type_identifier) @extends_name) ?
) @interface_decl
`;

// Function / method declarations
const FUNCTION_QUERY = `
[
  (function_declaration name: (identifier) @fn_name) @fn_decl
  (method_definition key: (property_identifier) @fn_name) @fn_decl
  (arrow_function) @fn_decl
  (variable_declarator
    name: (identifier) @fn_name
    value: (arrow_function)) @fn_decl
  (lexical_declaration
    (variable_declarator
      name: (identifier) @fn_name
      value: (arrow_function))) @fn_decl
]
`;

// Call expressions — kept for future use
// const CALL_QUERY = `...

// ─── TypeScriptAdapter ────────────────────────────────────────────────────────

export class TypeScriptAdapter implements LanguageAdapter {
  readonly language: SupportedLanguage;

  constructor(lang: 'typescript' | 'javascript' = 'typescript') {
    this.language = lang;
  }

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, this.language);
    const langObj = await treeSitterEngine.loadLanguage(this.language);

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    // File node (always created)
    const fileNodeId = makeNodeId('file', filePath);
    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `Source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: this.language,
      meta: '{}',
    });

    // ── Imports ──────────────────────────────────────────────────────────────
    this.extractImports(tree, langObj, filePath, fileNodeId, nodes, edges);

    // ── Classes ──────────────────────────────────────────────────────────────
    this.extractClasses(tree, langObj, filePath, fileNodeId, nodes, edges, source);

    // ── Interfaces ───────────────────────────────────────────────────────────
    this.extractInterfaces(tree, langObj, filePath, fileNodeId, nodes, edges);

    // ── Functions ────────────────────────────────────────────────────────────
    this.extractFunctions(tree, langObj, filePath, fileNodeId, nodes, edges, source);

    return { filePath, language: this.language, nodes, edges };
  }

  // ─── Private extraction helpers ────────────────────────────────────────────

  private extractImports(
    tree: Parser.Tree,
    lang: Parser.Language,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      const q = lang.query(IMPORT_QUERY);
      const captures = q.captures(tree.rootNode);
      const seen = new Set<string>();

      for (const { name, node } of captures) {
        if (name !== 'import_path') continue;
        // Strip surrounding quotes
        const rawPath = node.text.replace(/^['"`]|['"`]$/g, '');
        if (seen.has(rawPath)) continue;
        seen.add(rawPath);

        const isExternal = !rawPath.startsWith('.');
        const targetNodeId = isExternal
          ? makeNodeId('external_dep', rawPath)
          : makeNodeId('file', this.resolveTs(filePath, rawPath));

        // Ensure the external dep node exists
        if (isExternal) {
          const pkgName = rawPath.split('/')[0];
          const extId = makeNodeId('external_dep', pkgName);
          if (!nodes.find((n) => n.id === extId)) {
            nodes.push({
              id: extId,
              kind: 'external_dep',
              name: pkgName,
              filePath: pkgName,
              description: `External dependency: ${pkgName}`,
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
        } else {
          edges.push({
            id: makeEdgeId(fileNodeId, 'imports', targetNodeId),
            fromId: fileNodeId,
            toId: targetNodeId,
            kind: 'imports',
            reason: `imports ${rawPath}`,
          });
        }
      }
    } catch {
      // Query may fail on malformed source — gracefully skip
    }
  }

  private extractClasses(
    tree: Parser.Tree,
    lang: Parser.Language,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
    source: string,
  ): void {
    try {
      const q = lang.query(CLASS_QUERY);
      const matches = q.matches(tree.rootNode);

      for (const match of matches) {
        const classNameCapture = match.captures.find((c) => c.name === 'class_name');
        if (!classNameCapture) continue;
        const className = classNameCapture.node.text;
        const classNodeId = makeNodeId('class', filePath, className);

        // Get surrounding comment as description
        const classDecl = match.captures.find((c) => c.name === 'class_decl');
        const snippet = classDecl
          ? truncate(source.slice(classDecl.node.startIndex, classDecl.node.startIndex + 120))
          : '';

        nodes.push({
          id: classNodeId,
          kind: 'class',
          name: className,
          filePath,
          description: `Class ${className}. ${snippet}`,
          isExternal: false,
          language: this.language,
          meta: JSON.stringify({ visibility: 'public' }),
        });

        // File exports the class
        edges.push({
          id: makeEdgeId(fileNodeId, 'exports', classNodeId),
          fromId: fileNodeId,
          toId: classNodeId,
          kind: 'exports',
          reason: `defines class ${className}`,
        });

        // Extends
        const extendsCapture = match.captures.find((c) => c.name === 'extends_name');
        if (extendsCapture) {
          const parentName = extendsCapture.node.text;
          const parentId = makeNodeId('class', filePath, parentName);
          edges.push({
            id: makeEdgeId(classNodeId, 'inherits', parentId),
            fromId: classNodeId,
            toId: parentId,
            kind: 'inherits',
            reason: `extends ${parentName}`,
          });
        }

        // Implements
        for (const cap of match.captures.filter((c) => c.name === 'implements_name')) {
          const ifaceName = cap.node.text;
          const ifaceId = makeNodeId('interface', filePath, ifaceName);
          edges.push({
            id: makeEdgeId(classNodeId, 'implements', ifaceId),
            fromId: classNodeId,
            toId: ifaceId,
            kind: 'implements',
            reason: `implements ${ifaceName}`,
          });
        }
      }
    } catch {
      // Skip on query error
    }
  }

  private extractInterfaces(
    tree: Parser.Tree,
    lang: Parser.Language,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    try {
      const q = lang.query(INTERFACE_QUERY);
      const matches = q.matches(tree.rootNode);

      for (const match of matches) {
        const nameCap = match.captures.find((c) => c.name === 'interface_name');
        if (!nameCap) continue;
        const ifaceName = nameCap.node.text;
        const ifaceId = makeNodeId('interface', filePath, ifaceName);

        nodes.push({
          id: ifaceId,
          kind: 'interface',
          name: ifaceName,
          filePath,
          description: `Interface ${ifaceName}`,
          isExternal: false,
          language: this.language,
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
    } catch {
      // Skip on query error
    }
  }

  private extractFunctions(
    tree: Parser.Tree,
    lang: Parser.Language,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
    _source: string,
  ): void {
    try {
      const q = lang.query(FUNCTION_QUERY);
      const captures = q.captures(tree.rootNode);

      const seen = new Set<string>();
      for (const { name, node } of captures) {
        if (name !== 'fn_name') continue;
        const fnName = node.text;
        if (seen.has(fnName) || fnName.length === 0) continue;
        seen.add(fnName);

        const fnId = makeNodeId('function', filePath, fnName);

        nodes.push({
          id: fnId,
          kind: 'function',
          name: fnName,
          filePath,
          description: `Function ${fnName} in ${path.basename(filePath)}`,
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
    } catch {
      // Skip on query error
    }
  }

  /** Resolve a relative TS/JS import path to an absolute path */
  private resolveTs(fromFile: string, importPath: string): string {
    const dir = path.dirname(fromFile);
    // TypeScript source files import with .js/.jsx/.mjs/.cjs extensions at runtime
    // (e.g. import from '../graph/db.js') but the actual source is .ts/.tsx.
    // Strip those extensions before resolution so we find the real .ts file.
    const stripped = importPath.replace(/\.(m?jsx?|cjs)$/, '');
    const resolved = path.resolve(dir, stripped);
    // Try source extensions first (prefer .ts over .js for the same base name)
    const extensions = ['.ts', '.tsx', '.js', '.jsx'];
    for (const ext of extensions) {
      if (require('fs').existsSync(resolved + ext)) return resolved + ext;
    }
    // Try index file
    for (const ext of extensions) {
      const idx = path.join(resolved, `index${ext}`);
      if (require('fs').existsSync(idx)) return idx;
    }
    // Return the stripped path (without phantom extension) as fallback
    return resolved;
  }
}
