/**
 * Auto-freshness for MCP read tools.
 *
 * Before a read tool runs we cheaply check whether files changed since the last
 * parse and re-parse them, so answers never come from a stale graph.
 *
 * Cost model:
 *   - one stat() per known file (mtime compare against files.mtime)
 *   - one `git ls-files --cached --others --exclude-standard` (when .git exists)
 *     to discover new files; without git, new files are not discovered
 *   - re-parse only the changed / new files (content-hash skips unchanged ones)
 *
 * Throttled to once per 2 s per root. Opt out with CGB_NO_AUTOREFRESH=1.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { GraphDb } from '../graph/db.js';
import { debug, warnOnce } from '../util/log.js';

export interface FreshnessOptions {
  /** Max changed/new files to re-parse in one call (default 200). */
  maxFiles?: number;
  /** Time budget in ms (default 1500). */
  budgetMs?: number;
  /** Minimum ms between checks for one root (default 2000). */
  throttleMs?: number;
}

export interface FreshnessResult {
  reparsed: number;
  removed: number;
  /** True when the check was cut short (budget or maxFiles); the graph may be stale. */
  skipped: boolean;
}

const SOURCE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.cs',
  '.py',
  '.go',
  '.java',
  '.rs',
  '.rb',
  '.php',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.hh',
  '.kt',
  '.kts',
]);

/** Mirrors the Parser's DEFAULT_IGNORES for discovery. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'bin',
  'obj',
  '.git',
  '.cgb',
  'vendor',
  '__pycache__',
  'coverage',
]);

const CHUNK = 20;
const lastCheck = new Map<string, number>();

/** Forget throttle state (tests). */
export function resetFreshnessThrottle(): void {
  lastCheck.clear();
}

const keyOf = (p: string): string =>
  process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);

function isCandidate(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (!SOURCE_EXTS.has(path.extname(lower))) return false;
  if (lower.endsWith('.d.ts') || lower.endsWith('.min.js')) return false;
  return !relPath.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));
}

/** Non-ignored tracked + untracked source files, absolute. null when git is unavailable. */
function gitFiles(root: string): string[] | null {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      },
    );
    return out
      .split('\0')
      .filter((f) => f && isCandidate(f))
      .map((f) => path.resolve(root, f));
  } catch (e) {
    warnOnce('freshness', 'git', 'git ls-files failed; new files will not be discovered', e);
    return null;
  }
}

export async function ensureFresh(
  root: string,
  db: GraphDb,
  opts: FreshnessOptions = {},
): Promise<FreshnessResult> {
  const none: FreshnessResult = { reparsed: 0, removed: 0, skipped: false };
  if (process.env.CGB_NO_AUTOREFRESH === '1') return none;

  const { maxFiles = 200, budgetMs = 1500, throttleMs = 2000 } = opts;
  const rootKey = keyOf(path.resolve(root));
  const prev = lastCheck.get(rootKey);
  if (prev !== undefined && Date.now() - prev < throttleMs) return none;

  const t0 = performance.now();
  const overBudget = (): boolean => performance.now() - t0 >= budgetMs;

  // 1. Known files: deleted or mtime changed
  const known = db.getAllFiles();
  const knownKeys = new Set<string>();
  const deleted: string[] = [];
  const changed: string[] = [];
  for (const f of known) {
    knownKeys.add(keyOf(f.filePath));
    try {
      const st = fs.statSync(f.filePath);
      if (st.mtimeMs !== f.mtime) changed.push(f.filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') deleted.push(f.filePath);
      else debug('freshness', `stat failed for ${f.filePath}`, e);
    }
  }

  // 2. New files (git only)
  const listed = gitFiles(root);
  if (listed) {
    for (const abs of listed) {
      if (!knownKeys.has(keyOf(abs)) && fs.existsSync(abs)) changed.push(abs);
    }
  }

  lastCheck.set(rootKey, Date.now());

  const total = deleted.length + changed.length;
  if (total === 0) return none;
  if (total > maxFiles || overBudget()) return { reparsed: 0, removed: 0, skipped: true };

  // 3. Re-parse in chunks, honouring the budget between chunks
  const { Parser } = await import('../parser/index.js');
  const parser = new Parser(db, root);
  let removed = 0;
  let reparsed = 0;
  let skipped = false;

  const run = async (files: string[], isDelete: boolean): Promise<void> => {
    for (let i = 0; i < files.length; i += CHUNK) {
      if (overBudget()) {
        skipped = true;
        return;
      }
      const chunk = files.slice(i, i + CHUNK);
      const res = await parser.parseFiles(chunk);
      if (isDelete) removed += chunk.length;
      else reparsed += res.parsed;
      if (res.errors.length > 0) debug('freshness', `${res.errors.length} file(s) failed to parse`);
    }
  };

  await run(deleted, true);
  if (!skipped) await run(changed, false);
  debug(
    'freshness',
    `reparsed ${reparsed}, removed ${removed}, skipped=${skipped} in ${Math.round(performance.now() - t0)}ms`,
  );
  return { reparsed, removed, skipped };
}
