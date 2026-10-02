/**
 * TypeScript & JavaScript language adapter (.ts .tsx .js .jsx .mjs .cjs).
 *
 * Extracts:
 *  - import / require statements   -> imports edges + meta.imports/reexports
 *  - top-level functions, classes, interfaces, type aliases, enums, namespaces
 *  - class members                 -> method nodes (kind `method`, symbol `<Class>.<name>`)
 *  - contains / exports / inherits / implements edges
 *
 * See docs/languages/typescript.md for the full extraction contract.
 */

import * as fs from 'fs';
import * as path from 'path';
import { builtinModules } from 'module';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine, type GrammarKey } from '../tree-sitter-engine.js';
import type { LanguageAdapter, ParsedFileWithRefs, SymbolRef } from '../adapter.js';
import { debug, warnOnce } from '../../util/log.js';
import { findTsPathConfig, expandPathAlias } from '../ts-config.js';
import {
  makeNodeId,
  makeEdgeId,
  fileDisplayName,
  truncate,
  oneLine,
  leadingDocComment,
} from '../utils.js';
import type { GraphEdge, GraphNode, SupportedLanguage } from '../../types.js';

// ─── TypeScriptAdapter ────────────────────────────────────────────────────────

export class TypeScriptAdapter implements LanguageAdapter {
  readonly language: SupportedLanguage;

  constructor(lang: 'typescript' | 'javascript' = 'typescript') {
    this.language = lang;
  }

  async parse(filePath: string, source: string): Promise<ParsedFileWithRefs> {
    // .tsx needs the TSX grammar (JSX would otherwise become ERROR nodes). .jsx stays on JS.
    const grammar: GrammarKey =
      this.language === 'typescript' && filePath.toLowerCase().endsWith('.tsx')
        ? 'tsx'
        : this.language;
    const tree = await treeSitterEngine.parse(source, grammar);

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
      startLine: 1,
      endLine: lastLine(source),
    });

    // ── Imports ──────────────────────────────────────────────────────────────
    this.extractImports(tree.rootNode, filePath, nodes[0], nodes, edges);

    // ── Symbols (functions, classes, methods, interfaces, types, modules) ────
    const refs: SymbolRef[] = [];
    try {
      new SymbolExtractor(filePath, this.language, fileNodeId, source, nodes, edges, refs).run(
        tree.rootNode,
      );
    } catch (err) {
      warnOnce('parser', 'ts:SYMBOLS', 'TypeScript symbol extraction failed', err);
    }

    return { filePath, language: this.language, nodes, edges, refs };
  }

  // ─── Private extraction helpers ────────────────────────────────────────────

  /**
   * Imports, re-exports, dynamic `import('x')` and `require('x')`. Writes
   * `meta.imports` / `meta.reexports` on the file node plus `imports` edges.
   * See docs/languages/typescript.md ("Imports & resolution").
   */
  private extractImports(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNode: Omit<GraphNode, 'updatedAt'>,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const imports: ImportBinding[] = [];
    const reexports: ReexportBinding[] = [];
    const edgeIds = new Set<string>();
    const extIds = new Set<string>();

    const link: LinkFn = (r, spec, reason) => {
      let toId: string;
      if (r.isExternal) {
        toId = makeNodeId('external_dep', r.source);
        if (!extIds.has(toId)) {
          extIds.add(toId);
          nodes.push({
            id: toId,
            kind: 'external_dep',
            name: r.source,
            filePath: r.source,
            description: `External dependency: ${r.source}`,
            isExternal: true,
            language: null,
            meta: '{}',
          });
        }
      } else {
        toId = makeNodeId('file', r.source);
      }
      const id = makeEdgeId(fileNode.id, 'imports', toId);
      if (edgeIds.has(id)) return;
      edgeIds.add(id);
      edges.push({ id, fromId: fileNode.id, toId, kind: 'imports', reason: reason + spec });
    };

    try {
      const stack: Parser.SyntaxNode[] = [root];
      while (stack.length) {
        const n = stack.pop() as Parser.SyntaxNode;
        let descend = true;
        if (n.type === 'import_statement') {
          this.importStatement(n, filePath, imports, link);
          descend = false;
        } else if (n.type === 'export_statement' && n.childForFieldName('source')) {
          this.reexportStatement(n, filePath, reexports, link);
          descend = false;
        } else if (n.type === 'call_expression') {
          this.callImport(n, filePath, imports, link);
        }
        if (descend) {
          for (let i = n.namedChildCount - 1; i >= 0; i--) {
            const c = n.namedChild(i);
            if (c) stack.push(c);
          }
        }
      }
    } catch (err) {
      warnOnce('parser', 'ts:IMPORTS', 'TypeScript import extraction failed', err);
    }

    fileNode.meta = JSON.stringify({ imports, reexports });
  }

  private importStatement(
    n: Parser.SyntaxNode,
    filePath: string,
    imports: ImportBinding[],
    link: LinkFn,
  ): void {
    const spec = stringValue(n.childForFieldName('source'));
    if (spec === null) return;
    const r = resolveSpecifier(filePath, spec);
    if (!r) return;
    link(r, spec, 'imports ');
    const stmtTypeOnly = n.children.some((c) => c.type === 'type');
    const add = (local: string, imported: string, typeOnly: boolean): void => {
      const b: ImportBinding = { source: r.source, isExternal: r.isExternal, local, imported };
      if (typeOnly) b.typeOnly = true;
      imports.push(b);
    };
    const clause = n.namedChildren.find((c) => c.type === 'import_clause');
    if (!clause) {
      add('', '*', stmtTypeOnly); // side-effect import
      return;
    }
    for (const c of clause.namedChildren) {
      if (c.type === 'identifier') {
        add(c.text, 'default', stmtTypeOnly);
      } else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((x) => x.type === 'identifier');
        if (id) add(id.text, '*', stmtTypeOnly);
      } else if (c.type === 'named_imports') {
        for (const s of c.namedChildren) {
          if (s.type !== 'import_specifier') continue;
          const name = s.childForFieldName('name')?.text;
          if (!name) continue;
          const alias = s.childForFieldName('alias')?.text ?? name;
          add(alias, name, stmtTypeOnly || s.children.some((x) => x.type === 'type'));
        }
      }
    }
  }

  private reexportStatement(
    n: Parser.SyntaxNode,
    filePath: string,
    reexports: ReexportBinding[],
    link: LinkFn,
  ): void {
    const spec = stringValue(n.childForFieldName('source'));
    if (spec === null) return;
    const r = resolveSpecifier(filePath, spec);
    if (!r) return;
    link(r, spec, 're-export ');
    const add = (imported: string, exported: string): void => {
      reexports.push({ source: r.source, isExternal: r.isExternal, imported, exported });
    };
    let handled = false;
    for (const c of n.namedChildren) {
      if (c.type === 'namespace_export') {
        const id = c.namedChildren.find((x) => x.type === 'identifier');
        add('*', id ? id.text : '*');
        handled = true;
      } else if (c.type === 'export_clause') {
        for (const s of c.namedChildren) {
          if (s.type !== 'export_specifier') continue;
          const name = s.childForFieldName('name')?.text;
          if (!name) continue;
          add(name, s.childForFieldName('alias')?.text ?? name);
        }
        handled = true;
      }
    }
    if (!handled) add('*', '*'); // export * from 's'
  }

  /** `require('s')` and `import('s')` with a string-literal argument. */
  private callImport(
    n: Parser.SyntaxNode,
    filePath: string,
    imports: ImportBinding[],
    link: LinkFn,
  ): void {
    const fn = n.childForFieldName('function');
    if (!fn) return;
    const isRequire = fn.type === 'identifier' && fn.text === 'require';
    const isDynamic = fn.type === 'import';
    if (!isRequire && !isDynamic) return;
    const args = n.childForFieldName('arguments');
    const first = args?.namedChildren[0] ?? null;
    if (!first || first.type !== 'string') return;
    const spec = stringValue(first);
    if (spec === null) return;
    const r = resolveSpecifier(filePath, spec);
    if (!r) return;
    link(r, spec, isDynamic ? 'dynamically imports ' : 'imports ');

    const mk = (local: string, imported: string): ImportBinding => {
      const b: ImportBinding = { source: r.source, isExternal: r.isExternal, local, imported };
      if (isDynamic) b.dynamic = true;
      return b;
    };
    // Find the declarator that binds the result (through `await`).
    let parent = n.parent;
    if (parent && parent.type === 'await_expression') parent = parent.parent;
    const decl = parent && parent.type === 'variable_declarator' ? parent : null;
    const target = decl?.childForFieldName('name') ?? null;
    if (!target) {
      imports.push(mk('', '*'));
    } else if (target.type === 'identifier') {
      imports.push(mk(target.text, '*'));
    } else if (target.type === 'object_pattern') {
      for (const p of target.namedChildren) {
        if (p.type === 'shorthand_property_identifier_pattern') {
          imports.push(mk(p.text, p.text));
        } else if (p.type === 'pair_pattern') {
          const key = p.childForFieldName('key')?.text;
          let val = p.childForFieldName('value');
          if (val && val.type === 'assignment_pattern') val = val.childForFieldName('left');
          if (key && val && val.type === 'identifier') imports.push(mk(val.text, key));
        } else if (p.type === 'object_assignment_pattern') {
          const left = p.childForFieldName('left');
          if (left) imports.push(mk(left.text, left.text));
        }
      }
    } else {
      imports.push(mk('', '*'));
    }
  }
}

// ─── Import resolution ────────────────────────────────────────────────────────

interface ImportBinding {
  /** resolved absolute file path, or package name if external */
  source: string;
  isExternal: boolean;
  /** local binding name ('' for side-effect import) */
  local: string;
  /** 'default' | '*' | exported name */
  imported: string;
  typeOnly?: boolean;
  dynamic?: boolean;
}

interface ReexportBinding {
  source: string;
  isExternal: boolean;
  /** name, or '*' */
  imported: string;
  /** name as re-exported ('*' for `export *`) */
  exported: string;
}

interface ResolvedSpecifier {
  source: string;
  isExternal: boolean;
}

type LinkFn = (r: ResolvedSpecifier, spec: string, reason: string) => void;

const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));
const JS_EXT_RE = /\.(m?jsx?|cjs)$/;

function stringValue(n: Parser.SyntaxNode | null): string | null {
  if (!n || n.type !== 'string') return null;
  return n.text.replace(/^['"`]|['"`]$/g, '');
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    // A missing path is the normal "candidate does not exist" case.
    return false;
  }
}

/** Resolve a candidate base path to an existing source file, or null. */
function resolveFile(base: string): string | null {
  const stripped = base.replace(JS_EXT_RE, '');
  for (const ext of SOURCE_EXTS) {
    const f = stripped + ext;
    if (isFile(f)) return f;
  }
  for (const ext of SOURCE_EXTS) {
    const f = path.join(stripped, `index${ext}`);
    if (isFile(f)) return f;
  }
  // Non-source assets (`./data.json`) that exist as written
  if (!/\.d\.[cm]?ts$/.test(base) && isFile(base)) return base;
  return null;
}

/** `@a/b/sub` -> `@a/b`, `lodash/fp` -> `lodash`; null for malformed names (`@`, `@/x`). */
function packageName(spec: string): string | null {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2 || parts[0].length < 2 || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

/**
 * Classify and resolve an import specifier.
 * Returns null when the specifier cannot be attributed to anything useful
 * (e.g. an alias like `@/missing` with no file), so no bogus node is created.
 */
function resolveSpecifier(fromFile: string, spec: string): ResolvedSpecifier | null {
  const dir = path.dirname(fromFile);

  // 1. relative
  if (spec.startsWith('.')) {
    const base = path.resolve(dir, spec);
    // Unresolved relative imports keep the stripped path (same as before slice 04)
    return { source: resolveFile(base) ?? base.replace(JS_EXT_RE, ''), isExternal: false };
  }

  // Node builtins (`node:fs`, `fs`, `fs/promises`) are never local
  const first = spec.replace(/^node:/, '').split('/')[0];
  if (spec.startsWith('node:') || NODE_BUILTINS.has(first)) {
    return { source: `node:${first}`, isExternal: true };
  }

  const cfg = findTsPathConfig(dir);
  let aliasMatched = false;
  if (cfg) {
    // 2. tsconfig/jsconfig paths
    for (const cand of expandPathAlias(cfg, spec)) {
      aliasMatched = true;
      const f = resolveFile(cand);
      if (f) return { source: f, isExternal: false };
    }
    // 3. baseUrl
    if (cfg.baseUrl) {
      const f = resolveFile(path.resolve(cfg.baseUrl, spec));
      if (f && !f.includes(`${path.sep}node_modules${path.sep}`))
        return { source: f, isExternal: false };
    }
  }

  // 4. external package
  if (aliasMatched) {
    debug('ts-imports', `alias "${spec}" matched tsconfig paths but no file exists (${fromFile})`);
    return null;
  }
  const pkg = packageName(spec);
  if (!pkg) {
    debug('ts-imports', `cannot attribute "${spec}" to a package (${fromFile})`);
    return null;
  }
  return { source: pkg, isExternal: true };
}

// ─── Symbol extraction ────────────────────────────────────────────────────────

type SyntaxNode = Parser.SyntaxNode;
type OutNode = Omit<GraphNode, 'updatedAt'>;
type OutEdge = Omit<GraphEdge, 'updatedAt'>;

interface Heritage {
  extends: string[];
  implements: string[];
}

interface PendingHeritage {
  fromId: string;
  /** which kind of local symbol the `extends` targets may resolve to */
  extendsKind: 'class' | 'interface';
  heritage: Heritage;
}

const FUNCTION_VALUE_TYPES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);
const FUNCTION_DECL_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
]);
const CLASS_DECL_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);

/** Strip generic arguments and whitespace: `I2<X>` -> `I2`. */
function bareName(text: string): string {
  return text.replace(/<[\s\S]*$/, '').trim();
}

/** Name of a property key node, or null when computed / unsupported. */
function keyName(n: SyntaxNode | null): string | null {
  if (!n) return null;
  switch (n.type) {
    case 'property_identifier':
    case 'private_property_identifier':
    case 'identifier':
      return n.text;
    case 'string':
      return n.text.replace(/^['"`]|['"`]$/g, '') || null;
    default:
      return null; // computed_property_name, number, ...
  }
}

/** Number of the last line of `source` (a trailing newline does not add a line). */
function lastLine(source: string): number {
  const lines = source.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return Math.max(1, lines.length);
}

/** Modifier tokens that precede a member's name, mapped to graph modifier names. */
function memberModifiers(m: SyntaxNode, nameNode: SyntaxNode | null): string[] {
  const out: string[] = [];
  for (const c of m.children) {
    if (nameNode && c.id === nameNode.id) break;
    switch (c.type) {
      case 'accessibility_modifier':
        out.push(c.text);
        break;
      case 'static':
      case 'async':
      case 'abstract':
      case 'readonly':
        out.push(c.type);
        break;
      case 'get':
        out.push('getter');
        break;
      case 'set':
        out.push('setter');
        break;
      case '*':
        out.push('generator');
        break;
      default:
        break;
    }
  }
  return out;
}

/** `<T>(a: A): R` pieces of a function-like node, whitespace preserved (collapsed later). */
function fnParts(fn: SyntaxNode): {
  tp: string;
  params: string;
  ret: string;
  async: boolean;
  gen: boolean;
} {
  const tp = fn.childForFieldName('type_parameters')?.text ?? '';
  const pn = fn.childForFieldName('parameters');
  const single = fn.childForFieldName('parameter');
  const params = (pn ? pn.text : single ? `(${single.text})` : '()')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/,?\s+\)$/, ')');
  let ret = fn.childForFieldName('return_type')?.text ?? '';
  if (ret && !ret.startsWith(':')) ret = `: ${ret}`;
  const async = fn.children.some((c) => c.type === 'async');
  const gen = fn.type.startsWith('generator_') || fn.children.some((c) => c.type === '*');
  return { tp, params, ret, async, gen };
}

const MODIFIER_WORD: Record<string, string> = { getter: 'get', setter: 'set' };

/** `private static async name<T>(p): R` for class / object members. */
function methodSignature(key: string, fn: SyntaxNode, mods: string[]): string {
  const { tp, params, ret } = fnParts(fn);
  const words = mods.filter((m) => m !== 'generator').map((m) => MODIFIER_WORD[m] ?? m);
  const star = mods.includes('generator') ? '*' : '';
  return oneLine(`${words.length ? words.join(' ') + ' ' : ''}${star}${key}${tp}${params}${ret}`);
}

/** `const name = async <T>(p): R =>` */
function arrowSignature(prefix: string, fn: SyntaxNode, sep = '='): string {
  const { tp, params, ret, async } = fnParts(fn);
  return oneLine(
    `${prefix}${sep === ':' ? ':' : ' ='} ${async ? 'async ' : ''}${tp}${params}${ret} =>`,
  );
}

interface Decor {
  /** syntax node whose full text is the declaration (range + doc anchor are derived from it) */
  decl: SyntaxNode;
  signature: string;
  modifiers: string[];
  exported: boolean;
  /** override range/doc start (leading decorators of class members) */
  startNode?: SyntaxNode;
}

class SymbolExtractor {
  private readonly nodeById = new Map<string, OutNode>();
  private readonly edgeIds = new Set<string>();
  private readonly classes = new Map<string, string>();
  private readonly interfaces = new Map<string, string>();
  /** local top-level symbol name -> node id (for name-based exports) */
  private readonly symbols = new Map<string, string>();
  /** names exported via `export { a }`, `export default a`, `module.exports = a`, ... */
  private readonly exportedNames = new Set<string>();
  private readonly pending: PendingHeritage[] = [];
  /** function/method/class syntax node id -> graph node id that owns calls inside it */
  private readonly ownerByNode = new Map<number, string>();
  /** names exported with `export default <ident>` */
  private readonly defaultNames = new Set<string>();
  /** last top-level symbol created/touched by `symbol()` (used to flag `export default`) */
  private lastSymbol: OutNode | null = null;

  constructor(
    private readonly filePath: string,
    private readonly language: SupportedLanguage,
    private readonly fileId: string,
    private readonly source: string,
    private readonly nodes: OutNode[],
    private readonly edges: OutEdge[],
    private readonly refs: SymbolRef[],
  ) {}

  run(root: SyntaxNode): void {
    for (const child of root.namedChildren) this.topLevel(child, false);

    // Exports declared by name (`export { a }`, `module.exports = a`, ...)
    for (const name of this.exportedNames) {
      const id = this.symbols.get(name);
      if (!id) continue;
      this.addEdge(this.fileId, 'exports', id, `exports ${name}`);
      const node = this.nodeById.get(id);
      if (node) {
        node.exported = true;
        if (this.defaultNames.has(name)) this.markDefault(node);
      }
    }

    // Same-file heritage edges (cross-file parents stay in meta.heritage only)
    for (const p of this.pending) {
      for (const parent of p.heritage.extends) {
        const target = (p.extendsKind === 'class' ? this.classes : this.interfaces).get(parent);
        if (target && target !== p.fromId) {
          this.addEdge(p.fromId, 'inherits', target, `extends ${parent}`);
        } else if (!target) {
          this.heritageRef(p.fromId, 'inherits', parent);
        }
      }
      for (const parent of p.heritage.implements) {
        const target = this.interfaces.get(parent);
        if (target && target !== p.fromId) {
          this.addEdge(p.fromId, 'implements', target, `implements ${parent}`);
        } else if (!target) {
          this.heritageRef(p.fromId, 'implements', parent);
        }
      }
    }

    // Calls (resolved later by the Linker)
    this.collectCalls(root);
  }

  // ── refs (calls + cross-file heritage) ───────────────────────────────────

  private heritageRef(fromId: string, kind: 'inherits' | 'implements', parent: string): void {
    if (!parent) return;
    const dot = parent.lastIndexOf('.');
    const ref: SymbolRef = { fromId, kind, name: dot >= 0 ? parent.slice(dot + 1) : parent };
    if (dot >= 0) ref.qualifier = parent.slice(0, dot);
    this.refs.push(ref);
  }

  /**
   * Walk the whole tree; calls are attributed to the nearest enclosing registered
   * top-level owner (function / method / class), else the file node.
   */
  private collectCalls(root: SyntaxNode): void {
    const stack: Array<[SyntaxNode, string]> = [[root, this.fileId]];
    while (stack.length) {
      const [n, parentOwner] = stack.pop() as [SyntaxNode, string];
      const owner = this.ownerByNode.get(n.id) ?? parentOwner;
      if (n.type === 'call_expression' || n.type === 'new_expression') this.callRef(n, owner);
      for (let i = n.namedChildCount - 1; i >= 0; i--) {
        const c = n.namedChild(i);
        if (c) stack.push([c, owner]);
      }
    }
  }

  private callRef(n: SyntaxNode, owner: string): void {
    const isNew = n.type === 'new_expression';
    const fn = n.childForFieldName(isNew ? 'constructor' : 'function');
    if (!fn) return;
    const line = n.startPosition.row + 1;
    const push = (name: string, qualifier?: string): void => {
      const ref: SymbolRef = { fromId: owner, kind: 'calls', name, line };
      if (qualifier) ref.qualifier = qualifier;
      if (isNew) ref.isNew = true;
      this.refs.push(ref);
    };
    if (fn.type === 'identifier') {
      if (!isNew && fn.text === 'require') return;
      push(fn.text);
    } else if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      const obj = fn.childForFieldName('object');
      if (!prop || !obj) return;
      let q: string;
      if (obj.type === 'this') q = 'this';
      else if (obj.type === 'super') q = 'super';
      else {
        q = obj.text.replace(/\?\./g, '.').replace(/\s+/g, '');
        if (!/^[\w$]+(\.[\w$]+)*$/.test(q)) q = '<expr>';
      }
      push(prop.text, q);
    }
    // `import(...)`, `super(...)`, `f()()`, `(a || b)()` are not call refs.
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private snippet(n: SyntaxNode): string {
    return truncate(this.source.slice(n.startIndex, n.startIndex + 120));
  }

  private addEdge(from: string, kind: GraphEdge['kind'], to: string, reason: string): void {
    const id = makeEdgeId(from, kind, to);
    if (this.edgeIds.has(id)) return;
    this.edgeIds.add(id);
    this.edges.push({ id, fromId: from, toId: to, kind, reason });
  }

  /** Add a node, or return the existing one (overloads / declaration merging). */
  private addNode(n: OutNode): { node: OutNode; created: boolean } {
    const existing = this.nodeById.get(n.id);
    if (existing) return { node: existing, created: false };
    this.nodeById.set(n.id, n);
    this.nodes.push(n);
    return { node: n, created: true };
  }

  /** Climb from a declaration to the node that spans it (declaration list, export, declare). */
  private outer(n: SyntaxNode): SyntaxNode {
    let cur = n;
    const p = cur.parent;
    if (
      cur.type === 'variable_declarator' &&
      p &&
      (p.type === 'lexical_declaration' || p.type === 'variable_declaration') &&
      p.namedChildren.filter((c) => c.type === 'variable_declarator').length === 1
    ) {
      cur = p;
    } else if (p && p.type === 'assignment_expression') {
      const gp = p.parent;
      if (gp && gp.type === 'expression_statement') cur = gp;
    }
    while (
      cur.parent &&
      (cur.parent.type === 'export_statement' || cur.parent.type === 'ambient_declaration')
    ) {
      cur = cur.parent;
    }
    return cur;
  }

  /** Fill startLine/endLine/signature/doc/exported/modifiers; merge when the node already exists. */
  private decorate(node: OutNode, d: Decor): void {
    const top = this.outer(d.decl);
    const startNode = d.startNode ?? top;
    const startLine = startNode.startPosition.row + 1;
    const endLine = top.endPosition.row + 1;
    const doc = this.docFor(startNode);

    if (node.startLine === undefined) {
      node.startLine = startLine;
      node.endLine = Math.max(startLine, endLine);
      node.signature = d.signature;
      node.modifiers = [...new Set(d.modifiers)];
      node.exported = d.exported;
      if (doc) {
        node.doc = doc;
        node.description = doc;
      }
      return;
    }
    // overloads / declaration merging / getter+setter: widen the range, union the rest
    node.startLine = Math.min(node.startLine, startLine);
    node.endLine = Math.max(node.endLine ?? endLine, endLine);
    node.modifiers = [...new Set([...(node.modifiers ?? []), ...d.modifiers])];
    node.exported = node.exported || d.exported;
    if (!node.doc && doc) {
      node.doc = doc;
      node.description = doc;
    }
  }

  private docFor(n: SyntaxNode): string | undefined {
    return leadingDocComment(n, this.source, 'jsdoc') ?? leadingDocComment(n, this.source, 'slash');
  }

  private markDefault(node: OutNode): void {
    const meta = JSON.parse(node.meta) as Record<string, unknown>;
    meta.isDefault = true;
    node.meta = JSON.stringify(meta);
    node.modifiers = [...new Set([...(node.modifiers ?? []), 'default'])];
  }

  private symbol(
    kind: 'function' | 'class' | 'interface' | 'type' | 'module',
    name: string,
    exported: boolean,
    description: string,
    meta: Record<string, unknown>,
    verb: string,
    deco: Omit<Decor, 'exported'>,
  ): OutNode {
    const id = makeNodeId(kind, this.filePath, name);
    const { node, created } = this.addNode({
      id,
      kind,
      name,
      filePath: this.filePath,
      description,
      isExternal: false,
      language: this.language,
      meta: JSON.stringify(meta),
    });
    if (created) this.addEdge(this.fileId, 'contains', id, `defines ${verb} ${name}`);
    if (exported) this.addEdge(this.fileId, 'exports', id, `exports ${verb} ${name}`);
    if (kind === 'class') this.classes.set(name, id);
    if (kind === 'interface') this.interfaces.set(name, id);
    if (!this.symbols.has(name) || kind === 'function' || kind === 'class') {
      this.symbols.set(name, id);
    }
    this.decorate(node, { ...deco, exported });
    this.lastSymbol = node;
    return node;
  }

  // ── top-level dispatcher ─────────────────────────────────────────────────

  private topLevel(n: SyntaxNode, exported: boolean): void {
    switch (n.type) {
      case 'export_statement':
        return this.exportStatement(n);
      case 'ambient_declaration':
        for (const c of n.namedChildren) this.topLevel(c, exported);
        return;
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const d of n.namedChildren) {
          if (d.type === 'variable_declarator') this.declarator(d, exported);
        }
        return;
      case 'expression_statement': {
        // `namespace N {}` parses as an expression_statement wrapping internal_module
        const inner = n.namedChildren[0] ?? null;
        if (inner && (inner.type === 'internal_module' || inner.type === 'module')) {
          return this.moduleDecl(inner, exported);
        }
        return this.commonJsAssignment(inner);
      }
      case 'interface_declaration':
        return this.interfaceDecl(n, exported);
      case 'type_alias_declaration':
        return this.typeDecl(n, exported, 'alias');
      case 'enum_declaration':
        return this.typeDecl(n, exported, 'enum');
      case 'internal_module':
      case 'module':
        return this.moduleDecl(n, exported);
      default:
        break;
    }
    if (FUNCTION_DECL_TYPES.has(n.type)) return this.functionDecl(n, exported);
    if (CLASS_DECL_TYPES.has(n.type)) return this.classDecl(n, exported, null);
  }

  private exportStatement(n: SyntaxNode): void {
    const isDefault = n.children.some((c) => c.type === 'default');
    this.lastSymbol = null;
    this.exportStatementInner(n, isDefault);
    if (isDefault && this.lastSymbol) this.markDefault(this.lastSymbol);
  }

  private exportStatementInner(n: SyntaxNode, isDefault: boolean): void {
    const decl = n.childForFieldName('declaration');
    if (decl) return this.topLevel(decl, true);

    const value = n.childForFieldName('value');
    if (value) {
      if (value.type === 'identifier') {
        this.exportedNames.add(value.text);
        if (isDefault) this.defaultNames.add(value.text);
      } else if (CLASS_DECL_TYPES.has(value.type)) {
        this.classDecl(value, true, value.childForFieldName('name')?.text ?? 'default');
      } else if (FUNCTION_VALUE_TYPES.has(value.type)) {
        this.functionNode(value.childForFieldName('name')?.text ?? 'default', true, value);
      }
      return;
    }

    // `export { a, b as c }`; a `source` means a re-export, left to slice 04.
    if (n.childForFieldName('source')) return;
    for (const c of n.namedChildren) {
      if (c.type !== 'export_clause') continue;
      for (const spec of c.namedChildren) {
        if (spec.type !== 'export_specifier') continue;
        const local = spec.childForFieldName('name');
        if (local) this.exportedNames.add(local.text);
      }
    }
  }

  // ── functions ────────────────────────────────────────────────────────────

  private functionDecl(n: SyntaxNode, exported: boolean): void {
    const name = n.childForFieldName('name')?.text;
    if (name) this.functionNode(name, exported, n);
  }

  /** `owner` is the function-like node; `decl` the declaration that spans it (defaults to owner). */
  private functionNode(
    name: string,
    exported: boolean,
    owner: SyntaxNode,
    decl?: SyntaxNode,
  ): void {
    const parts = fnParts(owner);
    const mods: string[] = [];
    if (parts.async) mods.push('async');
    if (parts.gen) mods.push('generator');
    let signature: string;
    if (decl && decl.type === 'variable_declarator') {
      const kw = decl.parent?.children[0]?.text ?? 'const';
      signature = arrowSignature(`${kw} ${name}`, owner);
    } else {
      signature = oneLine(
        `${parts.async ? 'async ' : ''}${parts.gen ? '*' : ''}${name}${parts.tp}${parts.params}${parts.ret}`,
      );
    }
    const fnNode = this.symbol(
      'function',
      name,
      exported,
      `Function ${name} in ${path.basename(this.filePath)}`,
      {},
      'function',
      { decl: decl ?? owner, signature, modifiers: mods },
    );
    this.ownerByNode.set(owner.id, fnNode.id);
  }

  private declarator(d: SyntaxNode, exported: boolean): void {
    const nameNode = d.childForFieldName('name');
    const value = d.childForFieldName('value');
    if (!nameNode || nameNode.type !== 'identifier' || !value) return;
    const name = nameNode.text;
    if (FUNCTION_VALUE_TYPES.has(value.type)) {
      this.functionNode(name, exported, value, d);
    } else if (value.type === 'class') {
      this.classDecl(value, exported, name, d);
    } else if (value.type === 'object') {
      this.objectMethods(name, value, exported);
    }
  }

  /** `const api = { get() {}, post: () => {} }` -> method nodes `api.get`, `api.post` */
  private objectMethods(objName: string, obj: SyntaxNode, exported: boolean): void {
    for (const m of obj.namedChildren) {
      let key: string | null = null;
      let signature = '';
      const mods: string[] = [];
      if (m.type === 'method_definition') {
        const nn = m.childForFieldName('name');
        key = keyName(nn);
        mods.push(...memberModifiers(m, nn));
        if (key) signature = methodSignature(key, m, mods);
      } else if (m.type === 'pair') {
        const v = m.childForFieldName('value');
        if (v && FUNCTION_VALUE_TYPES.has(v.type)) {
          key = keyName(m.childForFieldName('key'));
          const p = fnParts(v);
          if (p.async) mods.push('async');
          if (p.gen) mods.push('generator');
          if (key) signature = arrowSignature(key, v, ':');
        }
      }
      if (!key) continue;
      const symbol = `${objName}.${key}`;
      const id = makeNodeId('method', this.filePath, symbol);
      const { node: mnode, created } = this.addNode({
        id,
        kind: 'method',
        name: symbol,
        filePath: this.filePath,
        description: `Method ${symbol} in ${path.basename(this.filePath)}`,
        isExternal: false,
        language: this.language,
        meta: JSON.stringify({ objectLiteral: true }),
      });
      this.decorate(mnode, { decl: m, signature, modifiers: mods, exported });
      if (created) this.addEdge(this.fileId, 'contains', id, `defines method ${symbol}`);
      this.ownerByNode.set(m.id, id);
      if (exported) this.addEdge(this.fileId, 'exports', id, `exports method ${symbol}`);
    }
  }

  // ── CommonJS (JS) ────────────────────────────────────────────────────────

  private commonJsAssignment(expr: SyntaxNode | null): void {
    if (!expr || expr.type !== 'assignment_expression') return;
    const left = expr.childForFieldName('left');
    const right = expr.childForFieldName('right');
    if (!left || !right || left.type !== 'member_expression') return;

    const isModuleExports = (x: SyntaxNode): boolean =>
      x.type === 'member_expression' &&
      x.childForFieldName('object')?.text === 'module' &&
      x.childForFieldName('property')?.text === 'exports';

    if (isModuleExports(left)) {
      // module.exports = X | { a, b } | function | class
      if (right.type === 'identifier') this.exportedNames.add(right.text);
      else if (right.type === 'object') this.exportedObject(right);
      else if (FUNCTION_VALUE_TYPES.has(right.type)) this.functionNode('default', true, right);
      else if (right.type === 'class') {
        this.classDecl(right, true, right.childForFieldName('name')?.text ?? 'default');
      }
      return;
    }

    // exports.a = ... | module.exports.a = ...
    const obj = left.childForFieldName('object');
    const prop = left.childForFieldName('property')?.text;
    if (!obj || !prop) return;
    if (!(obj.text === 'exports' || isModuleExports(obj))) return;
    if (FUNCTION_VALUE_TYPES.has(right.type)) this.functionNode(prop, true, right);
    else if (right.type === 'class') this.classDecl(right, true, prop);
    else if (right.type === 'identifier') this.exportedNames.add(right.text);
  }

  private exportedObject(obj: SyntaxNode): void {
    for (const m of obj.namedChildren) {
      if (m.type === 'shorthand_property_identifier') {
        this.exportedNames.add(m.text);
      } else if (m.type === 'pair') {
        const key = keyName(m.childForFieldName('key'));
        const v = m.childForFieldName('value');
        if (!key || !v) continue;
        if (v.type === 'identifier') this.exportedNames.add(v.text);
        else if (FUNCTION_VALUE_TYPES.has(v.type)) this.functionNode(key, true, v, m);
      } else if (m.type === 'method_definition') {
        const key = keyName(m.childForFieldName('name'));
        if (key) this.functionNode(key, true, m);
      }
    }
  }

  // ── classes ──────────────────────────────────────────────────────────────

  private heritageOf(n: SyntaxNode): Heritage {
    const h: Heritage = { extends: [], implements: [] };
    for (const c of n.namedChildren) {
      if (c.type !== 'class_heritage') continue;
      for (const part of c.namedChildren) {
        if (part.type === 'extends_clause') {
          const v = part.childForFieldName('value');
          if (v) h.extends.push(bareName(v.text));
        } else if (part.type === 'implements_clause') {
          for (const t of part.namedChildren) h.implements.push(this.typeName(t));
        } else {
          // JavaScript grammar: the extends expression is a direct child
          h.extends.push(bareName(part.text));
        }
      }
    }
    return h;
  }

  private typeName(t: SyntaxNode): string {
    if (t.type === 'generic_type') return bareName(t.childForFieldName('name')?.text ?? t.text);
    return bareName(t.text);
  }

  private classDecl(
    n: SyntaxNode,
    exported: boolean,
    forcedName: string | null,
    decl?: SyntaxNode,
  ): void {
    const name = forcedName ?? n.childForFieldName('name')?.text;
    if (!name) return;
    const heritage = this.heritageOf(n);
    const meta: Record<string, unknown> = { visibility: 'public', heritage };
    if (n.type === 'abstract_class_declaration') meta.abstract = true;
    const node = this.symbol(
      'class',
      name,
      exported,
      `Class ${name}. ${this.snippet(n)}`,
      meta,
      'class',
      {
        decl: decl ?? n,
        signature: oneLine(
          [
            n.type === 'abstract_class_declaration' ? 'abstract ' : '',
            `class ${name}`,
            n.childForFieldName('type_parameters')?.text ?? '',
            ' ',
            n.namedChildren.find((c) => c.type === 'class_heritage')?.text ?? '',
          ].join(''),
        ),
        modifiers: n.type === 'abstract_class_declaration' ? ['abstract'] : [],
      },
    );
    this.pending.push({ fromId: node.id, extendsKind: 'class', heritage });
    this.ownerByNode.set(n.id, node.id);

    const body = n.childForFieldName('body');
    if (body) this.classMembers(name, node.id, body);
  }

  private classMembers(className: string, classId: string, body: SyntaxNode): void {
    for (const m of body.namedChildren) {
      let nameNode: SyntaxNode | null = null;
      let abstract = false;
      let accessor: 'get' | 'set' | null = null;
      let isStatic = false;
      let fnLike: SyntaxNode = m;

      if (m.type === 'method_definition' || m.type === 'method_signature') {
        nameNode = m.childForFieldName('name');
        for (const c of m.children) {
          if (nameNode && c.id === nameNode.id) break;
          if (c.type === 'get' || c.type === 'set') accessor = c.type;
          if (c.type === 'static') isStatic = true;
        }
      } else if (m.type === 'abstract_method_signature') {
        nameNode = m.childForFieldName('name');
        abstract = true;
      } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
        const v = m.childForFieldName('value');
        if (!v || !FUNCTION_VALUE_TYPES.has(v.type)) continue;
        nameNode = m.childForFieldName('name') ?? m.childForFieldName('property');
        fnLike = v;
      } else {
        continue;
      }

      const key = keyName(nameNode);
      if (!key) continue;
      const symbol = `${className}.${key}`;
      const id = makeNodeId('method', this.filePath, symbol);
      this.ownerByNode.set(m.id, id);
      const mods = memberModifiers(m, nameNode);
      if (fnLike !== m && fnParts(fnLike).async) mods.push('async');
      if (fnLike !== m && fnParts(fnLike).gen) mods.push('generator');
      let signature: string;
      if (fnLike === m) {
        signature = methodSignature(key, m, mods);
      } else {
        const words = mods.filter((x) => x !== 'async' && x !== 'generator');
        signature = arrowSignature(`${words.length ? words.join(' ') + ' ' : ''}${key}`, fnLike);
      }
      // leading decorators are siblings in the class body; they belong to the member
      let startNode: SyntaxNode | undefined;
      for (
        let p = m.previousNamedSibling;
        p && p.type === 'decorator';
        p = p.previousNamedSibling
      ) {
        startNode = p;
      }
      const deco: Decor = { decl: m, signature, modifiers: mods, exported: false, startNode };
      const existing = this.nodeById.get(id);
      if (existing) {
        this.decorate(existing, deco);
        // getter + setter share one node; overload signatures collapse
        if (accessor) {
          const meta = JSON.parse(existing.meta) as Record<string, unknown>;
          if (meta.accessor && meta.accessor !== accessor) {
            meta.accessor = 'both';
            existing.meta = JSON.stringify(meta);
          }
        }
        continue;
      }
      const meta: Record<string, unknown> = {};
      if (accessor) meta.accessor = accessor;
      if (abstract) meta.abstract = true;
      if (isStatic) meta.static = true;
      const created = this.addNode({
        id,
        kind: 'method',
        name: symbol,
        filePath: this.filePath,
        description: `Method ${symbol} in ${path.basename(this.filePath)}`,
        isExternal: false,
        language: this.language,
        meta: JSON.stringify(meta),
      });
      this.decorate(created.node, deco);
      this.addEdge(classId, 'contains', id, `${className} defines ${key}`);
    }
  }

  // ── interfaces, types, modules ───────────────────────────────────────────

  private interfaceDecl(n: SyntaxNode, exported: boolean): void {
    const name = n.childForFieldName('name')?.text;
    if (!name) return;
    const heritage: Heritage = { extends: [], implements: [] };
    for (const c of n.namedChildren) {
      if (c.type !== 'extends_type_clause') continue;
      for (const t of c.namedChildren) heritage.extends.push(this.typeName(t));
    }
    const node = this.symbol(
      'interface',
      name,
      exported,
      `Interface ${name}`,
      { heritage },
      'interface',
      {
        decl: n,
        signature: oneLine(
          [
            `interface ${name}`,
            n.childForFieldName('type_parameters')?.text ?? '',
            ' ',
            n.namedChildren.find((c) => c.type === 'extends_type_clause')?.text ?? '',
          ].join(''),
        ),
        modifiers: [],
      },
    );
    this.pending.push({ fromId: node.id, extendsKind: 'interface', heritage });
  }

  private typeDecl(n: SyntaxNode, exported: boolean, subkind: 'alias' | 'enum'): void {
    const name = n.childForFieldName('name')?.text;
    if (!name) return;
    const label = subkind === 'enum' ? 'Enum' : 'Type';
    let signature: string;
    if (subkind === 'enum') {
      const isConst = n.children.some((c) => c.type === 'const');
      signature = oneLine(
        `${isConst ? 'const ' : ''}enum ${name} ${n.childForFieldName('body')?.text ?? ''}`,
      );
    } else {
      const tp = n.childForFieldName('type_parameters')?.text ?? '';
      const rhs = oneLine(n.childForFieldName('value')?.text ?? '', 120);
      signature = oneLine(`type ${name}${tp} = ${rhs}`);
    }
    this.symbol('type', name, exported, `${label} ${name}`, { subkind }, subkind, {
      decl: n,
      signature,
      modifiers: [],
    });
  }

  private moduleDecl(n: SyntaxNode, exported: boolean): void {
    const nameNode = n.childForFieldName('name');
    if (!nameNode) return;
    const name =
      nameNode.type === 'string' ? nameNode.text.replace(/^['"`]|['"`]$/g, '') : nameNode.text;
    if (!name) return;
    const kw = n.type === 'module' ? 'module' : 'namespace';
    this.symbol('module', name, exported, `Module ${name}`, {}, 'module', {
      decl: n,
      signature: nameNode.type === 'string' ? `${kw} "${name}"` : `${kw} ${name}`,
      modifiers: [],
    });
  }
}
