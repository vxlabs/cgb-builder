/**
 * Main parser orchestrator.
 * Dispatches files to the correct language adapter, handles incremental
 * updates (skip unchanged files), and writes results to the graph DB.
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import type { GraphDb } from '../graph/db.js';
import type { LanguageAdapter, SymbolRef } from './adapter.js';
import { Linker } from './linker.js';
import { debug } from '../util/log.js';
import { TypeScriptAdapter } from './adapters/typescript.js';
import { CSharpAdapter } from './adapters/csharp.js';
import { PythonAdapter } from './adapters/python.js';
import { GoAdapter } from './adapters/go.js';
import { JavaAdapter } from './adapters/java.js';
import { RustAdapter } from './adapters/rust.js';
import { RubyAdapter } from './adapters/ruby.js';
import { PhpAdapter } from './adapters/php.js';
import { CAdapter } from './adapters/c.js';
import { KotlinAdapter } from './adapters/kotlin.js';
import { detectLanguage, hashContent } from './utils.js';
import type { SupportedLanguage, GraphNode, GraphEdge } from '../types.js';

/**
 * Bump when adapters/linker change what is stored per file (new node meta, edges, ...).
 * Mixed into each file's content hash, so incremental init reparses everything once.
 */
export const PARSER_VERSION = '1.3.0-1';

// ─── Adapter registry ─────────────────────────────────────────────────────────

const ADAPTERS: Record<SupportedLanguage, LanguageAdapter> = {
  typescript: new TypeScriptAdapter('typescript'),
  javascript: new TypeScriptAdapter('javascript'),
  csharp: new CSharpAdapter(),
  python: new PythonAdapter(),
  go: new GoAdapter(),
  java: new JavaAdapter(),
  rust: new RustAdapter(),
  ruby: new RubyAdapter(),
  php: new PhpAdapter(),
  c: new CAdapter('c'),
  cpp: new CAdapter('cpp'),
  kotlin: new KotlinAdapter(),
};

/** Default glob patterns to ignore */
const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/bin/**',
  '**/obj/**',
  '**/.git/**',
  '**/.cgb/**',
  '**/vendor/**',
  '**/__pycache__/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.d.ts',
];

// ─── ParseResult ─────────────────────────────────────────────────────────────

export interface ParseResult {
  parsed: number;
  skipped: number;
  errors: Array<{ filePath: string; error: string }>;
  durationMs: number;
}

// ─── Parser orchestrator ──────────────────────────────────────────────────────

export class Parser {
  constructor(
    private readonly db: GraphDb,
    private readonly projectRoot: string,
  ) {}

  /**
   * Full scan: traverse all source files under projectRoot and parse them.
   * Respects incremental hashing — skips files that haven't changed.
   * Files that are in the DB but no longer discovered (deleted/ignored) are removed.
   */
  async scanAll(force = false): Promise<ParseResult> {
    const start = Date.now();
    const files = await this.discoverFiles();

    // Prune files that vanished since the last scan (a cached DB may be reused across
    // worktrees / commits), so stale nodes never leak into analysis.
    const key = (p: string): string =>
      process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);
    const discovered = new Set(files.map(key));
    const gone = this.db.getAllFiles().filter((f) => !discovered.has(key(f.filePath)));
    if (gone.length > 0) {
      this.db.transaction(() => {
        for (const f of gone) this.db.deleteFile(f.filePath);
      });
      debug('parser', `removed ${gone.length} file(s) no longer on disk`);
    }
    return this.parseFiles(files, force, start);
  }

  /**
   * Parse a specific list of files (used by the watcher for incremental updates).
   * Cross-file references are linked once at the end of the batch.
   */
  async parseFiles(filePaths: string[], force = false, _startTime?: number): Promise<ParseResult> {
    const start = _startTime ?? Date.now();
    let parsed = 0;
    let skipped = 0;
    const errors: Array<{ filePath: string; error: string }> = [];
    const batch: Array<{ filePath: string; refs: SymbolRef[] }> = [];

    for (const filePath of filePaths) {
      try {
        const result = await this.parseOne(filePath, force);
        if (result.status === 'skipped') skipped++;
        else {
          parsed++;
          batch.push({ filePath, refs: result.refs });
        }
      } catch (err) {
        errors.push({
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const stats = new Linker(this.db).link(batch);
    debug(
      'parser',
      `linked: ${stats.resolved} resolved, ${stats.unresolved} unresolved, ${stats.pruned} pruned`,
    );
    return { parsed, skipped, errors, durationMs: Date.now() - start };
  }

  /**
   * Parse a single file (and link it).
   * Returns 'skipped' if the file hasn't changed since last parse.
   * Returns 'parsed' if the file was (re)parsed.
   */
  async parseFile(filePath: string, force = false): Promise<'parsed' | 'skipped'> {
    const result = await this.parseOne(filePath, force);
    if (result.status === 'parsed') {
      new Linker(this.db).link([{ filePath, refs: result.refs }]);
    }
    return result.status;
  }

  /**
   * Remove a file from the graph (called when file is deleted).
   * Incoming edges to the file's symbols are pruned as dangling.
   */
  removeFile(filePath: string): void {
    this.db.transaction(() => this.db.deleteFile(filePath));
    new Linker(this.db).link([]);
  }

  /** Parse + write one file without linking. */
  private async parseOne(
    filePath: string,
    force: boolean,
  ): Promise<{ status: 'parsed' | 'skipped'; refs: SymbolRef[] }> {
    const skipped = { status: 'skipped' as const, refs: [] as SymbolRef[] };
    const lang = detectLanguage(filePath);
    if (!lang) return skipped; // unsupported file type

    if (!fs.existsSync(filePath)) {
      // File was deleted — remove from graph (dangling edges pruned by the linker)
      this.db.transaction(() => this.db.deleteFile(filePath));
      return { status: 'parsed', refs: [] };
    }

    // Skip directories that happen to match a source extension (e.g. `countup.js/`)
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return skipped;

    const source = fs.readFileSync(filePath, 'utf-8');
    // Parser version is mixed into the hash so a parser upgrade forces a reparse.
    const contentHash = hashContent(`${PARSER_VERSION}\n${source}`);

    if (!force) {
      const existing = this.db.getFile(filePath);
      if (existing && existing.contentHash === contentHash) {
        return skipped;
      }
    }

    const adapter = ADAPTERS[lang];
    const parsed = await adapter.parse(filePath, source);

    const now = Date.now();
    this.db.transaction(() => {
      // Remove stale graph data for this file (outgoing edges only; incoming survive)
      this.db.deleteFile(filePath);

      for (const node of parsed.nodes) {
        this.db.upsertNode({ ...node, updatedAt: now } as GraphNode);
      }
      // No FK: edges to nodes that don't exist yet are fine; the linker prunes after the batch
      for (const edge of parsed.edges) {
        this.db.upsertEdge({ ...edge, updatedAt: now } as GraphEdge);
      }
      this.db.upsertFile({
        filePath,
        language: lang,
        contentHash,
        mtime: stat.mtimeMs,
        nodeCount: parsed.nodes.length,
        edgeCount: parsed.edges.length,
        parsedAt: now,
      });
    });

    return { status: 'parsed', refs: parsed.refs ?? [] };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Discover all parseable source files under projectRoot */
  private async discoverFiles(): Promise<string[]> {
    const extensions = [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'cs',
      'py',
      'go',
      'java',
      'rs',
      'rb',
      'php',
      'c',
      'h',
      'cpp',
      'cc',
      'cxx',
      'hpp',
      'hh',
      'kt',
      'kts',
    ];
    const pattern = `**/*.{${extensions.join(',')}}`;

    const files = await glob(pattern, {
      cwd: this.projectRoot,
      ignore: DEFAULT_IGNORES,
      absolute: true,
      nodir: true,
    });

    return files;
  }
}
