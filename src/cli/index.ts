#!/usr/bin/env node
/**
 * Code Graph Builder CLI
 * Usage: cgb <command> [options]
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';

// Lazy-loaded to avoid startup cost when printing help
async function getServices(root: string, dbDir?: string) {
  const { GraphDb } = await import('../graph/db.js');
  const { GraphEngine } = await import('../graph/engine.js');
  const { Parser } = await import('../parser/index.js');
  const { BundleGenerator } = await import('../bundle/generator.js');

  const db = new GraphDb(root, { dbDir });
  await db.init();
  const engine = new GraphEngine(db);
  const parser = new Parser(db, root);
  const bundle = new BundleGenerator(db, engine, root);

  return { db, engine, parser, bundle };
}

function resolveRoot(options: { root?: string }): string {
  const root = options.root ?? process.cwd();
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) {
    console.error(`Error: Root directory does not exist: ${abs}`);
    process.exit(1);
  }
  return abs;
}

function readVersion(): string {
  try {
    // dist/cli -> package root, and src/cli -> package root under ts-node
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- JSON outside rootDir; read at runtime
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── CLI definition ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name('cgb')
  .description('Code Graph Builder — build and query a dependency graph for AI context bundles')
  .version(readVersion());

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command('init [path]')
  .description('Scan all source files in the project and build the initial graph')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-f, --force', 'Force re-parse all files even if unchanged', false)
  .option('--watch', 'Keep watching for file changes after initial scan', false)
  .action(
    async (
      pathArg: string | undefined,
      options: { root?: string; dbDir?: string; force: boolean; watch: boolean },
    ) => {
      const root = resolveRoot({ root: options.root ?? pathArg });
      console.log(`📊 Initializing graph for: ${root}`);

      const { db, parser, engine } = await getServices(root, options.dbDir);

      console.log('🔍 Scanning files…');
      const result = await parser.scanAll(options.force);

      const stats = db.getStats();
      console.log(`\n✅ Done in ${result.durationMs}ms`);
      console.log(`   Parsed:  ${result.parsed} files`);
      console.log(`   Skipped: ${result.skipped} files (unchanged)`);
      console.log(`   Errors:  ${result.errors.length} files`);
      console.log(
        `\n   Graph:   ${stats.files} files · ${stats.nodes} nodes · ${stats.edges} edges`,
      );

      if (result.errors.length > 0) {
        console.log('\nErrors:');
        for (const e of result.errors.slice(0, 10)) {
          console.log(`  ✗ ${e.filePath}: ${e.error}`);
        }
      }

      // Print layer overview
      const layers = engine.layers();
      if (layers.length > 0) {
        console.log('\nArchitectural layers:');
        for (const layer of layers.slice(0, 8)) {
          console.log(`  ${layer.layer.padEnd(20)} ${layer.nodeCount} files`);
        }
      }

      if (options.watch) {
        // Keep the DB open: the watcher's parser writes through it.
        await startWatcher(root, parser, db);
      } else {
        db.close();
      }
    },
  );

// ─── deps ─────────────────────────────────────────────────────────────────────

program
  .command('deps <target>')
  .description('Show what a file or node depends on')
  .option('-r, --root <path>', 'Project root directory')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-d, --depth <n>', 'Traversal depth for transitive deps', '3')
  .option('--json', 'Output as JSON')
  .action(
    async (
      target: string,
      options: { root?: string; dbDir?: string; depth: string; json: boolean },
    ) => {
      const root = resolveRoot(options);
      const { db, engine } = await getServices(root, options.dbDir);

      const absTarget = path.isAbsolute(target) ? target : path.resolve(root, target);
      const nodeId = `file:${absTarget}`;
      const result = engine.deps(nodeId, parseInt(options.depth, 10));

      if (!result) {
        console.error(`Node not found: ${target}`);
        console.error('Run `cgb init` first to build the graph.');
        db.close();
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const rel = path.relative(root, result.target.filePath);
        console.log(`\nDependencies of \`${rel}\`:`);
        console.log(`\nDirect (${result.direct.length}):`);
        for (const dep of result.direct) {
          const label = dep.isExternal ? `[ext] ${dep.name}` : path.relative(root, dep.filePath);
          console.log(`  → ${label}`);
        }
        if (result.transitive.length > 0) {
          console.log(`\nTransitive (${result.transitive.length}):`);
          for (const dep of result.transitive.filter((n) => !n.isExternal).slice(0, 15)) {
            console.log(`  ⇒ ${path.relative(root, dep.filePath)}`);
          }
        }
      }
      db.close();
    },
  );

// ─── callers ──────────────────────────────────────────────────────────────────

program
  .command('callers <nodeId>')
  .description('Find all nodes that call a function or method')
  .option('-r, --root <path>', 'Project root directory')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('--json', 'Output as JSON')
  .action(async (nodeId: string, options: { root?: string; dbDir?: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root, options.dbDir);

    const result = engine.callers(nodeId);
    if (!result) {
      console.error(`Node not found: ${nodeId}`);
      db.close();
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nCallers of \`${result.target.name}\`:`);
      if (result.callers.length === 0) {
        console.log('  (none found)');
      } else {
        for (const c of result.callers) {
          const rel = c.node.isExternal ? c.node.name : path.relative(root, c.node.filePath);
          console.log(`  ← ${c.node.name} in ${rel} — ${c.reason}`);
        }
      }
    }
    db.close();
  });

// ─── impact ───────────────────────────────────────────────────────────────────

program
  .command('impact <target>')
  .description('Show what would be affected if a file changes')
  .option('-r, --root <path>', 'Project root directory')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-d, --depth <n>', 'Maximum traversal depth', '10')
  .option('--json', 'Output as JSON')
  .action(
    async (
      target: string,
      options: { root?: string; dbDir?: string; depth: string; json: boolean },
    ) => {
      const root = resolveRoot(options);
      const { db, engine } = await getServices(root, options.dbDir);

      const absTarget = path.isAbsolute(target) ? target : path.resolve(root, target);
      const nodeId = `file:${absTarget}`;
      const result = engine.impact(nodeId, parseInt(options.depth, 10));

      if (!result) {
        console.error(`Node not found: ${target}`);
        db.close();
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const rel = path.relative(root, result.target.filePath);
        console.log(`\nImpact analysis for \`${rel}\`:`);
        console.log(`${result.affected.length} file(s) would be affected:\n`);
        for (const a of result.affected) {
          const prefix = '  '.repeat(a.depth);
          const nodeRel = path.relative(root, a.node.filePath);
          console.log(`${prefix}↑ depth ${a.depth}: ${nodeRel}`);
        }
      }
      db.close();
    },
  );

// ─── search ───────────────────────────────────────────────────────────────────

program
  .command('search <query>')
  .description('Search for nodes by name, description, or file path')
  .option('-r, --root <path>', 'Project root directory')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('--json', 'Output as JSON')
  .action(async (query: string, options: { root?: string; dbDir?: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root, options.dbDir);

    const results = engine.search(query);

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`\nSearch results for "${query}" (${results.length}):\n`);
      for (const node of results) {
        const relPath = node.isExternal ? node.name : path.relative(root, node.filePath);
        console.log(`  [${node.kind}] ${node.name}`);
        console.log(`    ${relPath}`);
        if (node.description) console.log(`    ${node.description}`);
        console.log('');
      }
    }
    db.close();
  });

// ─── path ─────────────────────────────────────────────────────────────────────

program
  .command('path <from> <to>')
  .description('Find the shortest dependency path between two files')
  .option('-r, --root <path>', 'Project root directory')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('--json', 'Output as JSON')
  .action(
    async (from: string, to: string, options: { root?: string; dbDir?: string; json: boolean }) => {
      const root = resolveRoot(options);
      const { db, engine } = await getServices(root, options.dbDir);

      const absFrom = path.isAbsolute(from) ? from : path.resolve(root, from);
      const absTo = path.isAbsolute(to) ? to : path.resolve(root, to);
      const result = engine.path(`file:${absFrom}`, `file:${absTo}`);

      if (!result) {
        console.log(`No dependency path found between\n  ${from}\n  ${to}`);
        db.close();
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('\nDependency path:');
        for (let i = 0; i < result.path.length; i++) {
          const node = result.path[i];
          const relPath = node.isExternal ? node.name : path.relative(root, node.filePath);
          const edge = result.edges[i];
          console.log(`  ${i === 0 ? '' : `[${edge?.kind ?? ''}] `}${relPath}`);
        }
      }
      db.close();
    },
  );

// ─── bundle ───────────────────────────────────────────────────────────────────

program
  .command('bundle <target>')
  .description('Generate an AI-ready context bundle for a file')
  .option('-r, --root <path>', 'Project root directory')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-d, --depth <n>', 'Dependency traversal depth', '2')
  .option('--no-source', 'Exclude the source file from the bundle')
  .option('-o, --output <file>', 'Write bundle to a file instead of stdout')
  .option('--json', 'Output bundle structure as JSON instead of Markdown')
  .action(
    async (
      target: string,
      options: {
        root?: string;
        dbDir?: string;
        depth: string;
        source: boolean;
        output?: string;
        json: boolean;
      },
    ) => {
      const root = resolveRoot(options);
      const { db, bundle } = await getServices(root, options.dbDir);

      // Node ids ("function:C:\\...#name", "external_dep:...") must not be path-resolved.
      const isNodeId =
        /^[a-z_]+:/.test(target) && (target.includes('#') || target.startsWith('external_dep:'));
      const absTarget = isNodeId || path.isAbsolute(target) ? target : path.resolve(root, target);
      const result = bundle.generate(absTarget, {
        depth: parseInt(options.depth, 10),
        includeSource: options.source !== false,
      });

      let output: string;
      if (options.json) {
        output = JSON.stringify(result, null, 2);
      } else {
        const { BundleGenerator } = await import('../bundle/generator.js');
        output = new BundleGenerator(
          db,
          await import('../graph/engine.js').then((m) => new m.GraphEngine(db)),
          root,
        ).render(result);
      }

      if (options.output) {
        fs.writeFileSync(options.output, output, 'utf-8');
        console.log(`Bundle written to: ${options.output}`);
        console.log(`Estimated tokens: ~${result.totalTokenEstimate}`);
      } else {
        console.log(output);
        process.stderr.write(`\n# ~${result.totalTokenEstimate} tokens\n`);
      }

      db.close();
    },
  );

// ─── stats ────────────────────────────────────────────────────────────────────

program
  .command('stats')
  .description('Show graph statistics')
  .option('-r, --root <path>', 'Project root directory')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('--json', 'Output as JSON')
  .action(async (options: { root?: string; dbDir?: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root, options.dbDir);

    const stats = db.getStats();
    const byKind = db.getNodeCountByKind();
    const layers = engine.layers();
    const cycles = engine.detectCycles();
    const orphans = engine.orphans();

    if (options.json) {
      console.log(
        JSON.stringify(
          { stats, byKind, layers, cycleCount: cycles.length, orphanCount: orphans.length },
          null,
          2,
        ),
      );
    } else {
      console.log('\n📊 Graph Statistics\n');
      console.log(`  Files:  ${stats.files}`);
      console.log(`  Nodes:  ${stats.nodes}`);
      console.log(`  Edges:  ${stats.edges}`);
      console.log(`\nNode types:`);
      for (const [kind, count] of Object.entries(byKind)) {
        console.log(`  ${kind.padEnd(15)} ${count}`);
      }
      console.log(`\nCycles detected: ${cycles.length}`);
      console.log(`Orphan nodes:    ${orphans.length}`);
      console.log(`\nLayers (by file count):`);
      for (const layer of layers.slice(0, 10)) {
        console.log(`  ${layer.layer.padEnd(20)} ${layer.nodeCount} files`);
      }
    }
    db.close();
  });

// ─── detect-changes ───────────────────────────────────────────────────────────

program
  .command('detect-changes')
  .description('Detect git changes and analyse their blast radius in the code graph')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-b, --base <ref>', 'Base git ref to diff against (default: HEAD~1)', 'HEAD~1')
  .option('--json', 'Output as JSON')
  .action(async (options: { root?: string; dbDir?: string; base: string; json: boolean }) => {
    const root = resolveRoot(options);

    const { isGitRepo, getGitChanges } = await import('../git/diff.js');
    if (!isGitRepo(root)) {
      console.error(`Error: Not a git repository: ${root}`);
      process.exit(1);
    }

    const gitChanges = await getGitChanges(root, options.base);
    if (gitChanges.length === 0) {
      console.log(`No changes found between ${options.base} and HEAD`);
      return;
    }

    const { db, engine } = await getServices(root, options.dbDir);
    const { analyzeChanges } = await import('../git/changes.js');
    const analysis = analyzeChanges(gitChanges, db, engine);
    db.close();

    if (options.json) {
      console.log(JSON.stringify(analysis, null, 2));
      return;
    }

    const { riskBand } = await import('../git/risk.js');
    const overallBand = analysis.overallRisk;
    const bandIcon = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[overallBand];

    // Compute aggregate blast radius (unique files across all changes)
    const { collectBlastFiles } = await import('../git/changes.js');
    const blastFiles = collectBlastFiles(analysis, db);
    const testFiles = analysis.changes.filter((c) => c.hasTests);

    console.log(
      `\n${bandIcon} Change analysis — overall risk: ${analysis.overallRisk} (${overallBand})\n`,
    );
    console.log(`  Changed files:   ${analysis.changes.length}`);
    console.log(`  Blast radius:    ${blastFiles.length} files`);
    console.log(`  With tests:      ${testFiles.length}\n`);

    if (analysis.changes.length > 0) {
      console.log('Changed files (by risk score):');
      // already sorted descending by analyzeChanges
      for (const c of analysis.changes.slice(0, 15)) {
        const band = riskBand(c.riskScore);
        const icon = { low: '○', medium: '◐', high: '●', critical: '◉' }[band];
        const rel = path.relative(root, c.file.filePath);
        const status = c.file.status.padEnd(8);
        const lines = `+${c.file.linesAdded}/-${c.file.linesRemoved}`;
        const blast = c.blastRadius > 0 ? ` blast:${c.blastRadius}` : '';
        console.log(
          `  ${icon} [${c.riskScore.toString().padStart(3)}] ${status} ${rel.padEnd(50)} ${lines}${blast}`,
        );
      }
    }
  });

// ─── review-context ───────────────────────────────────────────────────────────

program
  .command('review-context')
  .description('Build a focused code-review context (changed files, affected files, tests, risk)')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-b, --base <ref>', 'Base git ref to diff against (default: HEAD~1)', 'HEAD~1')
  .option('-f, --format <type>', 'Output format: markdown or json', 'markdown')
  .option('-o, --output <file>', 'Write output to a file instead of stdout')
  .action(
    async (options: {
      root?: string;
      dbDir?: string;
      base: string;
      format: string;
      output?: string;
    }) => {
      const root = resolveRoot(options);

      const { isGitRepo } = await import('../git/diff.js');
      if (!isGitRepo(root)) {
        console.error(`Error: Not a git repository: ${root}`);
        process.exit(1);
      }

      const { db, engine } = await getServices(root, options.dbDir);
      const { buildReviewContext, formatReviewContext } = await import('../git/review-context.js');

      let ctx;
      try {
        ctx = await buildReviewContext(root, db, engine, options.base);
      } finally {
        db.close();
      }

      let output: string;
      if (options.format === 'json') {
        // Deterministic: arrays sorted, no timestamps, paths relative to the root.
        const { relativizePaths } = await import('../portable.js');
        output = JSON.stringify(relativizePaths(ctx, root), null, 2);
      } else {
        output = formatReviewContext(ctx);
      }

      if (options.output) {
        fs.writeFileSync(options.output, output, 'utf-8');
        console.log(`Review context written to: ${options.output}`);
        process.stderr.write(`~${ctx.tokenEstimate} tokens\n`);
      } else {
        console.log(output);
        if (options.format !== 'json') {
          process.stderr.write(`\n# ~${ctx.tokenEstimate} tokens\n`);
        }
      }
    },
  );

// ─── communities ──────────────────────────────────────────────────────────────

program
  .command('communities')
  .description('Detect module communities (weighted Louvain) from the code graph')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('--top <n>', 'Only show the N largest communities')
  .option('--overview', 'Show the architecture overview (layers, cycles, coupling, health) instead')
  .option('--json', 'Output as JSON')
  .action(
    async (options: {
      root?: string;
      dbDir?: string;
      top?: string;
      overview?: boolean;
      json?: boolean;
    }) => {
      const root = resolveRoot(options);
      const { db, engine } = await getServices(root, options.dbDir);
      try {
        const { CommunityDetector } = await import('../communities/index.js');
        const { relativizePaths } = await import('../portable.js');
        const detector = new CommunityDetector(db, engine);
        const top = options.top !== undefined ? parseInt(options.top, 10) : undefined;
        const limit = top !== undefined && top > 0 ? top : undefined;

        if (options.overview) {
          const overview = detector.overview();
          if (limit) overview.communities = overview.communities.slice(0, limit);
          if (options.json) {
            console.log(JSON.stringify(relativizePaths(overview, root), null, 2));
          } else {
            console.log(`\nArchitecture overview (health ${overview.healthScore}/100)`);
            console.log(
              `  Files: ${overview.totalFiles}  Nodes: ${overview.totalNodes}  Communities: ${overview.communities.length}`,
            );
            console.log(`  Cycles: ${overview.cycles.length}  Orphans: ${overview.orphans.length}`);
            for (const note of overview.healthNotes) console.log(`  - ${note}`);
            for (const c of overview.communities) {
              console.log(
                `\n  ${c.label} [${c.role}] ${c.nodeCount} nodes, ${c.files.length} files`,
              );
            }
          }
          return;
        }

        let communities = detector.detect();
        if (limit) communities = communities.slice(0, limit);
        if (options.json) {
          console.log(JSON.stringify(relativizePaths(communities, root), null, 2));
        } else {
          console.log(`\nCommunities (${communities.length}):\n`);
          for (const c of communities) {
            console.log(
              `  ${c.label} [${c.role}] — ${c.nodeCount} nodes, ${c.files.length} files, cohesion ${(c.cohesion ?? 0).toFixed(2)}`,
            );
          }
        }
      } finally {
        db.close();
      }
    },
  );

// ─── flows ────────────────────────────────────────────────────────────────────

program
  .command('flows')
  .description('Entry points, critical nodes and call chains')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('--top <n>', 'Max entries per list', '20')
  .option('--chain <entry>', 'Trace the call chain from this node id or file path instead')
  .option('--depth <n>', 'Max depth for --chain', '5')
  .option('--json', 'Output as JSON')
  .action(
    async (options: {
      root?: string;
      dbDir?: string;
      top: string;
      chain?: string;
      depth: string;
      json?: boolean;
    }) => {
      const root = resolveRoot(options);
      const { db } = await getServices(root, options.dbDir);
      try {
        const { FlowsAnalyzer } = await import('../flows/index.js');
        const { relativizePaths } = await import('../portable.js');
        const flows = new FlowsAnalyzer(db);
        const top = Math.max(1, parseInt(options.top, 10) || 20);

        if (options.chain) {
          let nodeId = options.chain;
          if (!db.getNode(nodeId)) {
            const abs = path.isAbsolute(nodeId) ? nodeId : path.resolve(root, nodeId);
            if (db.getNode(`file:${abs}`)) nodeId = `file:${abs}`;
            else {
              const hit = db.searchNodes(options.chain).find((n) => n.name === options.chain);
              if (hit) nodeId = hit.id;
            }
          }
          if (!db.getNode(nodeId)) {
            console.error(`Node not found: ${options.chain}`);
            process.exitCode = 1;
            return;
          }
          const chain = flows.callChain(nodeId, parseInt(options.depth, 10) || 5);
          if (options.json) console.log(JSON.stringify(relativizePaths(chain, root), null, 2));
          else
            for (const s of chain)
              console.log(`${'  '.repeat(s.depth)}${s.name} (${path.relative(root, s.filePath)})`);
          return;
        }

        const result = {
          entryPoints: flows.entryPoints(top),
          criticalNodes: flows.criticalityScores(top),
          largeFunctions: (await import('../flows/index.js')).findLargeFunctions(db, top),
        };
        if (options.json) {
          console.log(JSON.stringify(relativizePaths(result, root), null, 2));
        } else {
          console.log(`\nEntry points (${result.entryPoints.length}):`);
          for (const e of result.entryPoints)
            console.log(`  ${e.name}  fan-out ${e.fanOut}  ${path.relative(root, e.filePath)}`);
          console.log(`\nCritical nodes (${result.criticalNodes.length}):`);
          for (const c of result.criticalNodes)
            console.log(
              `  [${c.label}] ${c.name}  score ${c.score}  ${path.relative(root, c.filePath)}`,
            );
        }
      } finally {
        db.close();
      }
    },
  );

// ─── watch ────────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description('Watch for file changes and keep the graph up to date')
  .option('-r, --root <path>', 'Project root directory')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .action(async (options: { root?: string; dbDir?: string }) => {
    const root = resolveRoot(options);
    const { db, parser } = await getServices(root, options.dbDir);
    await startWatcher(root, parser, db);
  });

// ─── Watcher helper ───────────────────────────────────────────────────────────

async function startWatcher(
  root: string,
  parser: import('../parser/index.js').Parser,
  db: import('../graph/db.js').GraphDb,
): Promise<void> {
  const { Watcher } = await import('../watcher/index.js');
  const watcher = new Watcher(root, parser, {
    onUpdate: ({ parsed, errors, files }) => {
      const now = new Date().toLocaleTimeString();
      console.log(
        `[${now}] Updated ${parsed} file(s) | ${errors} error(s) | ${files.map((f) => path.relative(root, f)).join(', ')}`,
      );
    },
    onError: (err) => console.error('Watcher error:', err.message),
  });

  watcher.start();
  console.log(`👁  Watching for changes in: ${root}`);
  console.log('    Press Ctrl+C to stop.\n');

  // Keep process alive
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- untyped third-party/dynamic value; behaviour unchanged
  process.on('SIGINT', async () => {
    console.log('\nStopping watcher…');
    await watcher.stop();
    db.close();
    process.exit(0);
  });

  // Prevent process from exiting
  await new Promise(() => {
    /* intentionally never resolves */
  });
}

// ─── install ──────────────────────────────────────────────────────────────────

program
  .command('install')
  .description('Auto-configure MCP for Cursor, Claude Code, or a custom config path')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option(
    '--platform <name>',
    'Target: claude-code | claude (alias of claude-code) | claude-desktop | cursor | vscode (auto-detected if omitted)',
  )
  .option('--mcp-path <path>', 'Explicit path to write the MCP config JSON')
  .option('--skill', 'Also generate a Cursor skill snippet at .cursor/skills/cgb/SKILL.md', false)
  .option(
    '--hook',
    'claude-code: add a PostToolUse hook to .claude/settings.json (others: cgb:watch script)',
    false,
  )
  .option('--claude-md', 'claude-code: insert a cgb usage guide block into CLAUDE.md', false)
  .action(
    async (options: {
      root?: string;
      platform?: string;
      mcpPath?: string;
      skill: boolean;
      hook: boolean;
      claudeMd: boolean;
    }) => {
      const { runInstall } = await import('./install.js');
      await runInstall({ ...options, root: resolveRoot(options) });
    },
  );

// ─── update ───────────────────────────────────────────────────────────────────

program
  .command('update [files...]')
  .description('Re-parse only the given files (missing files are removed from the graph)')
  .option('-r, --root <path>', 'Project root directory')
  .option('--from-hook', 'Read Claude Code hook JSON from stdin; silent, always exits 0', false)
  .action(async (files: string[], options: { root?: string; fromHook: boolean }) => {
    const { runUpdate } = await import('./install.js');
    if (options.fromHook) {
      try {
        await runUpdate({
          root: path.resolve(options.root ?? process.cwd()),
          files: [],
          fromHook: true,
        });
      } catch {
        /* never block Claude's edit; runUpdate already logs under CGB_DEBUG */
      }
      process.exit(0);
    }
    const n = await runUpdate({ root: resolveRoot(options), files });
    console.log(`Updated ${n} file(s)`);
  });

// ─── wiki ─────────────────────────────────────────────────────────────────────

program
  .command('wiki')
  .description('Generate a Markdown wiki from the code graph communities')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-o, --output <dir>', 'Output directory for wiki pages (default: <root>/wiki)')
  .option(
    '--json',
    'Print [{communityId, title, files, markdown}] to stdout instead of writing files',
  )
  .action(async (options: { root?: string; dbDir?: string; output?: string; json?: boolean }) => {
    const root = resolveRoot(options);
    const outputDir = options.output ?? path.join(root, 'wiki');

    const { GraphDb } = await import('../graph/db.js');
    const { CommunityDetector } = await import('../communities/index.js');
    const { WikiGenerator } = await import('../wiki/index.js');

    const db = new GraphDb(root, { dbDir: options.dbDir });
    await db.init();

    const { GraphEngine } = await import('../graph/engine.js');
    const engine = new GraphEngine(db);
    const detector = new CommunityDetector(db, engine);
    const gen = new WikiGenerator(db, detector);

    if (options.json) {
      console.log(JSON.stringify(gen.generateJson(root), null, 2));
      db.close();
      return;
    }

    const written = gen.writeToDir(outputDir);
    console.log(`\n✅ Wiki written to: ${outputDir}`);
    console.log(`   ${written.length} page(s) generated:`);
    written.forEach((f) => console.log(`   - ${path.relative(root, f)}`));
  });

// ─── registry ─────────────────────────────────────────────────────────────────

const registryCmd = program.command('registry').description('Multi-repo registry management');

registryCmd
  .command('register [name]')
  .description('Register the current project in the global cgb registry')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .action(async (name: string | undefined, options: { root?: string }) => {
    const root = resolveRoot(options);
    const { RegistryManager } = await import('../registry/index.js');
    const mgr = new RegistryManager();
    const entry = mgr.register(name ?? path.basename(root), root);
    console.log(`✅ Registered "${entry.name}" → ${entry.root}`);
  });

registryCmd
  .command('unregister <nameOrRoot>')
  .description('Remove a project from the global registry')
  .action(async (nameOrRoot: string) => {
    const { RegistryManager } = await import('../registry/index.js');
    const removed = new RegistryManager().unregister(nameOrRoot);
    if (removed) console.log(`✅ Removed "${nameOrRoot}" from registry`);
    else console.error(`Not found in registry: ${nameOrRoot}`);
  });

registryCmd
  .command('list')
  .description('List all registered projects')
  .action(async () => {
    const { RegistryManager } = await import('../registry/index.js');
    const entries = new RegistryManager().load();
    if (!entries.length) {
      console.log('Registry is empty.');
      return;
    }
    entries.forEach((e) =>
      console.log(`  ${e.name.padEnd(30)} ${e.root}  (last seen: ${e.lastSeen})`),
    );
  });

registryCmd
  .command('search <query>')
  .description('Search across all registered project graphs')
  .option('--max-per-repo <n>', 'Max results per repo (default: 10)', '10')
  .action(async (query: string, options: { maxPerRepo: string }) => {
    const { RegistryManager } = await import('../registry/index.js');
    const results = await new RegistryManager().search(query, parseInt(options.maxPerRepo, 10));
    if (!results.length) {
      console.log('No results.');
      return;
    }
    results.forEach((r) => console.log(`  [${r.repo}] [${r.kind}] ${r.name}\n    ${r.filePath}\n`));
  });

// ─── refactor ─────────────────────────────────────────────────────────────────

const refactorCmd = program.command('refactor').description('Refactoring analysis tools');

refactorCmd
  .command('dead-code')
  .description('List functions/classes with no inbound references (dead code)')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-l, --limit <n>', 'Max results (default: 30)', '30')
  .action(async (options: { root?: string; dbDir?: string; limit: string }) => {
    const root = resolveRoot(options);
    const { GraphDb } = await import('../graph/db.js');
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    const db = new GraphDb(root, { dbDir: options.dbDir });
    await db.init();
    const results = new RefactorAnalyzer(db).deadCode(parseInt(options.limit, 10));
    if (!results.length) {
      console.log('No dead code detected.');
      return;
    }
    console.log(`Dead code (${results.length}):\n`);
    results.forEach((r) =>
      console.log(`  [${r.kind}] ${r.name}\n    ${r.filePath}\n    ${r.reason}\n`),
    );
  });

refactorCmd
  .command('rename-preview <nodeId>')
  .description('Preview the blast-radius of renaming a node')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .action(async (nodeId: string, options: { root?: string; dbDir?: string }) => {
    const root = resolveRoot(options);
    const { GraphDb } = await import('../graph/db.js');
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    const db = new GraphDb(root, { dbDir: options.dbDir });
    await db.init();
    const preview = new RefactorAnalyzer(db).renamePreview(nodeId);
    if (!preview) {
      console.error(`Node not found: ${nodeId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(preview, null, 2));
  });

refactorCmd
  .command('suggest')
  .description('Get structural refactoring suggestions')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-l, --limit <n>', 'Max suggestions (default: 10)', '10')
  .action(async (options: { root?: string; dbDir?: string; limit: string }) => {
    const root = resolveRoot(options);
    const { GraphDb } = await import('../graph/db.js');
    const { RefactorAnalyzer } = await import('../refactor/index.js');
    const db = new GraphDb(root, { dbDir: options.dbDir });
    await db.init();
    const suggestions = new RefactorAnalyzer(db).suggestions(parseInt(options.limit, 10));
    if (!suggestions.length) {
      console.log('No suggestions.');
      return;
    }
    console.log(`Refactor suggestions (${suggestions.length}):\n`);
    suggestions.forEach((s) =>
      console.log(
        `  [${s.type}] ${s.targetName} — ${s.reason}\n    Fan-in: ${s.fanIn}, Fan-out: ${s.fanOut}\n    ${s.filePath}\n`,
      ),
    );
  });

// ─── visualize ────────────────────────────────────────────────────────────────

program
  .command('visualize')
  .alias('viz')
  .description('Generate a self-contained D3 HTML graph and optionally serve it over HTTP')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option('-o, --output <path>', 'Output HTML file (default: <root>/graph.html)')
  .option('--title <title>', 'Title shown in the HTML header')
  .option('--serve', 'After generating, start an HTTP server and open the file', false)
  .option('--port <number>', 'Port for --serve mode (default: 3737)', '3737')
  .action(
    async (options: {
      root?: string;
      dbDir?: string;
      output?: string;
      title?: string;
      serve: boolean;
      port: string;
    }) => {
      const root = resolveRoot(options);
      const output = options.output ?? path.join(root, 'graph.html');
      const port = parseInt(options.port, 10);

      const { GraphDb } = await import('../graph/db.js');
      const { GraphEngine } = await import('../graph/engine.js');
      const { generateVisualization, serveVisualization } = await import('../viz/index.js');

      const db = new GraphDb(root, { dbDir: options.dbDir });
      await db.init();
      const engine = new GraphEngine(db);
      const title = options.title ?? path.basename(root);

      generateVisualization(db, { output, title, engine });
      console.log(`✅ Graph written to: ${output}`);

      if (options.serve) {
        const server = serveVisualization(db, { port, title, engine });
        server.on('listening', () => {
          console.log(`🌐 Serving at http://${process.env.CGB_VIZ_HOST ?? '127.0.0.1'}:${port}`);
          console.log('   Press Ctrl+C to stop.');
        });
        await new Promise<void>((_, reject) => server.on('error', reject));
      }
    },
  );

// ─── eval ─────────────────────────────────────────────────────────────────────

const evalCmd = program.command('eval').description('Run evaluation benchmarks against OSS repos');

evalCmd
  .command('run [benchmark]')
  .description(
    'Run a benchmark (build_performance | search_quality | impact_accuracy | ' +
      'flow_completeness | token_efficiency) or all benchmarks if omitted',
  )
  .option('--repos <names>', 'Comma-separated list of repo names to include (default: all)')
  .option('--work-dir <path>', 'Working directory for cloned repos (default: OS temp dir)')
  .option('--csv <file>', 'Write CSV report to this file path')
  .option('--md <file>', 'Write Markdown report to this file path')
  .action(
    async (
      benchmark: string | undefined,
      options: { repos?: string; workDir?: string; csv?: string; md?: string },
    ) => {
      const { EvalHarness, BENCHMARK_REPOS } = await import('../eval/index.js');
      const harness = new EvalHarness(options.workDir);
      const repoNames = options.repos ? options.repos.split(',').map((s) => s.trim()) : [];

      console.log('🔬 CGB Evaluation Harness');
      console.log(
        `   Repos : ${repoNames.length > 0 ? repoNames.join(', ') : 'all (' + BENCHMARK_REPOS.length + ')'}`,
      );
      console.log(`   Benchmark: ${benchmark ?? 'all'}\n`);

      let report;
      if (benchmark) {
        const results = await harness.runBenchmark(
          benchmark as Parameters<typeof harness.runBenchmark>[0],
          repoNames,
        );
        report = harness.buildReport(results);
      } else {
        report = await harness.runAll(repoNames);
      }

      // Print summary table
      console.log('\n📊 Summary\n');
      console.log('Benchmark            Tests  Passed  Avg Score');
      console.log('─────────────────────────────────────────────');
      for (const [k, v] of Object.entries(report.summary)) {
        const pct = (v.avgScore * 100).toFixed(1).padStart(6);
        console.log(
          `${k.padEnd(20)}  ${String(v.count).padStart(5)}  ${String(v.passed).padStart(6)}  ${pct}%`,
        );
      }
      const total = report.results.length;
      const passed = report.results.filter((r) => r.passed).length;
      console.log(`\n✅ Passed ${passed}/${total} benchmarks`);

      if (options.csv) {
        fs.writeFileSync(options.csv, harness.toCsv(report), 'utf8');
        console.log(`\n📄 CSV report → ${options.csv}`);
      }
      if (options.md) {
        fs.writeFileSync(options.md, harness.toMarkdown(report), 'utf8');
        console.log(`📝 Markdown report → ${options.md}`);
      }
    },
  );

evalCmd
  .command('list-repos')
  .description('List all configured OSS benchmark repos')
  .action(async () => {
    const { BENCHMARK_REPOS } = await import('../eval/index.js');
    console.log('Configured benchmark repos:\n');
    for (const r of BENCHMARK_REPOS) {
      console.log(`  ${r.name.padEnd(12)} ${r.url}${r.ref ? `  @${r.ref}` : ''}`);
    }
  });

// ─── mcp ──────────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Start the MCP server so Cursor / Claude Code can call cgb tools directly')
  .option('-r, --root <path>', 'Default project root (tools can override per-call)')
  .option('--db-dir <path>', 'Directory for graph.db (default: env CGB_DB_DIR or <root>/.cgb)')
  .option(
    '--read-only',
    'Serve only non-mutating tools; never write the DB or the filesystem',
    false,
  )
  .action(async (options: { root?: string; dbDir?: string; readOnly?: boolean }) => {
    if (options.root) process.env['CGB_ROOT'] = path.resolve(options.root);
    const { startMcpServer } = await import('../mcp/server.js');
    await startMcpServer({ readOnly: options.readOnly, dbDir: options.dbDir, root: options.root });
  });

// ─── Entry point ──────────────────────────────────────────────────────────────

program.parse(process.argv);
