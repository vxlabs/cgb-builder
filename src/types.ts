/**
 * Core domain types for the Code Graph Builder.
 * All entities and edges in the graph are represented by these types.
 */

// ─── Node Types ──────────────────────────────────────────────────────────────

export type NodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'external_dep';

export interface GraphNode {
  id: string; // stable UID: e.g. file:src/foo.ts, class:src/foo.ts#Foo
  kind: NodeKind;
  name: string; // short name (filename, class name, function name)
  filePath: string; // absolute path for local nodes; package name for external
  /** Brief purpose — max 3 sentences, auto-inferred or user-supplied */
  description: string;
  /** True for external npm/nuget/pypi packages */
  isExternal: boolean;
  language: SupportedLanguage | null;
  /** Serialized JSON of additional metadata (e.g. visibility, return type) */
  meta: string;
  updatedAt: number; // unix ms
}

// ─── Edge Types ──────────────────────────────────────────────────────────────

export type EdgeKind =
  | 'imports' // file/module imports another
  | 'calls' // function calls another function
  | 'inherits' // class extends another
  | 'implements' // class implements interface
  | 'exports'; // module exports a symbol

export interface GraphEdge {
  id: string; // "fromId|kind|toId"
  fromId: string;
  toId: string;
  kind: EdgeKind;
  /** Short reason why this edge exists (auto-inferred or user-provided) */
  reason: string;
  updatedAt: number;
}

// ─── File Metadata ───────────────────────────────────────────────────────────

export interface FileRecord {
  filePath: string;
  language: SupportedLanguage;
  contentHash: string; // SHA-256 of file content for incremental updates
  mtime: number; // file system mtime ms
  nodeCount: number;
  edgeCount: number;
  parsedAt: number;
}

// ─── Language Support ────────────────────────────────────────────────────────

export type SupportedLanguage = 'typescript' | 'javascript' | 'csharp' | 'python' | 'go' | 'java';

export const LANGUAGE_EXTENSIONS: Record<SupportedLanguage, string[]> = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  csharp: ['.cs'],
  python: ['.py'],
  go: ['.go'],
  java: ['.java'],
};

// ─── Parsed Output (from adapters) ───────────────────────────────────────────

/** Raw extraction result from a language adapter, before DB writes */
export interface ParsedFile {
  filePath: string;
  language: SupportedLanguage;
  nodes: Omit<GraphNode, 'updatedAt'>[];
  edges: Omit<GraphEdge, 'updatedAt'>[];
}

// ─── Query Results ───────────────────────────────────────────────────────────

export interface DepsResult {
  target: GraphNode;
  direct: GraphNode[];
  transitive: GraphNode[];
}

export interface CallersResult {
  target: GraphNode;
  callers: Array<{ node: GraphNode; reason: string }>;
}

export interface CalleesResult {
  target: GraphNode;
  callees: Array<{ node: GraphNode; reason: string }>;
}

export interface ImpactResult {
  target: GraphNode;
  /** All nodes that transitively import/depend on the target */
  affected: Array<{ node: GraphNode; depth: number; path: GraphNode[] }>;
}

export interface PathResult {
  from: GraphNode;
  to: GraphNode;
  path: GraphNode[];
  edges: GraphEdge[];
}

// ─── Context Bundle ───────────────────────────────────────────────────────────

export interface ContextBundle {
  generatedAt: string;
  rootFile: string;
  totalTokenEstimate: number;
  sections: BundleSection[];
}

export interface BundleSection {
  title: string;
  content: string;
  tokenEstimate: number;
}
