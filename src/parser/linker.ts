/**
 * Linker: resolves SymbolRefs (calls, cross-file inherits/implements) produced
 * by adapters into graph edges, then prunes dangling edges.
 *
 * Resolution is heuristic (no type checker). See docs/languages/typescript.md ("Calls").
 */

import type { GraphDb } from '../graph/db.js';
import type { GraphNode, GraphEdge } from '../types.js';
import type { SymbolRef } from './adapter.js';
import { makeNodeId, makeEdgeId } from './utils.js';
import { debug } from '../util/log.js';

export interface LinkStats {
  resolved: number;
  unresolved: number;
  pruned: number;
}

interface ImportBinding {
  source: string;
  isExternal: boolean;
  local: string;
  imported: string;
}
interface ReexportBinding {
  source: string;
  isExternal: boolean;
  imported: string;
  exported: string;
}

interface FileInfo {
  nodes: GraphNode[];
  byId: Map<string, GraphNode>;
  /** symbol (the part after `#`) -> node, for non-file nodes */
  symbols: Map<string, GraphNode>;
  imports: ImportBinding[];
  reexports: ReexportBinding[];
  /** ids exported by this file (from `exports` edges) */
  exportedIds: Set<string>;
}

interface Located {
  file: string;
  symbol: string;
}

const MAX_SAMPLE = 20;
const MAX_CHAIN = 5;
const CALLABLE = new Set(['function', 'class']);

function parseMeta(meta: string): Record<string, unknown> {
  try {
    const v = JSON.parse(meta) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch (err) {
    debug('linker', 'bad node meta JSON', err);
    return {};
  }
}

export class Linker {
  private cache = new Map<string, FileInfo>();

  constructor(private readonly db: GraphDb) {}

  /** Resolve refs produced by the files just parsed, write edges, prune dangling. */
  link(batch: Array<{ filePath: string; refs: SymbolRef[] }>): LinkStats {
    this.cache = new Map();
    const stats: LinkStats = { resolved: 0, unresolved: 0, pruned: 0 };
    this.db.transaction(() => {
      const now = Date.now();
      const written = new Set<string>();
      for (const { filePath, refs } of batch) {
        const info = this.info(filePath);
        const unresolved = new Map<string, string[]>(); // fromId -> names
        for (const ref of refs) {
          const hit = this.resolve(ref, filePath, info);
          if (!hit) {
            if (ref.kind === 'calls') {
              stats.unresolved++;
              const list = unresolved.get(ref.fromId) ?? [];
              list.push(ref.qualifier ? `${ref.qualifier}.${ref.name}` : ref.name);
              unresolved.set(ref.fromId, list);
            }
            continue;
          }
          const edgeId = makeEdgeId(ref.fromId, ref.kind, hit.node.id);
          if (written.has(edgeId)) continue;
          written.add(edgeId);
          const edge: GraphEdge = {
            id: edgeId,
            fromId: ref.fromId,
            toId: hit.node.id,
            kind: ref.kind,
            reason: hit.reason,
            updatedAt: now,
          };
          this.db.upsertEdge(edge);
          stats.resolved++;
        }
        for (const [fromId, names] of unresolved) {
          const node = info.byId.get(fromId);
          if (!node) continue;
          const meta = parseMeta(node.meta);
          meta['unresolvedCalls'] = names.length;
          meta['unresolvedSample'] = names.slice(0, MAX_SAMPLE);
          node.meta = JSON.stringify(meta);
          this.db.upsertNode(node);
        }
      }
      stats.pruned = this.db.deleteDanglingEdges();
    });
    return stats;
  }

  // ── file info cache ──────────────────────────────────────────────────────

  private info(filePath: string): FileInfo {
    const cached = this.cache.get(filePath);
    if (cached) return cached;
    const nodes = this.db.getNodesByFile(filePath);
    const byId = new Map<string, GraphNode>();
    const symbols = new Map<string, GraphNode>();
    let imports: ImportBinding[] = [];
    let reexports: ReexportBinding[] = [];
    for (const n of nodes) {
      byId.set(n.id, n);
      if (n.kind === 'file') {
        const meta = parseMeta(n.meta);
        if (Array.isArray(meta['imports'])) imports = meta['imports'] as ImportBinding[];
        if (Array.isArray(meta['reexports'])) reexports = meta['reexports'] as ReexportBinding[];
      } else if (n.kind !== 'external_dep') {
        const prefix = `${n.kind}:${filePath}#`;
        if (n.id.startsWith(prefix)) symbols.set(n.id.slice(prefix.length), n);
      }
    }
    const exportedIds = new Set<string>();
    if (nodes.length > 0) {
      for (const e of this.db.getEdgesFromByKind(makeNodeId('file', filePath), 'exports')) {
        exportedIds.add(e.toId);
      }
    }
    const info: FileInfo = { nodes, byId, symbols, imports, reexports, exportedIds };
    this.cache.set(filePath, info);
    return info;
  }

  // ── export location ──────────────────────────────────────────────────────

  private hasSymbol(info: FileInfo, name: string): boolean {
    if (info.symbols.has(name)) return true;
    const prefix = `${name}.`;
    for (const key of info.symbols.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  /** Find where `name` (as exported by `file`) actually lives. Follows re-exports one level. */
  private locate(file: string, name: string, hint: string, depth = 0): Located | null {
    const info = this.info(file);
    if (name === 'default') {
      for (const [symbol, n] of info.symbols) {
        if (
          !symbol.includes('.') &&
          CALLABLE.has(n.kind) &&
          parseMeta(n.meta)['isDefault'] === true
        ) {
          return { file, symbol };
        }
      }
      if (info.symbols.has('default')) return { file, symbol: 'default' };
      if (hint && this.hasSymbol(info, hint)) return { file, symbol: hint };
      const exported = [...info.exportedIds]
        .map((id) => info.nodes.find((n) => n.id === id))
        .filter((n): n is GraphNode => !!n && (n.kind === 'function' || n.kind === 'class'));
      if (exported.length === 1) {
        const prefix = `${exported[0].kind}:${file}#`;
        return { file, symbol: exported[0].id.slice(prefix.length) };
      }
    } else if (this.hasSymbol(info, name)) {
      return { file, symbol: name };
    }
    if (depth >= 1) return null;
    for (const r of info.reexports) {
      if (r.isExternal) continue;
      if (r.imported === '*' && r.exported === '*') {
        const hit = this.locate(r.source, name, hint, depth + 1);
        if (hit) return hit;
      } else if (r.exported === name && r.imported !== '*') {
        const hit = this.locate(r.source, r.imported, hint, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  private node(loc: Located | null, symbol?: string): GraphNode | null {
    if (!loc) return null;
    return this.info(loc.file).symbols.get(symbol ?? loc.symbol) ?? null;
  }

  // ── resolution ───────────────────────────────────────────────────────────

  private binding(info: FileInfo, local: string): ImportBinding | undefined {
    return info.imports.find((b) => b.local === local && b.local !== '');
  }

  private resolve(
    ref: SymbolRef,
    filePath: string,
    info: FileInfo,
  ): { node: GraphNode; reason: string } | null {
    if (ref.kind !== 'calls') return this.resolveHeritage(ref, filePath, info);

    const verb = ref.isNew ? 'new' : 'call';
    const q = ref.qualifier;

    // 1. bare call: same file, then imported binding
    if (!q) {
      const local = this.pickCallable(info.symbols.get(ref.name), ref.isNew);
      if (local) return { node: local, reason: verb };
      const b = this.binding(info, ref.name);
      if (b && !b.isExternal && b.imported !== '*') {
        const loc = this.locate(b.source, b.imported, b.local);
        const n = this.pickCallable(this.node(loc) ?? undefined, ref.isNew);
        if (n) return { node: n, reason: `${verb} via ${b.local}` };
      }
      return null;
    }

    // 2. this / super
    if (q === 'this' || q === 'super') {
      return this.resolveThis(ref, filePath, info, q === 'super');
    }

    // 3. identifier qualifier: namespace import, imported class/object, same-file class/object
    if (!q.includes('.')) {
      const b = this.binding(info, q);
      if (b) {
        if (b.isExternal) return null;
        if (b.imported === '*') {
          const loc = this.locate(b.source, ref.name, '');
          const n = this.pickCallable(this.node(loc) ?? undefined, ref.isNew);
          return n ? { node: n, reason: `${verb} via ${q}` } : null;
        }
        const loc = this.locate(b.source, b.imported, b.local);
        const n = this.node(loc, loc ? `${loc.symbol}.${ref.name}` : undefined);
        return n ? { node: n, reason: `${verb} via ${q}` } : null;
      }
      const n = info.symbols.get(`${q}.${ref.name}`);
      return n ? { node: n, reason: verb } : null;
    }

    // 4. dotted qualifier: only `ns.Class.method()` on a namespace import
    const parts = q.split('.');
    if (parts.length === 2) {
      const b = this.binding(info, parts[0]);
      if (b && !b.isExternal && b.imported === '*') {
        const loc = this.locate(b.source, parts[1], '');
        const n = this.node(loc, loc ? `${loc.symbol}.${ref.name}` : undefined);
        if (n) return { node: n, reason: `${verb} via ${parts[0]}` };
      }
    }
    return null;
  }

  private pickCallable(n: GraphNode | undefined, isNew?: boolean): GraphNode | null {
    if (!n || !CALLABLE.has(n.kind)) return null;
    if (isNew && n.kind !== 'class') return null;
    return n;
  }

  /** `this.m()` / `super.m()`: own class method, then up the resolved parent chain. */
  private resolveThis(
    ref: SymbolRef,
    filePath: string,
    info: FileInfo,
    isSuper: boolean,
  ): { node: GraphNode; reason: string } | null {
    const caller = info.byId.get(ref.fromId);
    if (!caller) return null;
    const prefix = `${caller.kind}:${filePath}#`;
    if (!caller.id.startsWith(prefix)) return null;
    const sym = caller.id.slice(prefix.length);
    let className: string;
    if (caller.kind === 'method') {
      const dot = sym.indexOf('.');
      if (dot < 0) return null;
      className = sym.slice(0, dot);
    } else if (caller.kind === 'class') {
      className = sym;
    } else {
      return null;
    }

    let curFile = filePath;
    let curClass = className;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const cinfo = this.info(curFile);
      if (!(isSuper && i === 0)) {
        const m = cinfo.symbols.get(`${curClass}.${ref.name}`);
        if (m) return { node: m, reason: isSuper ? 'call via super' : 'call via this' };
      }
      const cls = cinfo.symbols.get(curClass);
      if (!cls || cls.kind !== 'class') return null;
      const parent = this.parentOf(cls, curFile, cinfo);
      if (!parent) return null;
      curFile = parent.file;
      curClass = parent.symbol;
    }
    return null;
  }

  private parentOf(cls: GraphNode, file: string, info: FileInfo): Located | null {
    const heritage = parseMeta(cls.meta)['heritage'] as { extends?: string[] } | undefined;
    const parent = heritage?.extends?.[0];
    if (!parent) return null;
    return this.locateTypeName(parent, file, info, 'class');
  }

  /** Resolve a (possibly dotted) type name used in `extends`/`implements`. */
  private locateTypeName(
    name: string,
    file: string,
    info: FileInfo,
    want: 'class' | 'interface' | 'any',
  ): Located | null {
    const ok = (n: GraphNode | null): boolean =>
      !!n && (want === 'any' ? n.kind === 'class' || n.kind === 'interface' : n.kind === want);
    const dot = name.lastIndexOf('.');
    if (dot < 0) {
      const same = info.symbols.get(name);
      if (same && ok(same)) return { file, symbol: name };
      const b = this.binding(info, name);
      if (b && !b.isExternal && b.imported !== '*') {
        const loc = this.locate(b.source, b.imported, b.local);
        if (loc && ok(this.node(loc))) return loc;
      }
      return null;
    }
    const ns = name.slice(0, dot);
    const bare = name.slice(dot + 1);
    const b = this.binding(info, ns);
    if (b && !b.isExternal && b.imported === '*') {
      const loc = this.locate(b.source, bare, '');
      if (loc && ok(this.node(loc))) return loc;
    }
    return null;
  }

  private resolveHeritage(
    ref: SymbolRef,
    filePath: string,
    info: FileInfo,
  ): { node: GraphNode; reason: string } | null {
    const full = ref.qualifier ? `${ref.qualifier}.${ref.name}` : ref.name;
    const from = info.byId.get(ref.fromId);
    // inherits: class->class or interface->interface; implements: class->interface
    const want =
      ref.kind === 'implements' ? 'interface' : from?.kind === 'interface' ? 'interface' : 'class';
    const loc = this.locateTypeName(full, filePath, info, want);
    const node = this.node(loc);
    if (!node || node.id === ref.fromId) return null;
    return { node, reason: `${ref.kind === 'implements' ? 'implements' : 'extends'} ${full}` };
  }
}
