/**
 * Refactoring analysis module.
 *
 * Provides:
 * - Dead code detection: nodes with no inbound edges (unreachable from any caller/importer)
 * - Rename preview: show all edges affected by renaming a node, with concrete edits
 * - Apply refactor: apply a previously previewed rename to disk
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphDb } from '../graph/db.js';
import type { RefactorEdit, RefactorPreview, RefactorResult } from '../types.js';

export type { RefactorEdit, RefactorPreview, RefactorResult };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeadCodeResult {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  language: string | null;
  reason: string;
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

/** Escape special regex characters in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary pattern for an identifier.
 * Uses negative lookbehind/lookahead for word chars and $ to avoid
 * matching substrings (e.g. "Foo" won't hit "FooBar").
 */
function wordBoundaryPattern(name: string): RegExp {
  return new RegExp('(?<![\\w$])' + escapeRegex(name) + '(?![\\w$])', 'g');
}

// ─── Pending store ────────────────────────────────────────────────────────────

const pendingRefactors = new Map<string, RefactorPreview>();
const REFACTOR_EXPIRY_MS = 600_000; // 10 minutes

function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, preview] of pendingRefactors) {
    if (now - preview.createdAt > REFACTOR_EXPIRY_MS) {
      pendingRefactors.delete(id);
    }
  }
}

// ─── RefactorAnalyzer ─────────────────────────────────────────────────────────

export class RefactorAnalyzer {
  constructor(private readonly db: GraphDb) {}

  /**
   * Find dead code: exported symbols (functions, classes, methods) that
   * are not imported or called by any other node in the project.
   */
  deadCode(limit = 30): DeadCodeResult[] {
    const candidates = this.db.getNodesByKind(['function', 'method', 'class', 'interface', 'type']);
    const results: DeadCodeResult[] = [];

    for (const node of candidates) {
      if (node.isExternal) continue;

      const inbound = this.db.getEdgesTo(node.id);
      if (inbound.length > 0) continue;

      if (/\.(test|spec)\./i.test(node.filePath) || /\/(test|__tests?__|spec)\//i.test(node.filePath)) {
        continue;
      }

      results.push({
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        kind: node.kind,
        language: node.language,
        reason: 'No inbound calls or imports detected',
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
   * Preview a rename with concrete file edits. Stores the preview for later apply.
   * Returns a RefactorPreview with a refactorId that can be passed to applyRefactor().
   */
  renamePreviewWithEdits(nodeId: string, newName: string): RefactorPreview | null {
    cleanupExpired();

    const node = this.db.getNode(nodeId);
    if (!node) return null;

    const inbound = this.db.getEdgesTo(nodeId);
    const outbound = this.db.getEdgesFrom(nodeId);
    const allEdges = [...inbound, ...outbound];

    // Collect all files that reference this node (including the definition file)
    const fileSet = new Set<string>([node.filePath]);
    for (const edge of allEdges) {
      const from = this.db.getNode(edge.fromId);
      const to = this.db.getNode(edge.toId);
      if (from?.filePath) fileSet.add(from.filePath);
      if (to?.filePath) fileSet.add(to.filePath);
    }

    // Build edit list — try to parse line number from node meta
    let definitionLine: number | null = null;
    try {
      const meta = JSON.parse(node.meta ?? '{}') as Record<string, unknown>;
      if (typeof meta['line'] === 'number') definitionLine = meta['line'] as number;
      else if (typeof meta['line_start'] === 'number') definitionLine = meta['line_start'] as number;
    } catch {
      // ignore
    }

    const edits: RefactorEdit[] = [];
    for (const filePath of fileSet) {
      const isDefinition = filePath === node.filePath;
      edits.push({
        file: filePath,
        line: isDefinition ? definitionLine : null,
        old: node.name,
        new: newName,
        confidence: isDefinition ? 0.95 : 0.8,
      });
    }

    const refactorId = crypto.randomBytes(4).toString('hex');
    const preview: RefactorPreview = {
      refactorId,
      type: 'rename',
      oldName: node.name,
      newName,
      nodeId,
      edits,
      stats: { filesAffected: fileSet.size, occurrences: edits.length },
      createdAt: Date.now(),
    };

    pendingRefactors.set(refactorId, preview);
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
 * Apply a previously stored rename preview to disk.
 * @param refactorId  8-char hex from renamePreviewWithEdits()
 * @param repoRoot    Absolute path to repo root (used for path-traversal safety)
 */
export function applyRefactor(refactorId: string, repoRoot: string): RefactorResult {
  cleanupExpired();

  const preview = pendingRefactors.get(refactorId);
  if (!preview) {
    return { status: 'not_found' };
  }

  if (Date.now() - preview.createdAt > REFACTOR_EXPIRY_MS) {
    pendingRefactors.delete(refactorId);
    return { status: 'expired' };
  }

  const resolvedRoot = path.resolve(repoRoot);
  let filesModified = 0;
  let editsApplied = 0;

  try {
    // Group edits by file
    const byFile = new Map<string, RefactorEdit[]>();
    for (const edit of preview.edits) {
      // Path traversal check
      if (!path.resolve(edit.file).startsWith(resolvedRoot)) {
        return {
          status: 'error',
          error: `Path traversal attempt detected: ${edit.file}`,
        };
      }
      const list = byFile.get(edit.file) ?? [];
      list.push(edit);
      byFile.set(edit.file, list);
    }

    for (const [filePath, edits] of byFile) {
      if (!fs.existsSync(filePath)) continue;

      let content = fs.readFileSync(filePath, 'utf8');
      let fileChanged = false;

      for (const edit of edits) {
        const pattern = wordBoundaryPattern(edit.old);

        if (edit.line !== null) {
          // Line-targeted replace: replace all word-boundary occurrences on that line
          const lines = content.split('\n');
          const idx = edit.line - 1;
          if (idx >= 0 && idx < lines.length) {
            const replaced = lines[idx].replace(pattern, edit.new);
            if (replaced !== lines[idx]) {
              lines[idx] = replaced;
              content = lines.join('\n');
              fileChanged = true;
              editsApplied++;
              continue;
            }
          }
        }

        // Fallback: replace all word-boundary occurrences across the whole file
        const replaced = content.replace(pattern, edit.new);
        if (replaced !== content) {
          content = replaced;
          fileChanged = true;
          editsApplied++;
        }
      }

      if (fileChanged) {
        fs.writeFileSync(filePath, content, 'utf8');
        filesModified++;
      }
    }

    pendingRefactors.delete(refactorId);
    return { status: 'applied', applied: true, filesModified, editsApplied };
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}
