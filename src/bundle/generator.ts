/**
 * AI Context Bundle Generator.
 *
 * Generates a compact, AI-optimized Markdown document from the graph that
 * contains exactly the context needed for a task — no more, no less.
 *
 * Bundle anatomy:
 *  1. Header — project root, generated-at, root file
 *  2. Graph overview — stats, layers
 *  3. Target file summary — nodes in this file
 *  4. Direct dependencies — what this file imports (signatures only)
 *  5. Reverse dependencies — who imports this file (impact surface)
 *  6. Call chain — functions called and their call graph
 *  7. Inheritance hierarchy — class/interface relationships
 *  8. Source file — actual source of the root file
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GraphDb } from '../graph/db.js';
import type { GraphEngine } from '../graph/engine.js';
import type { ContextBundle, BundleSection, GraphNode } from '../types.js';

/** Rough token estimate: 1 token ≈ 4 characters */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface BundleOptions {
  /** How many levels of transitive dependencies to include */
  depth?: number;
  /** Include the full source of the root file */
  includeSource?: boolean;
  /** Max lines to include from dependent files */
  maxDependencyLines?: number;
}

const DEFAULT_OPTIONS: Required<BundleOptions> = {
  depth: 2,
  includeSource: true,
  maxDependencyLines: 30,
};

export class BundleGenerator {
  constructor(
    private readonly db: GraphDb,
    private readonly engine: GraphEngine,
    private readonly projectRoot: string,
  ) {}

  /**
   * Generate a context bundle for a given file or node ID.
   */
  generate(filePathOrNodeId: string, opts: BundleOptions = {}): ContextBundle {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const sections: BundleSection[] = [];

    // Resolve to an absolute file path
    const filePath = this.resolveTarget(filePathOrNodeId);
    const relPath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');

    // ── 1. Header ─────────────────────────────────────────────────────────────
    sections.push(this.buildHeader(relPath));

    // ── 2. Graph overview ────────────────────────────────────────────────────
    sections.push(this.buildGraphOverview());

    // ── 3. Target file nodes ─────────────────────────────────────────────────
    sections.push(this.buildFileNodes(filePath, relPath));

    // ── 4. Direct imports ────────────────────────────────────────────────────
    const fileNodeId = `file:${filePath}`;
    const depsResult = this.engine.deps(fileNodeId, options.depth);
    if (depsResult) {
      sections.push(this.buildDepsSection(depsResult.direct, depsResult.transitive, options));
    }

    // ── 5. Who imports this file (reverse impact) ────────────────────────────
    sections.push(this.buildReverseImporters(fileNodeId));

    // ── 6. Class hierarchy ───────────────────────────────────────────────────
    sections.push(this.buildClassHierarchy(filePath));

    // ── 7. Source file ───────────────────────────────────────────────────────
    if (options.includeSource && fs.existsSync(filePath)) {
      sections.push(this.buildSourceSection(filePath, relPath));
    }

    // Filter empty sections
    const nonEmpty = sections.filter((s) => s.content.trim().length > 0);
    const totalTokens = nonEmpty.reduce((sum, s) => sum + s.tokenEstimate, 0);

    return {
      generatedAt: new Date().toISOString(),
      rootFile: relPath,
      totalTokenEstimate: totalTokens,
      sections: nonEmpty,
    };
  }

  /**
   * Render a bundle to a Markdown string ready for injection into an AI prompt.
   */
  render(bundle: ContextBundle): string {
    const lines: string[] = [
      `<!-- CODE GRAPH BUNDLE | ${bundle.rootFile} | ${bundle.generatedAt} | ~${bundle.totalTokenEstimate} tokens -->`,
      '',
    ];

    for (const section of bundle.sections) {
      lines.push(`## ${section.title}`);
      lines.push('');
      lines.push(section.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ─── Section builders ──────────────────────────────────────────────────────

  private buildHeader(relPath: string): BundleSection {
    const stats = this.db.getStats();
    const content = [
      `**Target file:** \`${relPath}\``,
      `**Project root:** \`${this.projectRoot}\``,
      `**Graph:** ${stats.files} files · ${stats.nodes} nodes · ${stats.edges} edges`,
    ].join('\n');

    return { title: 'Context Bundle', content, tokenEstimate: estimateTokens(content) };
  }

  private buildGraphOverview(): BundleSection {
    const layers = this.engine.layers();
    if (layers.length === 0) {
      return { title: 'Architecture Layers', content: '_No layers detected._', tokenEstimate: 5 };
    }

    const lines = ['| Layer | Files | Node Types |', '|-------|-------|-----------|'];
    for (const layer of layers.slice(0, 12)) {
      const kindStr = Object.entries(layer.kinds)
        .filter(([k]) => k !== 'file')
        .map(([k, c]) => `${k}:${c}`)
        .join(', ');
      lines.push(`| \`${layer.layer}\` | ${layer.nodeCount} | ${kindStr || '—'} |`);
    }
    const content = lines.join('\n');
    return { title: 'Architecture Layers', content, tokenEstimate: estimateTokens(content) };
  }

  private buildFileNodes(filePath: string, relPath: string): BundleSection {
    const nodes = this.db.getNodesByFile(filePath).filter((n) => n.kind !== 'file');
    if (nodes.length === 0) {
      return {
        title: `Symbols in \`${relPath}\``,
        content: '_No symbols found._',
        tokenEstimate: 5,
      };
    }

    const lines: string[] = [];
    const grouped = this.groupByKind(nodes);

    for (const [kind, kindNodes] of Object.entries(grouped)) {
      lines.push(`**${capitalize(kind)}s**`);
      for (const node of kindNodes) {
        lines.push(`- \`${node.name}\` — ${node.description}`);
      }
    }

    const content = lines.join('\n');
    return {
      title: `Symbols in \`${relPath}\``,
      content,
      tokenEstimate: estimateTokens(content),
    };
  }

  private buildDepsSection(
    direct: GraphNode[],
    transitive: GraphNode[],
    options: Required<BundleOptions>,
  ): BundleSection {
    const lines: string[] = [];

    if (direct.length === 0) {
      return { title: 'Dependencies', content: '_No imports._', tokenEstimate: 3 };
    }

    lines.push(`**Direct imports** (${direct.length})`);
    for (const dep of direct) {
      const relDep = dep.isExternal
        ? dep.name
        : path.relative(this.projectRoot, dep.filePath).replace(/\\/g, '/');
      lines.push(`- \`${relDep}\` [${dep.kind}]${dep.description ? ` — ${dep.description}` : ''}`);
    }

    if (transitive.length > 0 && options.depth > 1) {
      lines.push('');
      lines.push(`**Transitive imports** (${transitive.length} total)`);
      const nonExternal = transitive.filter((n) => !n.isExternal).slice(0, 10);
      for (const dep of nonExternal) {
        const relDep = path.relative(this.projectRoot, dep.filePath).replace(/\\/g, '/');
        lines.push(`- \`${relDep}\``);
      }
      if (transitive.length > 10) {
        lines.push(`- _… and ${transitive.length - 10} more_`);
      }
    }

    const content = lines.join('\n');
    return { title: 'Dependencies', content, tokenEstimate: estimateTokens(content) };
  }

  private buildReverseImporters(fileNodeId: string): BundleSection {
    const edges = this.db.getEdgesToByKind(fileNodeId, 'imports');
    if (edges.length === 0) {
      return {
        title: 'Imported By',
        content: '_Not imported by any tracked file._',
        tokenEstimate: 5,
      };
    }

    const lines = [`**${edges.length} file(s) import this module:**`];
    for (const edge of edges.slice(0, 20)) {
      const from = this.db.getNode(edge.fromId);
      if (!from) continue;
      const relPath = from.isExternal
        ? from.name
        : path.relative(this.projectRoot, from.filePath).replace(/\\/g, '/');
      lines.push(`- \`${relPath}\` — ${edge.reason}`);
    }
    if (edges.length > 20) {
      lines.push(`- _… and ${edges.length - 20} more_`);
    }

    const content = lines.join('\n');
    return { title: 'Imported By', content, tokenEstimate: estimateTokens(content) };
  }

  private buildClassHierarchy(filePath: string): BundleSection {
    const classNodes = this.db
      .getNodesByFile(filePath)
      .filter((n) => n.kind === 'class' || n.kind === 'interface');

    if (classNodes.length === 0) {
      return { title: 'Class Hierarchy', content: '', tokenEstimate: 0 };
    }

    const lines: string[] = [];
    for (const cls of classNodes) {
      // Find what this class inherits
      const inheritsEdges = this.db.getEdgesFromByKind(cls.id, 'inherits');
      const implementsEdges = this.db.getEdgesFromByKind(cls.id, 'implements');
      // Find what implements/extends this
      const subclasses = this.db.getEdgesToByKind(cls.id, 'inherits');

      lines.push(`**\`${cls.name}\`** [${cls.kind}]`);
      for (const e of inheritsEdges) {
        const parent = this.db.getNode(e.toId);
        lines.push(`  ↑ extends \`${parent?.name ?? e.toId}\``);
      }
      for (const e of implementsEdges) {
        const iface = this.db.getNode(e.toId);
        lines.push(`  ↑ implements \`${iface?.name ?? e.toId}\``);
      }
      for (const e of subclasses) {
        const child = this.db.getNode(e.fromId);
        lines.push(`  ↓ extended by \`${child?.name ?? e.fromId}\``);
      }
    }

    const content = lines.join('\n');
    return { title: 'Class Hierarchy', content, tokenEstimate: estimateTokens(content) };
  }

  private buildSourceSection(filePath: string, relPath: string): BundleSection {
    const source = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath).slice(1);
    const content = `\`\`\`${ext}\n${source}\n\`\`\``;
    return {
      title: `Source: \`${relPath}\``,
      content,
      tokenEstimate: estimateTokens(content),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private resolveTarget(target: string): string {
    if (path.isAbsolute(target)) return target;
    return path.resolve(this.projectRoot, target);
  }

  private groupByKind(nodes: GraphNode[]): Record<string, GraphNode[]> {
    const groups: Record<string, GraphNode[]> = {};
    for (const node of nodes) {
      if (!groups[node.kind]) groups[node.kind] = [];
      groups[node.kind].push(node);
    }
    return groups;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
