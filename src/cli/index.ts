#!/usr/bin/env node
/**
 * Code Graph Builder CLI
 * Usage: cgb <command> [options]
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';

// Lazy-loaded to avoid startup cost when printing help
async function getServices(root: string) {
  const { GraphDb } = await import('../graph/db.js');
  const { GraphEngine } = await import('../graph/engine.js');
  const { Parser } = await import('../parser/index.js');
  const { BundleGenerator } = await import('../bundle/generator.js');

  const db = new GraphDb(root);
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

// ─── CLI definition ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name('cgb')
  .description('Code Graph Builder — build and query a dependency graph for AI context bundles')
  .version('1.0.0');

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scan all source files in the project and build the initial graph')
  .option('-r, --root <path>', 'Project root directory (default: cwd)')
  .option('-f, --force', 'Force re-parse all files even if unchanged', false)
  .option('--watch', 'Keep watching for file changes after initial scan', false)
  .action(async (options: { root?: string; force: boolean; watch: boolean }) => {
    const root = resolveRoot(options);
    console.log(`📊 Initializing graph for: ${root}`);

    const { db, parser, engine } = await getServices(root);

    console.log('🔍 Scanning files…');
    const result = await parser.scanAll(options.force);

    const stats = db.getStats();
    console.log(`\n✅ Done in ${result.durationMs}ms`);
    console.log(`   Parsed:  ${result.parsed} files`);
    console.log(`   Skipped: ${result.skipped} files (unchanged)`);
    console.log(`   Errors:  ${result.errors.length} files`);
    console.log(`\n   Graph:   ${stats.files} files · ${stats.nodes} nodes · ${stats.edges} edges`);

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

    db.close();

    if (options.watch) {
      await startWatcher(root, parser, db);
    }
  });

// ─── deps ─────────────────────────────────────────────────────────────────────

program
  .command('deps <target>')
  .description('Show what a file or node depends on')
  .option('-r, --root <path>', 'Project root directory')
  .option('-d, --depth <n>', 'Traversal depth for transitive deps', '3')
  .option('--json', 'Output as JSON')
  .action(async (target: string, options: { root?: string; depth: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root);

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
  });

// ─── callers ──────────────────────────────────────────────────────────────────

program
  .command('callers <nodeId>')
  .description('Find all nodes that call a function or method')
  .option('-r, --root <path>', 'Project root directory')
  .option('--json', 'Output as JSON')
  .action(async (nodeId: string, options: { root?: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root);

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
  .option('-d, --depth <n>', 'Maximum traversal depth', '10')
  .option('--json', 'Output as JSON')
  .action(async (target: string, options: { root?: string; depth: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root);

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
  });

// ─── search ───────────────────────────────────────────────────────────────────

program
  .command('search <query>')
  .description('Search for nodes by name, description, or file path')
  .option('-r, --root <path>', 'Project root directory')
  .option('--json', 'Output as JSON')
  .action(async (query: string, options: { root?: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root);

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
  .option('--json', 'Output as JSON')
  .action(async (from: string, to: string, options: { root?: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root);

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
  });

// ─── bundle ───────────────────────────────────────────────────────────────────

program
  .command('bundle <target>')
  .description('Generate an AI-ready context bundle for a file')
  .option('-r, --root <path>', 'Project root directory')
  .option('-d, --depth <n>', 'Dependency traversal depth', '2')
  .option('--no-source', 'Exclude the source file from the bundle')
  .option('-o, --output <file>', 'Write bundle to a file instead of stdout')
  .option('--json', 'Output bundle structure as JSON instead of Markdown')
  .action(
    async (
      target: string,
      options: { root?: string; depth: string; source: boolean; output?: string; json: boolean },
    ) => {
      const root = resolveRoot(options);
      const { db, bundle } = await getServices(root);

      const absTarget = path.isAbsolute(target) ? target : path.resolve(root, target);
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
  .option('--json', 'Output as JSON')
  .action(async (options: { root?: string; json: boolean }) => {
    const root = resolveRoot(options);
    const { db, engine } = await getServices(root);

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

// ─── watch ────────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description('Watch for file changes and keep the graph up to date')
  .option('-r, --root <path>', 'Project root directory')
  .action(async (options: { root?: string }) => {
    const root = resolveRoot(options);
    const { db, parser } = await getServices(root);
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

// ─── mcp ──────────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Start the MCP server so Cursor / Claude Code can call cgb tools directly')
  .option('-r, --root <path>', 'Default project root (tools can override per-call)')
  .action(async (_options: { root?: string }) => {
    const { startMcpServer } = await import('../mcp/server.js');
    await startMcpServer();
  });

// ─── Entry point ──────────────────────────────────────────────────────────────

program.parse(process.argv);
