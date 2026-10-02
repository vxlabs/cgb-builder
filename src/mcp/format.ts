/**
 * MCP output helpers: root resolution, repo-relative paths, compact nodes,
 * pagination and result envelopes. Shared by all tool handlers.
 */

import * as path from 'path';
import type { GraphNode } from '../types.js';

export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface CompactNode {
  id: string;
  kind: string;
  name: string;
  file: string;
  lines?: string;
  sig?: string;
  doc?: string;
  exported?: boolean;
}

export interface Page<T> {
  total: number;
  returned: number;
  offset: number;
  truncated: boolean;
  items: T[];
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/** args.root ?? CGB_ROOT ?? cwd, absolute. */
export function resolveRoot(args: { root?: string } = {}): string {
  const r = args.root || process.env.CGB_ROOT || process.cwd();
  return path.resolve(r);
}

function norm(p: string): string {
  return p.split('\\').join('/');
}

/** Repo-relative path with forward slashes. Externals / outside-root paths are returned unchanged. */
export function rel(root: string, p: string): string {
  if (typeof p !== 'string' || p === '' || !path.isAbsolute(p)) return p;
  const r = path.relative(path.resolve(root), path.resolve(p));
  if (r === '') return '.';
  if (r.startsWith('..') || path.isAbsolute(r)) return p;
  return norm(r);
}

const NO_EXPAND = new Set(['external_dep']);

/**
 * Accept repo-relative node IDs such as `function:src/a.ts#foo` and expand them to
 * the absolute form stored in the graph. Absolute and unrecognised IDs pass through.
 */
export function expandId(root: string, id: string): string {
  const m = /^([a-z_]+):(.*)$/s.exec(id);
  if (!m) return id;
  const [, kind, rest] = m;
  if (NO_EXPAND.has(kind) || rest === '') return id;
  const hash = rest.indexOf('#');
  const filePart = hash >= 0 ? rest.slice(0, hash) : rest;
  const sym = hash >= 0 ? rest.slice(hash) : '';
  if (filePart === '' || path.isAbsolute(filePart)) return id;
  return `${kind}:${path.resolve(root, filePart)}${sym}`;
}

function parseMeta(meta: string | undefined): Record<string, unknown> {
  if (!meta) return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- untyped third-party/dynamic value; behaviour unchanged
    const v = JSON.parse(meta);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstDefined(...vals: unknown[]): unknown {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/** Compact node for LLM consumption. Omits undefined / empty fields. IDs stay absolute. */
export function compactNode(root: string, n: GraphNode): CompactNode {
  const x = n as unknown as Record<string, unknown>;
  const meta = parseMeta(n.meta);
  const start = firstDefined(x.startLine, x.lineStart, meta.startLine, meta.lineStart, meta.line);
  const end = firstDefined(x.endLine, x.lineEnd, meta.endLine, meta.lineEnd);
  const sig = firstDefined(x.signature, meta.signature);
  const doc = firstDefined(x.docstring, x.doc, meta.docstring, meta.doc, n.description);
  const exported = firstDefined(x.exported, x.isExported, meta.exported, meta.isExported);

  const out: CompactNode = {
    id: n.id,
    kind: n.kind,
    name: n.name,
    file: n.isExternal ? n.filePath : rel(root, n.filePath),
  };
  if (start !== undefined)
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- untyped third-party/dynamic value; behaviour unchanged
    out.lines = end !== undefined && end !== start ? `${start}-${end}` : String(start);
  if (typeof sig === 'string') out.sig = sig;
  if (typeof doc === 'string') out.doc = doc;
  if (typeof exported === 'boolean') out.exported = exported;
  return out;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Slice a list into the standard pagination envelope. limit defaults to defLimit, capped at 500. */
export function page<T>(
  items: T[],
  args: { limit?: number; offset?: number } = {},
  defLimit = DEFAULT_LIMIT,
): Page<T> {
  const limit = clampInt(args.limit, defLimit, 1, MAX_LIMIT);
  const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const slice = items.slice(offset, offset + limit);
  return {
    total: items.length,
    returned: slice.length,
    offset,
    truncated: offset + slice.length < items.length,
    items: slice,
  };
}

const PATH_KEYS = new Set([
  'filePath',
  'file',
  'files',
  'affectedFiles',
  'orphans',
  'cycles',
  'outputDir',
  'path',
]);

/**
 * Deep-copy `data`, rewriting absolute paths under path-like keys to repo-relative.
 * Node ids (any key not in PATH_KEYS) are left absolute.
 */
export function relPaths<T>(root: string, data: T): T {
  const walk = (v: unknown, inPath: boolean): unknown => {
    if (typeof v === 'string') return inPath ? rel(root, v) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, inPath));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        o[k] = walk(val, PATH_KEYS.has(k));
      }
      return o;
    }
    return v;
  };
  return walk(data, false) as T;
}

/** Success result: compact JSON, no indentation. */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** Error result (isError: true) with an optional follow-up hint. */
export function err(message: string, hint?: string): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: hint ? `${message}\nHint: ${hint}` : message }],
  };
}
