/**
 * Main parser orchestrator.
 * Dispatches files to the correct language adapter, handles incremental
 * updates (skip unchanged files), and writes results to the graph DB.
 */

import * as fs from 'fs';
import { glob } from 'glob';
import type { GraphDb } from '../graph/db.js';
import type { LanguageAdapter } from './adapter.js';
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
   */
  async scanAll(force = false): Promise<ParseResult> {
    const start = Date.now();
    const files = await this.discoverFiles();
    return this.parseFiles(files, force, start);
  }

  /**
   * Parse a specific list of files (used by the watcher for incremental updates).
   */
  async parseFiles(filePaths: string[], force = false, _startTime?: number): Promise<ParseResult> {
    const start = _startTime ?? Date.now();
    let parsed = 0;
    let skipped = 0;
    const errors: Array<{ filePath: string; error: string }> = [];

    for (const filePath of filePaths) {
      try {
        const result = await this.parseFile(filePath, force);
        if (result === 'skipped') skipped++;
        else parsed++;
      } catch (err) {
        errors.push({
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.db.persist();
    return { parsed, skipped, errors, durationMs: Date.now() - start };
  }

  /**
   * Parse a single file.
   * Returns 'skipped' if the file hasn't changed since last parse.
   * Returns 'parsed' if the file was (re)parsed.
   */
  async parseFile(filePath: string, force = false): Promise<'parsed' | 'skipped'> {
    const lang = detectLanguage(filePath);
    if (!lang) return 'skipped'; // unsupported file type

    if (!fs.existsSync(filePath)) {
      // File was deleted — remove from graph
      this.db.deleteFile(filePath);
      return 'parsed';
    }

    // Skip directories that happen to match a source extension (e.g. `countup.js/`)
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return 'skipped';

    const source = fs.readFileSync(filePath, 'utf-8');
    const contentHash = hashContent(source);

    if (!force) {
      const existing = this.db.getFile(filePath);
      if (existing && existing.contentHash === contentHash) {
        return 'skipped';
      }
    }

    const adapter = ADAPTERS[lang];
    const parsed = await adapter.parse(filePath, source);

    // Remove stale graph data for this file
    this.db.deleteFile(filePath);

    // Write new nodes
    const now = Date.now();
    for (const node of parsed.nodes) {
      this.db.upsertNode({ ...node, updatedAt: now } as GraphNode);
    }

    // Write new edges (only if both endpoints exist or will be created)
    for (const edge of parsed.edges) {
      // Allow edges to unresolved nodes (they'll be created when that file is parsed)
      this.db.upsertEdge({ ...edge, updatedAt: now } as GraphEdge);
    }

    const stats = fs.statSync(filePath);
    this.db.upsertFile({
      filePath,
      language: lang,
      contentHash,
      mtime: stats.mtimeMs,
      nodeCount: parsed.nodes.length,
      edgeCount: parsed.edges.length,
      parsedAt: now,
    });

    return 'parsed';
  }

  /**
   * Remove a file from the graph (called when file is deleted).
   */
  removeFile(filePath: string): void {
    this.db.deleteFile(filePath);
    this.db.persist();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Discover all parseable source files under projectRoot */
  private async discoverFiles(): Promise<string[]> {
    const extensions = [
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
      'cs',
      'py',
      'go',
      'java',
      'rs',
      'rb',
      'php',
      'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh',
      'kt', 'kts',
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
