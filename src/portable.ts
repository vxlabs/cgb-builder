/**
 * Helpers for producing root-independent, deterministic output.
 */

import * as path from 'path';

/**
 * Deep-copy `value`, replacing any `<root>/` prefix found inside strings with the empty
 * string, so absolute paths become project-root-relative. Object key order is preserved.
 */
export function relativizePaths<T>(value: T, root: string): T {
  const prefix = path.resolve(root) + path.sep;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split(prefix).join('');
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
