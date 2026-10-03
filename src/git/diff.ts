/**
 * Git diff integration.
 * Shells out to `git` to retrieve changed files (between two refs and/or in the
 * working tree), including per-file line-change statistics.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { debug } from '../util/log.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitChange {
  /** Absolute path to the file */
  filePath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Previous path — only set when status is 'renamed' */
  oldPath?: string;
  linesAdded: number;
  linesRemoved: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REF_RE = /^[A-Za-z0-9._/~^@{}-]+$/;

/** Throws if `ref` is not a safe git ref (no leading '-', restricted charset). */
export function validateRef(ref: string): string {
  if (typeof ref !== 'string' || ref.startsWith('-') || !REF_RE.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
  return ref;
}

function run(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    debug('git', `git ${args.join(' ')} failed`, err);
    return '';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if `root` is inside a git repository.
 */
export function isGitRepo(root: string): boolean {
  try {
    const result = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result === 'true';
  } catch (err) {
    debug('git', 'isGitRepo check failed', err);
    return false;
  }
}

/**
 * Returns the name of the default branch (main or master fallback).
 */
export function getDefaultBranch(root: string): string {
  const fromRemote = run(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], root);
  if (fromRemote) {
    // e.g. "origin/main" → "main"
    return fromRemote.split('/').pop() ?? 'main';
  }
  // Fallback: check if 'main' exists, else 'master'
  const branches = run(['branch', '--list', 'main', 'master'], root);
  if (branches.includes('main')) return 'main';
  return 'master';
}

/**
 * Returns the git repo root for a given directory, spelled relative to `root`.
 *
 * `--show-toplevel` returns git's canonical path, which can differ from the caller's
 * spelling (Windows 8.3 short names like `RUNNER~1`, symlinked dirs like macOS `/var`).
 * Resolving `--show-cdup` against `root` keeps paths comparable with ones derived from `root`.
 */
export function getRepoRoot(root: string): string {
  return path.resolve(root, run(['rev-parse', '--show-cdup'], root));
}

/**
 * Parse paired `--name-status` / `--numstat` output into GitChange entries.
 */
function parseDiff(nameStatusOutput: string, numstatOutput: string, repoRoot: string): GitChange[] {
  // filePath (relative) → { linesAdded, linesRemoved }
  const lineStats = new Map<string, { linesAdded: number; linesRemoved: number }>();
  for (const line of numstatOutput.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parseInt(parts[0], 10);
    const removed = parseInt(parts[1], 10);
    // For binary files git prints '-' instead of a number
    const relPath = parts[2];
    // Handle rename format "old => new" in numstat (rare in --numstat but possible)
    const normalized = relPath.includes('{') ? resolveRenamePath(relPath) : relPath;
    lineStats.set(normalized, {
      linesAdded: isNaN(added) ? 0 : added,
      linesRemoved: isNaN(removed) ? 0 : removed,
    });
  }

  const changes: GitChange[] = [];
  for (const line of nameStatusOutput.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (!parts.length) continue;

    const statusCode = parts[0];
    let status: GitChange['status'];
    let relPath: string;
    let oldRelPath: string | undefined;

    if (statusCode.startsWith('R')) {
      // Rename: R100\told/path\tnew/path
      status = 'renamed';
      oldRelPath = parts[1];
      relPath = parts[2];
    } else if (statusCode === 'A') {
      status = 'added';
      relPath = parts[1];
    } else if (statusCode === 'D') {
      status = 'deleted';
      relPath = parts[1];
    } else {
      status = 'modified';
      relPath = parts[1];
    }

    if (!relPath) continue;

    const stats = lineStats.get(relPath) ?? { linesAdded: 0, linesRemoved: 0 };
    const change: GitChange = {
      filePath: path.resolve(repoRoot, relPath),
      status,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
    };
    if (oldRelPath) change.oldPath = path.resolve(repoRoot, oldRelPath);
    changes.push(change);
  }
  return changes;
}

/** Untracked (not ignored) files, treated as fully added. */
function getUntrackedChanges(repoRoot: string): GitChange[] {
  const out = run(['ls-files', '-o', '--exclude-standard'], repoRoot);
  const changes: GitChange[] = [];
  for (const relPath of out.split('\n').filter(Boolean)) {
    const absPath = path.resolve(repoRoot, relPath);
    let linesAdded = 0;
    try {
      const stat = fs.statSync(absPath);
      if (stat.isFile() && stat.size < 2 * 1024 * 1024) {
        const content = fs.readFileSync(absPath, 'utf8');
        linesAdded =
          content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      }
    } catch (err) {
      debug('git', `could not read untracked file ${absPath}`, err);
    }
    changes.push({ filePath: absPath, status: 'added', linesAdded, linesRemoved: 0 });
  }
  return changes;
}

/**
 * Retrieve changed files.
 *
 * - No `base`: diff the working tree against `HEAD` (staged + unstaged) plus
 *   untracked files (treated as fully added).
 * - With `base`: `base..HEAD` (committed changes), additionally merged with
 *   working-tree changes unless `includeWorkingTree` is false.
 *
 * Parses both `--name-status` (for add/modify/delete/rename) and `--numstat`
 * (for line counts) and merges them by file path.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async kept for API/signature compatibility
export async function getGitChanges(
  root: string,
  base?: string,
  includeWorkingTree = true,
): Promise<GitChange[]> {
  if (!isGitRepo(root)) {
    throw new Error(`Not a git repository: ${root}`);
  }

  if (base !== undefined) validateRef(base);
  const repoRoot = getRepoRoot(root);

  let changes: GitChange[] = [];
  if (base !== undefined) {
    const range = `${base}..HEAD`;
    changes = parseDiff(
      run(['diff', '--name-status', range], repoRoot),
      run(['diff', '--numstat', range], repoRoot),
      repoRoot,
    );
  }

  if (base === undefined || includeWorkingTree) {
    const working = [
      ...parseDiff(
        run(['diff', '--name-status', 'HEAD'], repoRoot),
        run(['diff', '--numstat', 'HEAD'], repoRoot),
        repoRoot,
      ),
      ...getUntrackedChanges(repoRoot),
    ];

    const byPath = new Map(changes.map((c) => [c.filePath, c] as const));
    for (const w of working) {
      const existing = byPath.get(w.filePath);
      if (!existing) {
        changes.push(w);
        byPath.set(w.filePath, w);
        continue;
      }
      // Same file changed in a commit and in the working tree: combine.
      existing.linesAdded += w.linesAdded;
      existing.linesRemoved += w.linesRemoved;
      if (w.status === 'deleted') existing.status = 'deleted';
    }
  }

  return changes.filter((c) => c.filePath && fs.existsSync(path.dirname(c.filePath)));
}

/**
 * Resolve git numstat rename format like `src/{old => new}/file.ts` → `src/new/file.ts`
 */
function resolveRenamePath(relPath: string): string {
  return relPath.replace(/\{[^}]*=> ([^}]*)\}/, '$1').replace(/\/+/g, '/');
}
