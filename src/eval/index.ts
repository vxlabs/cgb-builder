/**
 * Evaluation / benchmark harness for cgb-builder.
 *
 * Benchmark types
 *   build_performance   – wall-clock time and node/edge counts for graph init
 *   search_quality      – precision / recall against a golden search fixture
 *   impact_accuracy     – checks that known impact sets are a subset of computed ones
 *   flow_completeness   – checks entry-points were detected in known-entrypoint repos
 *   token_efficiency    – measures bundle token size vs full source file size
 *
 * OSS benchmark repos (cloned on demand into a temp dir)
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDb } from '../graph/db.js';
import { GraphEngine } from '../graph/engine.js';
import { FlowsAnalyzer } from '../flows/index.js';
import { Parser } from '../parser/index.js';
import { BundleGenerator } from '../bundle/generator.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BenchmarkKind =
  | 'build_performance'
  | 'search_quality'
  | 'impact_accuracy'
  | 'flow_completeness'
  | 'token_efficiency';

export interface RepoConfig {
  name: string;
  url: string;
  /** Commit/tag to pin for reproducibility */
  ref?: string;
  /** Known entry-point node names (for flow_completeness) */
  knownEntryPoints?: string[];
  /** Known impact sets: { changedFile: expectedAffectedFiles[] } */
  knownImpact?: Record<string, string[]>;
  /** Golden search fixtures: { query: expectedTopResult } */
  goldenSearch?: Record<string, string>;
}

export interface BenchmarkResult {
  repo: string;
  benchmark: BenchmarkKind;
  score: number;        // 0-1 for quality metrics, ms for timing
  detail: string;
  passed: boolean;
  durationMs: number;
}

export interface EvalReport {
  timestamp: string;
  results: BenchmarkResult[];
  summary: Record<BenchmarkKind, { count: number; passed: number; avgScore: number }>;
}

// ─── OSS Benchmark Repos ─────────────────────────────────────────────────────

export const BENCHMARK_REPOS: RepoConfig[] = [
  {
    name: 'expressjs',
    url: 'https://github.com/expressjs/express',
    ref: 'v4.18.2',
    knownEntryPoints: ['createApplication', 'Router'],
    goldenSearch: { express: 'index.js', 'middleware': 'lib/middleware/init.js' },
  },
  {
    name: 'fastapi',
    url: 'https://github.com/tiangolo/fastapi',
    ref: '0.104.1',
    knownEntryPoints: ['FastAPI', 'APIRouter'],
    goldenSearch: { 'routing': 'fastapi/routing.py', 'openapi': 'fastapi/openapi/utils.py' },
  },
  {
    name: 'flask',
    url: 'https://github.com/pallets/flask',
    ref: '3.0.0',
    knownEntryPoints: ['Flask', 'Blueprint'],
    goldenSearch: { 'app': 'src/flask/app.py' },
  },
  {
    name: 'gin',
    url: 'https://github.com/gin-gonic/gin',
    ref: 'v1.9.1',
    knownEntryPoints: ['Default', 'New'],
    goldenSearch: { 'router': 'routergroup.go' },
  },
  {
    name: 'httpx',
    url: 'https://github.com/encode/httpx',
    ref: '0.25.0',
    knownEntryPoints: ['Client', 'AsyncClient'],
    goldenSearch: { 'request': 'httpx/_client.py' },
  },
  {
    name: 'nextjs',
    url: 'https://github.com/vercel/next.js',
    ref: 'v14.0.1',
    knownEntryPoints: ['createServer', 'NextServer'],
    goldenSearch: { 'routing': 'packages/next/src/server/router.ts' },
  },
];

// ─── Harness ─────────────────────────────────────────────────────────────────

export class EvalHarness {
  private tmpDir: string;

  constructor(workDir?: string) {
    this.tmpDir = workDir ?? path.join(os.tmpdir(), 'cgb-eval');
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  /** Clone (or reuse) a repo and return its local path. */
  private prepareRepo(repo: RepoConfig): string {
    const dest = path.join(this.tmpDir, repo.name);
    if (!fs.existsSync(path.join(dest, '.git'))) {
      console.log(`  Cloning ${repo.url} …`);
      const args = ['clone', '--depth', '1'];
      if (repo.ref) args.push('--branch', repo.ref);
      args.push(repo.url, dest);
      const r = spawnSync('git', args, { encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error(`git clone failed: ${r.stderr}`);
      }
    }
    return dest;
  }

  /** Build the graph for a repo, returning the initialised db + durationMs. */
  private async buildGraph(repoPath: string): Promise<{ db: GraphDb; engine: GraphEngine; durationMs: number }> {
    const db = new GraphDb(repoPath);
    await db.init();
    const engine = new GraphEngine(db);
    const parser = new Parser(db, repoPath);
    const start = Date.now();
    await parser.scanAll(true);
    return { db, engine, durationMs: Date.now() - start };
  }

  // ─── Individual benchmarks ──────────────────────────────────────────────────

  async runBuildPerformance(repo: RepoConfig, repoPath: string): Promise<BenchmarkResult> {
    const start = Date.now();
    const { db, durationMs } = await this.buildGraph(repoPath);
    const stats = db.getStats();
    return {
      repo: repo.name,
      benchmark: 'build_performance',
      score: durationMs,
      detail: `${stats.nodes} nodes, ${stats.edges} edges in ${durationMs}ms`,
      passed: durationMs < 120_000,
      durationMs: Date.now() - start,
    };
  }

  async runSearchQuality(repo: RepoConfig, repoPath: string): Promise<BenchmarkResult> {
    const start = Date.now();
    const { db } = await this.buildGraph(repoPath);
    const golden = repo.goldenSearch ?? {};
    const queries = Object.keys(golden);
    if (queries.length === 0) {
      return { repo: repo.name, benchmark: 'search_quality', score: 1, detail: 'no golden fixtures', passed: true, durationMs: 0 };
    }
    let hits = 0;
    for (const [query, expected] of Object.entries(golden)) {
      const results = db.searchNodes(query);
      const found = results.slice(0, 10).some(n =>
        (n.filePath?.includes(expected) ?? false) || (n.name?.includes(expected) ?? false),
      );
      if (found) hits++;
    }
    const score = hits / queries.length;
    return {
      repo: repo.name,
      benchmark: 'search_quality',
      score,
      detail: `${hits}/${queries.length} golden queries hit`,
      passed: score >= 0.5,
      durationMs: Date.now() - start,
    };
  }

  async runImpactAccuracy(repo: RepoConfig, repoPath: string): Promise<BenchmarkResult> {
    const start = Date.now();
    const { db, engine } = await this.buildGraph(repoPath);
    const known = repo.knownImpact ?? {};
    const entries = Object.entries(known);
    if (entries.length === 0) {
      return { repo: repo.name, benchmark: 'impact_accuracy', score: 1, detail: 'no known impact fixtures', passed: true, durationMs: 0 };
    }
    let totalRecall = 0;
    for (const [changed, expected] of entries) {
      // Find the node id for the changed file
      const fileNodes = db.getNodesByFile(changed);
      const nodeId = fileNodes[0]?.id ?? `file:${path.join(repoPath, changed)}`;
      const result = engine.impact(nodeId);
      const impactedPaths = result?.affected.map(a => a.node.filePath ?? '') ?? [];
      const found = expected.filter(e => impactedPaths.some(p => p.includes(e)));
      totalRecall += expected.length > 0 ? found.length / expected.length : 1;
    }
    const score = totalRecall / entries.length;
    return {
      repo: repo.name,
      benchmark: 'impact_accuracy',
      score,
      detail: `avg recall ${(score * 100).toFixed(1)}% across ${entries.length} fixtures`,
      passed: score >= 0.6,
      durationMs: Date.now() - start,
    };
  }

  async runFlowCompleteness(repo: RepoConfig, repoPath: string): Promise<BenchmarkResult> {
    const start = Date.now();
    await this.buildGraph(repoPath);
    const expected = repo.knownEntryPoints ?? [];
    if (expected.length === 0) {
      return { repo: repo.name, benchmark: 'flow_completeness', score: 1, detail: 'no known entry-point fixtures', passed: true, durationMs: 0 };
    }
    // Re-open the db that was just built
    const db = new GraphDb(repoPath);
    await db.init();
    const analyzer = new FlowsAnalyzer(db);
    const flows = analyzer.entryPoints();
    const foundEntryNames = flows.map((f: { name: string }) => f.name);
    const hits = expected.filter(e => foundEntryNames.some((n: string) => n.includes(e)));
    const score = hits.length / expected.length;
    return {
      repo: repo.name,
      benchmark: 'flow_completeness',
      score,
      detail: `${hits.length}/${expected.length} known entry-points detected`,
      passed: score >= 0.5,
      durationMs: Date.now() - start,
    };
  }

  async runTokenEfficiency(repo: RepoConfig, repoPath: string): Promise<BenchmarkResult> {
    const start = Date.now();
    const { db, engine } = await this.buildGraph(repoPath);
    const allNodes = db.getAllNodes();
    const sampleNode = allNodes.find(n => n.kind === 'function' || n.kind === 'class');
    if (!sampleNode) {
      return { repo: repo.name, benchmark: 'token_efficiency', score: 1, detail: 'no sample node found', passed: true, durationMs: 0 };
    }
    const bundleGen = new BundleGenerator(db, engine, repoPath);
    const bundleResult = bundleGen.generate(sampleNode.filePath, { depth: 2, includeSource: true });
    const bundleMarkdown = bundleGen.render(bundleResult);
    const bundleTokens = Math.ceil(bundleMarkdown.length / 4);
    let sourceTokens = bundleTokens * 3;
    const fullPath = path.join(repoPath, sampleNode.filePath);
    if (fs.existsSync(fullPath)) {
      const src = fs.readFileSync(fullPath, 'utf8');
      sourceTokens = Math.ceil(src.length / 4);
    }
    const ratio = sourceTokens > 0 ? bundleTokens / sourceTokens : 1;
    const score = Math.max(0, 1 - ratio);
    return {
      repo: repo.name,
      benchmark: 'token_efficiency',
      score,
      detail: `bundle=${bundleTokens} tokens vs source=${sourceTokens} tokens (ratio=${ratio.toFixed(2)})`,
      passed: ratio <= 0.8,
      durationMs: Date.now() - start,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async runBenchmark(
    benchmark: BenchmarkKind,
    repoNames: string[],
  ): Promise<BenchmarkResult[]> {
    const repos = repoNames.length > 0
      ? BENCHMARK_REPOS.filter(r => repoNames.includes(r.name))
      : BENCHMARK_REPOS;

    const results: BenchmarkResult[] = [];
    for (const repo of repos) {
      let repoPath: string;
      try {
        repoPath = this.prepareRepo(repo);
      } catch (e) {
        console.warn(`  Skipping ${repo.name}: ${(e as Error).message}`);
        continue;
      }
      console.log(`  Running ${benchmark} on ${repo.name} …`);
      try {
        let result: BenchmarkResult;
        switch (benchmark) {
          case 'build_performance':  result = await this.runBuildPerformance(repo, repoPath); break;
          case 'search_quality':     result = await this.runSearchQuality(repo, repoPath); break;
          case 'impact_accuracy':    result = await this.runImpactAccuracy(repo, repoPath); break;
          case 'flow_completeness':  result = await this.runFlowCompleteness(repo, repoPath); break;
          case 'token_efficiency':   result = await this.runTokenEfficiency(repo, repoPath); break;
          default: throw new Error(`Unknown benchmark: ${benchmark}`);
        }
        results.push(result);
      } catch (e) {
        results.push({
          repo: repo.name,
          benchmark,
          score: 0,
          detail: `error: ${(e as Error).message}`,
          passed: false,
          durationMs: 0,
        });
      }
    }
    return results;
  }

  async runAll(repoNames: string[] = []): Promise<EvalReport> {
    const allBenchmarks: BenchmarkKind[] = [
      'build_performance', 'search_quality', 'impact_accuracy',
      'flow_completeness', 'token_efficiency',
    ];
    const results: BenchmarkResult[] = [];
    for (const b of allBenchmarks) {
      const r = await this.runBenchmark(b, repoNames);
      results.push(...r);
    }
    return this.buildReport(results);
  }

  buildReport(results: BenchmarkResult[]): EvalReport {
    const kinds: BenchmarkKind[] = [
      'build_performance', 'search_quality', 'impact_accuracy',
      'flow_completeness', 'token_efficiency',
    ];
    const summary = {} as EvalReport['summary'];
    for (const k of kinds) {
      const subset = results.filter(r => r.benchmark === k);
      summary[k] = {
        count: subset.length,
        passed: subset.filter(r => r.passed).length,
        avgScore: subset.length ? subset.reduce((a, r) => a + r.score, 0) / subset.length : 0,
      };
    }
    return { timestamp: new Date().toISOString(), results, summary };
  }

  // ─── Formatters ─────────────────────────────────────────────────────────────

  toCsv(report: EvalReport): string {
    const header = 'repo,benchmark,score,passed,detail,durationMs';
    const rows = report.results.map(r =>
      `${r.repo},${r.benchmark},${r.score.toFixed(4)},${r.passed},"${r.detail.replace(/"/g, '""')}",${r.durationMs}`,
    );
    return [header, ...rows].join('\n');
  }

  toMarkdown(report: EvalReport): string {
    const lines: string[] = [];
    lines.push(`# CGB Evaluation Report`);
    lines.push(`\nGenerated: ${report.timestamp}\n`);
    lines.push('## Summary\n');
    lines.push('| Benchmark | Tests | Passed | Avg Score |');
    lines.push('|-----------|-------|--------|-----------|');
    for (const [k, v] of Object.entries(report.summary)) {
      lines.push(`| ${k} | ${v.count} | ${v.passed} | ${v.avgScore.toFixed(4)} |`);
    }
    lines.push('\n## Detailed Results\n');
    lines.push('| Repo | Benchmark | Score | Passed | Detail |');
    lines.push('|------|-----------|-------|--------|--------|');
    for (const r of report.results) {
      const icon = r.passed ? '✅' : '❌';
      lines.push(`| ${r.repo} | ${r.benchmark} | ${r.score.toFixed(4)} | ${icon} | ${r.detail} |`);
    }
    return lines.join('\n');
  }
}
