/**
 * Change detection mapped to graph nodes.
 * Maps git-level file changes to graph nodes, computes blast radius per file,
 * and produces a `ChangeAnalysis` with risk scoring.
 */

import * as fs from 'fs';
import type { GraphDb } from '../graph/db.js';
import type { GraphEngine } from '../graph/engine.js';
import type { GitChange } from './diff.js';
import { scoreFile, overallRisk, isTestFile, type FileRisk } from './risk.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileChangeDetail {
  file: GitChange;
  /** Number of graph nodes defined in this file */
  nodesAffected: number;
  /** Number of unique files in the transitive blast radius */
  blastRadius: number;
  riskScore: number;
  securityRelevant: boolean;
  /** True when at least one test file directly imports a node from this file */
  hasTests: boolean;
  riskFactors: FileRisk['factors'];
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyse a set of git changes against the code graph.
 *
 * For each changed file this function:
 * 1. Retrieves graph nodes defined in that file
 * 2. Computes blast radius via `engine.impact()`
 * 3. Checks whether any test file imports the changed nodes
 * 4. Scores the file using the risk model
 */
export function analyzeChanges(
  gitChanges: GitChange[],
  db: GraphDb,
  engine: GraphEngine,
): ChangeAnalysis {
  const summary = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    totalChangedLines: 0,
  };

  const details: FileChangeDetail[] = [];
  const allRiskScores: number[] = [];

  for (const change of gitChanges) {
    // Accumulate summary counters
    summary[change.status === 'renamed' ? 'renamed' : change.status]++;
    summary.totalChangedLines += change.linesAdded + change.linesRemoved;

    // ── Blast radius ─────────────────────────────────────────────────────────
    const fileNodes = db.getNodesByFile(change.filePath);
    const blastFileSet = new Set<string>();

    for (const node of fileNodes) {
      const impact = engine.impact(node.id);
      if (impact) {
        for (const entry of impact.affected) {
          if (entry.node.filePath !== change.filePath) {
            blastFileSet.add(entry.node.filePath);
          }
        }
      }
    }

    const blastRadius = blastFileSet.size;

    // ── Test coverage detection ────────────────────────────────────────────
    let hasTests = false;
    outer: for (const node of fileNodes) {
      const incomingEdges = db.getEdgesTo(node.id);
      for (const edge of incomingEdges) {
        const callerNode = db.getNode(edge.fromId);
        if (callerNode && isTestFile(callerNode.filePath)) {
          hasTests = true;
          break outer;
        }
      }
    }

    // ── Read file content for keyword scanning (best-effort) ───────────────
    let fileContent: string | undefined;
    try {
      if (change.status !== 'deleted' && fs.existsSync(change.filePath)) {
        fileContent = fs.readFileSync(change.filePath, 'utf-8');
      }
    } catch {
      // Non-fatal — keyword scoring will operate on path only
    }

    // ── Risk score ────────────────────────────────────────────────────────
    const linesChanged = change.linesAdded + change.linesRemoved;
    const risk = scoreFile(change.filePath, blastRadius, linesChanged, hasTests, fileContent);
    allRiskScores.push(risk.score);

    details.push({
      file: change,
      nodesAffected: fileNodes.length,
      blastRadius,
      riskScore: risk.score,
      securityRelevant: risk.securityRelevant,
      hasTests,
      riskFactors: risk.factors,
    });
  }

  // Sort by risk descending so callers can take the top N easily
  details.sort((a, b) => b.riskScore - a.riskScore);

  return {
    summary,
    changes: details,
    overallRisk: overallRisk(allRiskScores),
  };
}

/**
 * Collect unique blast-radius file paths across all changes in an analysis.
 */
export function collectBlastFiles(analysis: ChangeAnalysis, db: GraphDb): string[] {
  const changedSet = new Set(analysis.changes.map((c) => c.file.filePath));
  const blastSet = new Set<string>();

  for (const detail of analysis.changes) {
    const fileNodes = db.getNodesByFile(detail.file.filePath);
    for (const node of fileNodes) {
      // Re-derive blast radius to collect actual file paths
      const rows = db.getEdgesTo(node.id);
      for (const edge of rows) {
        const affector = db.getNode(edge.fromId);
        if (affector && !changedSet.has(affector.filePath)) {
          blastSet.add(affector.filePath);
        }
      }
    }
  }

  return Array.from(blastSet).sort();
}
