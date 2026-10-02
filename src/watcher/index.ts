/**
 * File system watcher using chokidar.
 * Watches a project root and incrementally updates the graph whenever
 * source files are added, changed, or deleted.
 */

import chokidar from 'chokidar';
import * as path from 'path';
import type { Parser } from '../parser/index.js';
import { detectLanguage } from '../parser/utils.js';

// Debounce window — coalesce rapid saves into a single re-parse
const DEBOUNCE_MS = 200;

export interface WatcherOptions {
  /** Called after each batch of file changes is processed */
  onUpdate?: (result: { parsed: number; errors: number; files: string[] }) => void;
  /** Called when the watcher encounters an error */
  onError?: (err: Error) => void;
  /** Extra regex sources to ignore, matched against the repo-relative path */
  extraIgnores?: string[];
}

// Patterns are matched against the repo-relative, forward-slash path and are segment-anchored,
// so a parent directory such as "code_graph_builder" never triggers the "build" rule.
const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'bin',
  'obj',
  '.cgb',
  'coverage',
  '__pycache__',
  'vendor',
];
const DEFAULT_IGNORES: RegExp[] = [
  /(^|\/)\.[^/]/, // dotfiles / dot-directories (e.g. .idea)
  ...IGNORE_DIRS.map((d) => new RegExp(`(^|/)${d.replace(/[.]/g, '\\.')}(/|$)`)),
  /\.min\.js$/,
  /\.d\.ts$/,
];

/** True when absPath (under root) should be ignored by the watcher. */
export function shouldIgnore(root: string, absPath: string, extra: RegExp[] = []): boolean {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  if (rel === '') return false; // the root itself
  if (rel.startsWith('..')) return true; // outside the root
  return DEFAULT_IGNORES.some((re) => re.test(rel)) || extra.some((re) => re.test(rel));
}

export class Watcher {
  private watcher: chokidar.FSWatcher | null = null;
  private pendingFiles = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly parser: Parser,
    private readonly options: WatcherOptions = {},
  ) {}

  /** Start watching the project root */
  start(): void {
    if (this.watcher) return;

    const extra = (this.options.extraIgnores ?? []).map((g) => new RegExp(g));
    const root = this.projectRoot;
    const ignored = (p: string): boolean => shouldIgnore(root, path.resolve(p), extra);

    this.watcher = chokidar.watch(this.projectRoot, {
      ignored,
      persistent: true,
      ignoreInitial: true, // Don't re-parse on startup (use `cgb init` for initial scan)
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher
      .on('add', (p) => this.enqueue(p))
      .on('change', (p) => this.enqueue(p))
      .on('unlink', (p) => this.handleDelete(p))
      .on('error', (err) =>
        this.options.onError?.(err instanceof Error ? err : new Error(String(err))),
      );
  }

  /** Stop watching */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private enqueue(filePath: string): void {
    const absPath = path.resolve(filePath);
    if (!detectLanguage(absPath)) return; // only watch parseable files

    this.pendingFiles.add(absPath);
    this.scheduleBatch();
  }

  private handleDelete(filePath: string): void {
    const absPath = path.resolve(filePath);
    this.parser.removeFile(absPath);
  }

  private scheduleBatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => void this.processBatch(), DEBOUNCE_MS);
  }

  private async processBatch(): Promise<void> {
    if (this.pendingFiles.size === 0) return;

    const files = Array.from(this.pendingFiles);
    this.pendingFiles.clear();

    const result = await this.parser.parseFiles(files);
    this.options.onUpdate?.({
      parsed: result.parsed,
      errors: result.errors.length,
      files,
    });
  }
}
