/**
 * Git diff integration.
 * Shells out to `git` to retrieve changed files between two refs,
 * including per-file line-change statistics.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if `root` is inside a git repository.
 */
export function isGitRepo(root: string): boolean {
  try {
    const result = execSync('git rev-parse --is-inside-work-tree', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

/**
 * Returns the name of the default branch (main or master fallback).
 */
export function getDefaultBranch(root: string): string {
  const fromRemote = run('git symbolic-ref refs/remotes/origin/HEAD --short', root);
  if (fromRemote) {
    // e.g. "origin/main" → "main"
    return fromRemote.split('/').pop() ?? 'main';
  }
  // Fallback: check if 'main' exists, else 'master'
  const branches = run('git branch --list main master', root);
  if (branches.includes('main')) return 'main';
  return 'master';
}

/**
 * Returns the git repo root for a given directory.
 */
export function getRepoRoot(root: string): string {
  return run('git rev-parse --show-toplevel', root) || root;
}

/**
 * Retrieve all files changed between `base` and HEAD.
 * `base` defaults to `HEAD~1`.
 *
 * Parses both `--name-status` (for add/modify/delete/rename) and
 * `--numstat` (for line counts) and merges them by file path.
 */
export async function getGitChanges(root: string, base = 'HEAD~1'): Promise<GitChange[]> {
  if (!isGitRepo(root)) {
    throw new Error(`Not a git repository: ${root}`);
  }

  const repoRoot = getRepoRoot(root);

  // ── Name/status: A, M, D, R<score> ────────────────────────────────────────
  const nameStatusOutput = run(`git diff --name-status ${base}..HEAD`, repoRoot);

  // ── Numstat: linesAdded linesRemoved filename ──────────────────────────────
  const numstatOutput = run(`git diff --numstat ${base}..HEAD`, repoRoot);

  // Build a map of filePath → { linesAdded, linesRemoved }
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

  // Build change list from name-status
  const changes: GitChange[] = [];
  const lines = nameStatusOutput.split('\n').filter(Boolean);

  for (const line of lines) {
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

    const absPath = path.resolve(repoRoot, relPath);
    const stats = lineStats.get(relPath) ?? { linesAdded: 0, linesRemoved: 0 };

    const change: GitChange = {
      filePath: absPath,
      status,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
    };

    if (oldRelPath) {
      change.oldPath = path.resolve(repoRoot, oldRelPath);
    }

    changes.push(change);
  }

  // Also include untracked staged files (git diff --cached if base is "HEAD~1")
  // For simplicity, also check working-tree changes to staged files
  if (base === 'HEAD~1' || base === 'HEAD') {
    const stagedOutput = run('git diff --cached --name-status', repoRoot);
    const stagedNumstat = run('git diff --cached --numstat', repoRoot);

    const stagedStats = new Map<string, { linesAdded: number; linesRemoved: number }>();
    for (const line of stagedNumstat.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      stagedStats.set(parts[2], {
        linesAdded: parseInt(parts[0], 10) || 0,
        linesRemoved: parseInt(parts[1], 10) || 0,
      });
    }

    const existingPaths = new Set(changes.map((c) => c.filePath));
    for (const line of stagedOutput.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (!parts.length) continue;
      const relPath = parts[1];
      if (!relPath) continue;
      const absPath = path.resolve(repoRoot, relPath);
      if (existingPaths.has(absPath)) continue; // already captured

      const statusCode = parts[0];
      let status: GitChange['status'] = 'modified';
      if (statusCode === 'A') status = 'added';
      else if (statusCode === 'D') status = 'deleted';
      else if (statusCode.startsWith('R')) status = 'renamed';

      const stats = stagedStats.get(relPath) ?? { linesAdded: 0, linesRemoved: 0 };
      changes.push({ filePath: absPath, status, ...stats });
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
