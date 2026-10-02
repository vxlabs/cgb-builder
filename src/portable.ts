/**
 * Helpers for producing root-independent, deterministic output.
 */

import * as path from 'path';

const IS_WIN = process.platform === 'win32';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deep-copy `value`, stripping any `<root>/` prefix found inside strings so absolute paths
 * become project-root-relative. On Windows the remainder of each such path is converted to
 * `/` separators (and the root matches case-insensitively, with either separator), so the
 * output is identical across operating systems. Object key order is preserved.
 */
export function relativizePaths<T>(value: T, root: string): T {
  const resolved = path.resolve(root);
  const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  let strip: (s: string) => string;
  if (IS_WIN) {
    const re = new RegExp(
      escapeRegExp(prefix).replace(/\\\\/g, '[\\\\/]') + '([^\\s"\'`<>|*?:;,()\\[\\]{}]*)',
      'gi',
    );
    strip = (s) => s.replace(re, (_m, rest: string) => rest.replace(/\\/g, '/'));
  } else {
    strip = (s) => s.split(prefix).join('');
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return strip(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
