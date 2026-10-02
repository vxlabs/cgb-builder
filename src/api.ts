/**
 * Convenience programmatic entry points for headless use (e.g. an agent runner).
 */

import * as path from 'path';
import { GraphDb } from './graph/db.js';
import { GraphEngine } from './graph/engine.js';
import { Parser } from './parser/index.js';

export interface OpenGraphOptions {
  /** Project root (worktree). Stored paths are relative to it. */
  root: string;
  /** Directory for graph.db. Precedence: this > env CGB_DB_DIR > `<root>/.cgb`. */
  dbDir?: string;
  /** Open without ever creating or writing the DB file. */
  readOnly?: boolean;
}

export interface OpenGraphResult {
  db: GraphDb;
  engine: GraphEngine;
  close(): void;
}

export interface InitGraphResult {
  files: number;
  nodes: number;
  edges: number;
  parsed: number;
  skipped: number;
  errors: Array<{ filePath: string; error: string }>;
  durationMs: number;
}

/** Open (and create if missing) the graph for a project. Call `close()` when done. */
export async function openGraph(options: OpenGraphOptions): Promise<OpenGraphResult> {
  const root = path.resolve(options.root);
  const db = new GraphDb(root, { dbDir: options.dbDir, readOnly: options.readOnly });
  await db.init();
  const engine = new GraphEngine(db);
  return { db, engine, close: () => db.close() };
}

/** Scan the project (incrementally) and persist the graph; returns statistics. */
export async function initGraph(options: {
  root: string;
  dbDir?: string;
  force?: boolean;
}): Promise<InitGraphResult> {
  const root = path.resolve(options.root);
  const db = new GraphDb(root, { dbDir: options.dbDir });
  await db.init();
  try {
    const parser = new Parser(db, root);
    const result = await parser.scanAll(options.force ?? false);
    const stats = db.getStats();
    return {
      ...stats,
      parsed: result.parsed,
      skipped: result.skipped,
      errors: result.errors,
      durationMs: result.durationMs,
    };
  } finally {
    db.close();
  }
}
