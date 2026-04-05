/**
 * Review context builder.
 * Assembles a `ReviewContext` by combining git change detection, graph
 * blast-radius analysis, and risk scoring into a focused review brief.
 */

import type { GraphDb } from '../graph/db.js';
import type { GraphEngine } from '../graph/engine.js';
import { getGitChanges } from './diff.js';
import { analyzeChanges, collectBlastFiles, type ChangeAnalysis } from './changes.js';
import { isTestFile } from './risk.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewContext {
  /** Git-diff range used (e.g. "HEAD~1..HEAD") */
  base: string;
  /** Files directly modified in the diff */
  changedFiles: string[];
  /** Files in the transitive blast radius (not directly changed) */
  affectedFiles: string[];
  /** Test files that import at least one changed file's nodes */
  relevantTests: string[];
  /** Full risk analysis for each changed file */
  riskSummary: ChangeAnalysis;
  /** Highest-risk files the reviewer should look at first */
  focusAreas: string[];
  /** Rough token estimate (chars ÷ 4) for all file paths in context */
  tokenEstimate: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a complete review context for the given repository root.
 *
 * @param root  Absolute path to the repository root
 * @param db    Initialised GraphDb instance
 * @param engine GraphEngine instance backed by the same db
 * @param base  Git base ref (default `HEAD~1`)
 */
export async function buildReviewContext(
  root: string,
  db: GraphDb,
  engine: GraphEngine,
  base = 'HEAD~1',
): Promise<ReviewContext> {
  // ── 1. Gather git changes ─────────────────────────────────────────────────
  const gitChanges = await getGitChanges(root, base);

  // ── 2. Analyse against graph ──────────────────────────────────────────────
  const analysis = analyzeChanges(gitChanges, db, engine);

  // ── 3. Build changed-file list ────────────────────────────────────────────
  const changedFiles = gitChanges.map((c) => c.filePath);
  const changedSet = new Set(changedFiles);

  // ── 4. Blast radius: files affected but not directly changed ──────────────
  const blastFiles = collectBlastFiles(analysis, db);
  const affectedFiles = blastFiles.filter((f) => !changedSet.has(f));

  // ── 5. Relevant test files ────────────────────────────────────────────────
  const testSet = new Set<string>();
  for (const changedFile of changedFiles) {
    const nodes = db.getNodesByFile(changedFile);
    for (const node of nodes) {
      const incomingEdges = db.getEdgesTo(node.id);
      for (const edge of incomingEdges) {
        const caller = db.getNode(edge.fromId);
        if (caller && isTestFile(caller.filePath) && !changedSet.has(caller.filePath)) {
          testSet.add(caller.filePath);
        }
      }
    }
  }
  const relevantTests = Array.from(testSet).sort();

  // ── 6. Focus areas: top-N highest-risk files ──────────────────────────────
  const FOCUS_LIMIT = 5;
  const focusAreas = analysis.changes
    .filter((d) => d.riskScore >= 25) // only notable risk
    .slice(0, FOCUS_LIMIT)
    .map((d) => d.file.filePath);

  // ── 7. Token estimate ─────────────────────────────────────────────────────
  const allPaths = [...changedFiles, ...affectedFiles, ...relevantTests];
  const tokenEstimate = Math.ceil(allPaths.join('\n').length / 4);

  return {
    base: `${base}..HEAD`,
    changedFiles,
    affectedFiles,
    relevantTests,
    riskSummary: analysis,
    focusAreas,
    tokenEstimate,
  };
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Render a `ReviewContext` as a human-readable Markdown brief.
 */
export function formatReviewContext(ctx: ReviewContext): string {
  const lines: string[] = [
    `# Code Review Context`,
    ``,
    `**Diff range**: \`${ctx.base}\`  `,
    `**Overall risk**: \`${ctx.riskSummary.overallRisk.toUpperCase()}\`  `,
    `**Token estimate**: ~${ctx.tokenEstimate.toLocaleString()}`,
    ``,
  ];

  // Summary counters
  const s = ctx.riskSummary.summary;
  lines.push(
    `## Change Summary`,
    ``,
    `| Status   | Count |`,
    `|----------|-------|`,
    `| Added    | ${s.added} |`,
    `| Modified | ${s.modified} |`,
    `| Deleted  | ${s.deleted} |`,
    `| Renamed  | ${s.renamed} |`,
    `| Lines ±  | ${s.totalChangedLines} |`,
    ``,
  );

  // Focus areas
  if (ctx.focusAreas.length > 0) {
    lines.push(`## ⚠️ Focus Areas (highest risk)`, ``);
    for (const f of ctx.focusAreas) {
      lines.push(`- \`${f}\``);
    }
    lines.push(``);
  }

  // Per-file risk table
  lines.push(`## File Risk Breakdown`, ``, `| File | Risk | Blast | Tests |`, `|------|------|-------|-------|`);
  for (const d of ctx.riskSummary.changes) {
    const short = d.file.filePath.split(/[\\/]/).slice(-2).join('/');
    const emoji = d.riskScore >= 75 ? '🔴' : d.riskScore >= 50 ? '🟠' : d.riskScore >= 25 ? '🟡' : '🟢';
    lines.push(
      `| \`${short}\` | ${emoji} ${d.riskScore} | ${d.blastRadius} files | ${d.hasTests ? '✓' : '✗'} |`,
    );
  }
  lines.push(``);

  // Affected files
  if (ctx.affectedFiles.length > 0) {
    lines.push(`## Blast Radius (${ctx.affectedFiles.length} files)`, ``);
    for (const f of ctx.affectedFiles.slice(0, 20)) {
      lines.push(`- \`${f}\``);
    }
    if (ctx.affectedFiles.length > 20) {
      lines.push(`- *…and ${ctx.affectedFiles.length - 20} more*`);
    }
    lines.push(``);
  }

  // Relevant tests
  if (ctx.relevantTests.length > 0) {
    lines.push(`## Relevant Tests (${ctx.relevantTests.length})`, ``);
    for (const t of ctx.relevantTests) {
      lines.push(`- \`${t}\``);
    }
    lines.push(``);
  }

  return lines.join('\n');
}
