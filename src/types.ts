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
  | 'external_dep'
  | 'type' // type alias, enum, type definition
  | 'test'; // test file or test suite

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
  | 'exports' // module exports a symbol
  | 'contains' // file/class contains a child symbol
  | 'tested_by' // source file tested by a test file
  | 'depends_on'; // generic dependency (non-import)

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

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'csharp'
  | 'python'
  | 'go'
  | 'java'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'c'
  | 'cpp'
  | 'kotlin';

export const LANGUAGE_EXTENSIONS: Record<SupportedLanguage, string[]> = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  csharp: ['.cs'],
  python: ['.py'],
  go: ['.go'],
  java: ['.java'],
  rust: ['.rs'],
  ruby: ['.rb'],
  php: ['.php'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
  kotlin: ['.kt', '.kts'],
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

// ─── Git Integration Types ────────────────────────────────────────────────────

export interface GitChange {
  filePath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface FileChangeDetail {
  file: GitChange;
  nodesAffected: number;
  blastRadius: number;
  riskScore: number;
  securityRelevant: boolean;
  hasTests: boolean;
  riskFactors: {
    blastRadiusScore: number;
    securityKeywordScore: number;
    fileTypeScore: number;
    changeSizeScore: number;
    testCoverageScore: number;
    total: number;
  };
}

export interface ChangeAnalysis {
  summary: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    totalChangedLines: number;
  };
  changes: FileChangeDetail[];
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
}

export interface ReviewContext {
  base: string;
  changedFiles: string[];
  affectedFiles: string[];
  relevantTests: string[];
  riskSummary: ChangeAnalysis;
  focusAreas: string[];
  tokenEstimate: number;
}

// ─── Embedding Types ──────────────────────────────────────────────────────────

export interface EmbeddingRecord {
  nodeId: string;
  vector: Uint8Array; // Float32 encoded
  textHash: string; // SHA-256 of the text that was embedded
  provider: string; // e.g. "local", "google", "minimax"
}

// ─── Community Types ──────────────────────────────────────────────────────────

export interface CommunityRecord {
  id: number;
  name: string;
  level: number; // 0 = top-level, 1 = sub-community
  parentId: number | null;
  cohesion: number; // 0..1: internal_edges / (internal + external)
  size: number; // node count
  dominantLanguage: string | null;
  description: string;
  createdAt: number; // unix ms
}

// ─── Refactoring Types ────────────────────────────────────────────────────────

export interface RefactorEdit {
  file: string; // absolute path
  line: number | null; // target line number, null = first-occurrence fallback
  old: string; // text to replace
  new: string; // replacement text
  confidence: number; // 0..1
}

export interface RefactorPreview {
  refactorId: string; // 8-char hex
  type: 'rename';
  oldName: string;
  newName: string;
  nodeId: string;
  edits: RefactorEdit[];
  stats: { filesAffected: number; occurrences: number };
  createdAt: number; // unix ms
}

export interface RefactorResult {
  status: 'applied' | 'not_found' | 'expired' | 'error';
  error?: string;
  applied?: boolean;
  filesModified?: number;
  editsApplied?: number;
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
