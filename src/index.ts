/**
 * Code Graph Builder — public API
 * Exports the core building blocks for programmatic use.
 */

export { GraphDb } from './graph/db.js';
export type { GraphDbOptions } from './graph/db.js';
export { GraphEngine } from './graph/engine.js';
export { Parser } from './parser/index.js';
export { BundleGenerator } from './bundle/generator.js';
export { Watcher } from './watcher/index.js';
export { treeSitterEngine } from './parser/tree-sitter-engine.js';
export { detectLanguage } from './parser/utils.js';
export { CommunityDetector } from './communities/index.js';
export type { Community, ArchitectureOverview } from './communities/index.js';
export { FlowsAnalyzer, findLargeFunctions } from './flows/index.js';
export type { EntryPoint, CallChainStep, CriticalityScore, LargeFunction } from './flows/index.js';
export { WikiGenerator } from './wiki/index.js';
export type { WikiPage, WikiResult, WikiPageJson } from './wiki/index.js';
export { buildReviewContext, formatReviewContext } from './git/review-context.js';
export type { ReviewContext } from './git/review-context.js';
export type { ChangeAnalysis, FileChangeDetail } from './git/changes.js';
export { openGraph, initGraph } from './api.js';
export type { OpenGraphOptions, OpenGraphResult, InitGraphResult } from './api.js';
export { relativizePaths } from './portable.js';

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
  CommunityRecord,
} from './types.js';
