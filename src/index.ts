/**
 * Code Graph Builder — public API
 * Exports the core building blocks for programmatic use.
 */

export { GraphDb } from './graph/db.js';
export { GraphEngine } from './graph/engine.js';
export { Parser } from './parser/index.js';
export { BundleGenerator } from './bundle/generator.js';
export { Watcher } from './watcher/index.js';
export { treeSitterEngine } from './parser/tree-sitter-engine.js';
export { detectLanguage } from './parser/utils.js';

export type {
  GraphNode,
  GraphEdge,
  FileRecord,
  NodeKind,
  EdgeKind,
  SupportedLanguage,
  ParsedFile,
  DepsResult,
  CallersResult,
  CalleesResult,
  ImpactResult,
  PathResult,
  ContextBundle,
  BundleSection,
} from './types.js';
