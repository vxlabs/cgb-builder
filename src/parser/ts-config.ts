/**
 * tsconfig.json / jsconfig.json discovery for TS/JS import resolution.
 *
 * Only `compilerOptions.baseUrl` and `compilerOptions.paths` are read. Relative
 * `extends` chains are followed; package `extends` (e.g. `@tsconfig/node20`) is
 * ignored. JSONC (comments, trailing commas) is tolerated.
 */

import * as fs from 'fs';
import * as path from 'path';
import { debug } from '../util/log.js';

export interface TsPathConfig {
  /** Directory of the nearest tsconfig/jsconfig that was found. */
  configDir: string;
  /** Absolute baseUrl, when set anywhere in the extends chain. */
  baseUrl?: string;
  /** `paths` patterns -> targets (targets relative to baseUrl, else to configDir or already absolute). */
  paths: Record<string, string[]>;
}

const dirCache = new Map<string, TsPathConfig | null>();

export function clearTsConfigCache(): void {
  dirCache.clear();
}

/** Remove comments and trailing commas, leaving string contents untouched. */
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface RawConfig {
  extends?: string | string[];
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

function readJsonc(file: string): RawConfig | null {
  try {
    const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(stripJsonc(text));
    return parsed && typeof parsed === 'object' ? (parsed as RawConfig) : null;
  } catch (err) {
    debug('ts-config', `cannot parse ${file}`, err);
    return null;
  }
}

interface Resolved {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsDir?: string;
}

function loadChain(file: string, seen: Set<string>): Resolved {
  if (seen.has(file)) return {};
  seen.add(file);
  const raw = readJsonc(file);
  if (!raw) return {};
  const dir = path.dirname(file);

  let result: Resolved = {};
  const parents =
    raw.extends === undefined ? [] : Array.isArray(raw.extends) ? raw.extends : [raw.extends];
  for (const ext of parents) {
    if (typeof ext !== 'string') continue;
    if (!ext.startsWith('.') && !path.isAbsolute(ext)) {
      debug('ts-config', `ignoring package extends "${ext}" in ${file}`);
      continue;
    }
    let target = path.resolve(dir, ext);
    if (!fs.existsSync(target) && !target.endsWith('.json')) target += '.json';
    if (!fs.existsSync(target)) {
      debug('ts-config', `extends target not found: ${target}`);
      continue;
    }
    result = { ...result, ...stripUndefined(loadChain(target, seen)) };
  }

  const co = raw.compilerOptions;
  if (co && typeof co.baseUrl === 'string') result.baseUrl = path.resolve(dir, co.baseUrl);
  if (co && co.paths && typeof co.paths === 'object') {
    result.paths = co.paths;
    result.pathsDir = dir;
  }
  return result;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Nearest tsconfig.json / jsconfig.json walking up from `fromDir`; null if none. */
export function findTsPathConfig(fromDir: string): TsPathConfig | null {
  const start = path.resolve(fromDir);
  const cached = dirCache.get(start);
  if (cached !== undefined) return cached;

  let result: TsPathConfig | null = null;
  let dir = start;
  for (;;) {
    const hit = ['tsconfig.json', 'jsconfig.json']
      .map((f) => path.join(dir, f))
      .find((f) => fs.existsSync(f));
    if (hit) {
      const r = loadChain(hit, new Set());
      const paths: Record<string, string[]> = {};
      for (const [pattern, targets] of Object.entries(r.paths ?? {})) {
        if (!Array.isArray(targets)) continue;
        const list = targets.filter((t): t is string => typeof t === 'string');
        // Without a baseUrl, targets resolve against the config that declared them.
        paths[pattern] =
          r.baseUrl || !r.pathsDir ? list : list.map((t) => path.resolve(r.pathsDir as string, t));
      }
      result = { configDir: dir, baseUrl: r.baseUrl, paths };
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Cache the answer for every directory visited on the way up as well.
  dirCache.set(start, result);
  return result;
}

/** Apply `paths` (single `*` wildcard, most specific pattern first) -> candidate absolute base paths. */
export function expandPathAlias(cfg: TsPathConfig, specifier: string): string[] {
  const root = cfg.baseUrl ?? cfg.configDir;
  const matches: Array<{ pattern: string; capture: string; prefixLen: number }> = [];
  for (const pattern of Object.keys(cfg.paths)) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern === specifier) matches.push({ pattern, capture: '', prefixLen: Infinity });
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      matches.push({
        pattern,
        capture: specifier.slice(prefix.length, specifier.length - suffix.length),
        prefixLen: prefix.length,
      });
    }
  }
  if (matches.length === 0) return [];
  matches.sort((a, b) => b.prefixLen - a.prefixLen);
  const best = matches[0];
  return cfg.paths[best.pattern].map((t) => path.resolve(root, t.replace('*', best.capture)));
}
