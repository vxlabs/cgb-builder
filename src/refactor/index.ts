/**
 * Refactoring analysis module.
 *
 * Provides:
 * - Dead code detection: unexported functions/methods/classes with no calls/inherits/implements edges
 * - Unused exports: exported symbols nobody calls and whose file nobody imports
 * - Rename preview: range-scoped, per-occurrence edits (declaration, call sites, import specifiers)
 * - Apply refactor: drift-checked, path-safe apply of a previewed rename, then re-parse
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphDb } from '../graph/db.js';
import type { GraphNode, RefactorEdit, RefactorPreview, RefactorResult } from '../types.js';
import { isTestFile } from '../git/risk.js';
import { Parser } from '../parser/index.js';
import { debug } from '../util/log.js';

export type { RefactorEdit, RefactorPreview, RefactorResult };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeadCodeResult {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  language: string | null;
  reason: string;
  exported?: boolean;
}

/** One concrete rename edit: a single identifier occurrence. `file` is repo-relative. */
export interface RenameItem {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
  before: string; // full current text of the line (no EOL)
  after: string; // the line with only this occurrence replaced
  confidence: 'high' | 'low';
}

/** RefactorPreview plus the range-scoped items used by apply. All old fields are kept. */
export interface RenamePreviewWithEdits extends RefactorPreview {
  items: RenameItem[];
  warnings: string[];
}

/** RefactorResult plus the details of the safe apply. All old fields are kept. */
export interface ApplyResult extends RefactorResult {
  files?: string[]; // repo-relative files written
  reparsed?: boolean;
  conflicts?: RenameItem[]; // set when apply aborted because lines drifted
}

export interface RenamePreview {
  targetId: string;
  currentName: string;
  filePath: string;
  affectedEdges: Array<{
    edgeId: string;
    kind: string;
    fromId: string;
    fromName: string;
    toId: string;
    toName: string;
    reason: string;
  }>;
  affectedFiles: string[];
  summary: string;
}

export interface RefactorSuggestion {
  type: 'extract' | 'split' | 'merge' | 'move';
  targetId: string;
  targetName: string;
  filePath: string;
  reason: string;
  fanIn: number;
  fanOut: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const REFERENCE_EDGES = ['calls', 'inherits', 'implements'];
const RENAMEABLE_LANGS = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

/** Escape special regex characters in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary pattern for an identifier (does not match inside longer identifiers). */
function wordBoundaryPattern(name: string): RegExp {
  return new RegExp('(?<![\\w$])' + escapeRegex(name) + '(?![\\w$])', 'g');
}

/** Bare identifier of a node name ("Class.method" -> "method"). */
function bareName(name: string): string {
  const m = /[A-Za-z_$][\w$]*$/.exec(name);
  return m ? m[0] : name;
}

/** Split into lines without EOLs; `\r` of CRLF is dropped from each line. */
function splitLines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

interface LexResult {
  /** code[i] is true when line i (0-based) char j is code, not inside a string or comment. */
  code: boolean[][];
  /** Lines holding constructs the lexer cannot decide on (template literals). */
  ambiguous: Set<number>;
}

/**
 * Lexer-lite: marks each character as code or string/comment. Handles quotes, template literals
 * (including `${}` code), line and block comments. Regex literals are not understood.
 */
function lex(lines: string[], hashComments: boolean): LexResult {
  const code: boolean[][] = [];
  const ambiguous = new Set<number>();
  // stack of template-expression brace depths; non-empty means we may return to a template
  const tplStack: number[] = [];
  let inBlock = false;
  let inTemplate = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- untyped third-party/dynamic value; behaviour unchanged
    const mask: boolean[] = new Array(line.length).fill(false);
    let quote: string | null = null;
    let j = 0;
    if (inTemplate) ambiguous.add(i);
    while (j < line.length) {
      const ch = line[j];
      const next = line[j + 1];
      if (inBlock) {
        if (ch === '*' && next === '/') {
          inBlock = false;
          j += 2;
        } else j++;
        continue;
      }
      if (inTemplate) {
        if (ch === '\\') j += 2;
        else if (ch === '`') {
          inTemplate = false;
          j++;
        } else if (ch === '$' && next === '{') {
          inTemplate = false;
          tplStack.push(0);
          j += 2;
        } else j++;
        continue;
      }
      if (quote) {
        if (ch === '\\') j += 2;
        else {
          if (ch === quote) quote = null;
          j++;
        }
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (hashComments && ch === '#') break;
      if (ch === '/' && next === '*') {
        inBlock = true;
        j += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        j++;
        continue;
      }
      if (ch === '`') {
        inTemplate = true;
        ambiguous.add(i);
        j++;
        continue;
      }
      if (tplStack.length > 0) {
        if (ch === '{') tplStack[tplStack.length - 1]++;
        else if (ch === '}') {
          if (tplStack[tplStack.length - 1] === 0) {
            tplStack.pop();
            inTemplate = true;
            ambiguous.add(i);
            j++;
            continue;
          }
          tplStack[tplStack.length - 1]--;
        }
      }
      mask[j] = true;
      j++;
    }
    code.push(mask);
  }
  return { code, ambiguous };
}

/** Throws when `abs` (or its realpath) is outside `root`. Returns the repo-relative path. */
function assertInsideRoot(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path traversal attempt detected: ${abs}`);
  }
  if (fs.existsSync(abs)) {
    const realRoot = fs.realpathSync(root);
    const realRel = path.relative(realRoot, fs.realpathSync(abs));
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Path resolves outside the project root: ${abs}`);
    }
  }
  return rel;
}

// ─── Pending store ────────────────────────────────────────────────────────────

interface PendingRefactor {
  preview: RenamePreviewWithEdits;
  root: string;
}

const pendingRefactors = new Map<string, PendingRefactor>();
const REFACTOR_EXPIRY_MS = 600_000; // 10 minutes

function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, p] of pendingRefactors) {
    if (now - p.preview.createdAt > REFACTOR_EXPIRY_MS) {
      pendingRefactors.delete(id);
    }
  }
}

/** Test hook: age a pending preview so it expires. */
export function _expirePendingRefactorForTest(refactorId: string): void {
  const p = pendingRefactors.get(refactorId);
  if (p) p.preview.createdAt = Date.now() - REFACTOR_EXPIRY_MS - 1;
}

// ─── RefactorAnalyzer ─────────────────────────────────────────────────────────

export class RefactorAnalyzer {
  private readonly root: string;

  /** @param root Project root; defaults to the parent of the db's .cgb directory. */
  constructor(
    private readonly db: GraphDb,
    root?: string,
  ) {
    this.root = path.resolve(root ?? path.dirname(db.getDbDir()));
  }

  /** Languages for which the graph has at least one `calls` edge (so "no callers" means something). */
  private languagesWithCalls(): Set<string> {
    const langs = new Set<string>();
    const fromIds = new Set<string>();
    for (const e of this.db.getAllEdges()) if (e.kind === 'calls') fromIds.add(e.fromId);
    for (const n of this.db.getNodesByIds([...fromIds])) if (n.language) langs.add(n.language);
    return langs;
  }

  private referenceCount(nodeId: string): number {
    return this.db.getEdgesTo(nodeId).filter((e) => REFERENCE_EDGES.includes(e.kind)).length;
  }

  private isFileImported(filePath: string): boolean {
    return this.db.getEdgesToByKind(`file:${filePath}`, 'imports').length > 0;
  }

  /**
   * Find dead code: unexported functions, methods and classes with no incoming
   * calls, inherits or implements edges. Skips main, constructor and test files, and languages
   * whose graph has no call edges at all. Nodes whose `exported` flag is unknown are skipped.
   */
  deadCode(limit = 30): DeadCodeResult[] {
    const langs = this.languagesWithCalls();
    const results: DeadCodeResult[] = [];

    for (const node of this.db.getNodesByKind(['function', 'method', 'class'])) {
      if (node.isExternal) continue;
      if (node.exported !== false) continue;
      if (!node.language || !langs.has(node.language)) continue;
      const name = bareName(node.name);
      if (name === 'main' || name === 'constructor') continue;
      if (isTestFile(node.filePath)) continue;
      if (this.referenceCount(node.id) > 0) continue;

      results.push({
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        kind: node.kind,
        language: node.language,
        reason: 'Not exported and no calls, inherits or implements edges reach it',
        exported: false,
      });
    }

    return results.slice(0, limit);
  }

  /**
   * Exported functions, methods and classes with no callers, whose file no other file imports.
   */
  unusedExports(limit = 30): DeadCodeResult[] {
    const langs = this.languagesWithCalls();
    const results: DeadCodeResult[] = [];

    for (const node of this.db.getNodesByKind(['function', 'method', 'class'])) {
      if (node.isExternal) continue;
      if (node.exported !== true) continue;
      if (!node.language || !langs.has(node.language)) continue;
      const name = bareName(node.name);
      if (name === 'main' || name === 'constructor') continue;
      if (isTestFile(node.filePath)) continue;
      if (this.referenceCount(node.id) > 0) continue;
      if (this.isFileImported(node.filePath)) continue;

      results.push({
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        kind: node.kind,
        language: node.language,
        reason: 'Exported but never called, and no file imports its module',
        exported: true,
      });
    }

    return results.slice(0, limit);
  }

  /**
   * Preview what would be affected if a node is renamed.
   * Returns basic edge-level info (no disk I/O, no storage).
   */
  renamePreview(nodeId: string): RenamePreview | null {
    const node = this.db.getNode(nodeId);
    if (!node) return null;

    const inbound = this.db.getEdgesTo(nodeId);
    const outbound = this.db.getEdgesFrom(nodeId);
    const allEdges = [...inbound, ...outbound];

    const affectedEdgeDetails = allEdges.map((edge) => {
      const from = this.db.getNode(edge.fromId);
      const to = this.db.getNode(edge.toId);
      return {
        edgeId: edge.id,
        kind: edge.kind,
        fromId: edge.fromId,
        fromName: from?.name ?? edge.fromId,
        toId: edge.toId,
        toName: to?.name ?? edge.toId,
        reason: edge.reason,
      };
    });

    const affectedFiles = [
      ...new Set(
        allEdges
          .flatMap((e) => {
            const from = this.db.getNode(e.fromId);
            const to = this.db.getNode(e.toId);
            return [from?.filePath, to?.filePath].filter(Boolean) as string[];
          })
          .filter((fp) => fp !== node.filePath),
      ),
    ];

    const summary =
      affectedEdgeDetails.length === 0
        ? 'No references found — safe to rename'
        : `${affectedFiles.length} file(s) reference "${node.name}" and will need updates`;

    return {
      targetId: node.id,
      currentName: node.name,
      filePath: node.filePath,
      affectedEdges: affectedEdgeDetails,
      affectedFiles,
      summary,
    };
  }

  /**
   * Preview a rename with concrete, per-occurrence edits. Stores the preview for later apply.
   * Sites: the declaration, lines in referencing symbols' ranges (calls/inherits/implements),
   * and import specifier lines in importing files. Strings and comments are never touched.
   * Throws when newName is not a valid identifier.
   */
  renamePreviewWithEdits(nodeId: string, newName: string): RenamePreviewWithEdits | null {
    cleanupExpired();

    const node = this.db.getNode(nodeId);
    if (!node) return null;
    if (!IDENT_RE.test(newName)) throw new Error(`Invalid identifier: ${newName}`);

    const oldName = bareName(node.name);
    const warnings: string[] = [];
    const pattern = wordBoundaryPattern(oldName);

    const fileCache = new Map<string, { lines: string[]; lexed: LexResult } | null>();
    const load = (abs: string) => {
      if (!fileCache.has(abs)) {
        let entry: { lines: string[]; lexed: LexResult } | null = null;
        try {
          const lines = splitLines(fs.readFileSync(abs, 'utf8'));
          entry = { lines, lexed: lex(lines, /\.(py|rb)$/.test(abs)) };
        } catch (e) {
          debug('refactor', `cannot read ${abs}`, e);
        }
        fileCache.set(abs, entry);
      }
      return fileCache.get(abs) ?? null;
    };

    const items: RenameItem[] = [];
    const seen = new Set<string>();

    /** Add every code occurrence of the name on 1-based lines [from, to] of `abs`. */
    const scan = (
      abs: string,
      from: number,
      to: number,
      opts: {
        firstOnly?: boolean;
        baseLow?: boolean;
        lineFilter?: (text: string, idx: number) => boolean;
      },
    ): number => {
      const f = load(abs);
      if (!f) return 0;
      const rel = path.relative(this.root, abs);
      const langLow = !RENAMEABLE_LANGS.has(node.language ?? '');
      let added = 0;
      const last = Math.min(to, f.lines.length);
      for (let ln = Math.max(1, from); ln <= last; ln++) {
        const text = f.lines[ln - 1];
        if (opts.lineFilter && !opts.lineFilter(text, ln - 1)) continue;
        const mask = f.lexed.code[ln - 1];
        let hasSkipped = false;
        const hits: number[] = [];
        for (const m of text.matchAll(pattern)) {
          const col = m.index ?? 0;
          if (mask[col]) hits.push(col);
          else hasSkipped = true;
        }
        if (hits.length === 0) continue;
        const low = !!opts.baseLow || langLow || hasSkipped || f.lexed.ambiguous.has(ln - 1);
        for (const col of opts.firstOnly ? hits.slice(0, 1) : hits) {
          const key = `${rel}:${ln}:${col}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            file: rel,
            line: ln,
            column: col + 1,
            before: text,
            after: text.slice(0, col) + newName + text.slice(col + oldName.length),
            confidence: low ? 'low' : 'high',
          });
          added++;
        }
        if (opts.firstOnly && added > 0) break;
      }
      return added;
    };

    // (a) declaration
    const hasRange = node.startLine !== undefined && node.endLine !== undefined;
    if (hasRange) {
      const decl = new RegExp(
        '(?:function\\*?|class|interface|type|enum|const|let|var|def|fn|func)\\s+' +
          escapeRegex(oldName) +
          '(?![\\w$])',
      );
      // prefer a line with a declaration keyword, else the first code occurrence in the range
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
      const added = scan(node.filePath, node.startLine!, node.endLine!, {
        firstOnly: true,
        lineFilter: (text) => decl.test(text),
      });
      if (added === 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
        scan(node.filePath, node.startLine!, node.endLine!, { firstOnly: true });
      }
    } else {
      warnings.push(
        `"${node.name}" has no line range; showing low-confidence candidates for the whole file only`,
      );
      scan(node.filePath, 1, Number.MAX_SAFE_INTEGER, { firstOnly: true, baseLow: true });
    }

    // (b) referencing symbols
    const referrers = new Map<string, GraphNode>();
    for (const e of this.db.getEdgesTo(nodeId)) {
      if (!REFERENCE_EDGES.includes(e.kind)) continue;
      const from = this.db.getNode(e.fromId);
      if (from && from.filePath) referrers.set(from.id, from);
    }
    for (const from of referrers.values()) {
      if (from.startLine !== undefined && from.endLine !== undefined) {
        scan(from.filePath, from.startLine, from.endLine, {});
      } else {
        warnings.push(
          `Caller "${from.name}" has no line range; scanned its whole file at low confidence`,
        );
        scan(from.filePath, 1, Number.MAX_SAFE_INTEGER, { baseLow: true });
      }
    }

    // (c) import specifiers in files that import the target's file
    const importers = this.db
      .getEdgesToByKind(`file:${node.filePath}`, 'imports')
      .map((e) => this.db.getNode(e.fromId))
      .filter((n): n is GraphNode => !!n && !!n.filePath);
    for (const imp of importers) {
      const f = load(imp.filePath);
      if (!f) continue;
      let inStatement = false;
      scan(imp.filePath, 1, f.lines.length, {
        lineFilter: (text, idx) => {
          const t = text.trim();
          const starts =
            /^(import|export)\b/.test(t) &&
            (t.includes('{') || /^import\s/.test(t) || /^export\s*\*/.test(t));
          if (starts) inStatement = true;
          const inside = inStatement;
          if (
            inStatement &&
            (/\bfrom\s*['"]/.test(t) || /;\s*$/.test(t) || /^import\s*['"]/.test(t))
          )
            inStatement = false;
          void idx;
          return inside;
        },
      });
    }

    if (RENAMEABLE_LANGS.has(node.language ?? '') === false) {
      warnings.push(
        `Rename scoping is precise for TypeScript/JavaScript only; ${node.language ?? 'this language'} edits are low confidence`,
      );
    }
    const sameFile = this.db
      .getNodesByName(newName)
      .filter((n) => n.filePath === node.filePath && n.id !== node.id);
    if (sameFile.length > 0)
      warnings.push(`"${newName}" already exists in ${path.relative(this.root, node.filePath)}`);

    items.sort((a, b) =>
      a.file === b.file ? a.line - b.line || a.column - b.column : a.file.localeCompare(b.file),
    );

    const edits: RefactorEdit[] = items.map((it) => ({
      file: path.resolve(this.root, it.file),
      line: it.line,
      old: oldName,
      new: newName,
      confidence: it.confidence === 'high' ? 0.95 : 0.5,
    }));
    const files = new Set(items.map((i) => i.file));

    const refactorId = crypto.randomBytes(4).toString('hex');
    const preview: RenamePreviewWithEdits = {
      refactorId,
      type: 'rename',
      oldName,
      newName,
      nodeId,
      edits,
      items,
      warnings,
      stats: { filesAffected: files.size, occurrences: items.length },
      createdAt: Date.now(),
    };

    pendingRefactors.set(refactorId, { preview, root: this.root });
    return preview;
  }

  /**
   * Suggest structural refactoring based on connectivity metrics.
   */
  suggestions(limit = 10): RefactorSuggestion[] {
    const nodes = this.db.getNodesByKind(['function', 'method', 'class', 'file']);
    const suggestions: RefactorSuggestion[] = [];

    for (const node of nodes) {
      if (node.isExternal) continue;

      const fanIn = this.db.getEdgesTo(node.id).length;
      const fanOut = this.db.getEdgesFrom(node.id).length;

      if (node.kind !== 'file' && fanOut >= 10) {
        suggestions.push({
          type: 'extract',
          targetId: node.id,
          targetName: node.name,
          filePath: node.filePath,
          reason: `High fan-out (${fanOut} outbound edges): consider extracting helper functions`,
          fanIn,
          fanOut,
        });
      }

      if (node.kind === 'file' && fanIn >= 15) {
        suggestions.push({
          type: 'split',
          targetId: node.id,
          targetName: node.name,
          filePath: node.filePath,
          reason: `High fan-in (${fanIn} files depend on this): consider splitting into smaller modules`,
          fanIn,
          fanOut,
        });
      }
    }

    return suggestions.sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut)).slice(0, limit);
  }
}

// ─── Apply Refactor ───────────────────────────────────────────────────────────

/**
 * Apply a stored rename preview to disk. Only the previewed (file, line, column) edits are made.
 * Aborts with nothing written if any path is unsafe or any line has drifted from `before`.
 * Does not re-parse; use applyRefactorAsync for that.
 */
export function applyRefactor(refactorId: string, repoRoot: string): ApplyResult {
  const pending = pendingRefactors.get(refactorId);
  if (!pending) return { status: 'not_found' };
  const { preview } = pending;

  if (Date.now() - preview.createdAt > REFACTOR_EXPIRY_MS) {
    pendingRefactors.delete(refactorId);
    return { status: 'expired' };
  }

  const root = path.resolve(repoRoot);
  const oldName = preview.oldName;

  try {
    // Group items by file and validate every path first.
    const byFile = new Map<string, { abs: string; items: RenameItem[] }>();
    for (const item of preview.items) {
      const abs = path.resolve(root, item.file);
      assertInsideRoot(root, abs);
      const entry = byFile.get(abs) ?? { abs, items: [] };
      entry.items.push(item);
      byFile.set(abs, entry);
    }

    // Verify before touching anything.
    const conflicts: RenameItem[] = [];
    const contents = new Map<string, { lines: string[]; eol: string }>();
    for (const { abs, items } of byFile.values()) {
      if (!fs.existsSync(abs)) {
        conflicts.push(...items);
        continue;
      }
      const raw = fs.readFileSync(abs, 'utf8');
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      const lines = splitLines(raw);
      contents.set(abs, { lines, eol });
      for (const item of items) {
        const text = lines[item.line - 1];
        const col = item.column - 1;
        if (text !== item.before || text.slice(col, col + oldName.length) !== oldName)
          conflicts.push(item);
      }
    }
    if (conflicts.length > 0) {
      return {
        status: 'error',
        error: `Aborted: ${conflicts.length} line(s) changed since the preview. Nothing was modified; re-run the preview.`,
        conflicts,
      };
    }

    // Write: per line, replace columns right to left.
    const written: string[] = [];
    let editsApplied = 0;
    for (const { abs, items } of byFile.values()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
      const { lines, eol } = contents.get(abs)!;
      const byLine = new Map<number, RenameItem[]>();
      for (const it of items) byLine.set(it.line, [...(byLine.get(it.line) ?? []), it]);
      for (const [ln, lineItems] of byLine) {
        let text = lines[ln - 1];
        for (const it of lineItems.sort((a, b) => b.column - a.column)) {
          const col = it.column - 1;
          text = text.slice(0, col) + preview.newName + text.slice(col + oldName.length);
          editsApplied++;
        }
        lines[ln - 1] = text;
      }
      fs.writeFileSync(abs, lines.join(eol), 'utf8');
      written.push(path.relative(root, abs));
    }

    pendingRefactors.delete(refactorId);
    return {
      status: 'applied',
      applied: true,
      filesModified: written.length,
      editsApplied,
      files: written,
      reparsed: false,
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * applyRefactor, then re-parse the touched files so the graph matches the new source.
 * Pass `db` (an initialised GraphDb for the same root); without it the graph is left stale.
 */
export async function applyRefactorAsync(
  refactorId: string,
  repoRoot: string,
  db?: GraphDb,
): Promise<ApplyResult> {
  const result = applyRefactor(refactorId, repoRoot);
  if (result.status !== 'applied' || !db) return result;
  const root = path.resolve(repoRoot);
  const abs = (result.files ?? []).map((f) => path.resolve(root, f));
  try {
    const pr = await new Parser(db, root).parseFiles(abs, true);
    for (const e of pr.errors) debug('refactor', `re-parse failed for ${e.filePath}: ${e.error}`);
    return { ...result, reparsed: pr.errors.length === 0 };
  } catch (e) {
    debug('refactor', 're-parse after apply failed', e);
    return { ...result, reparsed: false };
  }
}
