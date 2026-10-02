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
 *
 * Symbol targets (function/method/class node ids) get a focused bundle instead:
 * the symbol's own lines (capped), one-hop callers/callees as signatures, and
 * the file's imports. File targets get an outline, with full source only when
 * small. Nodes lacking line ranges fall back to the whole-file behaviour.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GraphDb } from '../graph/db.js';
import type { GraphEngine } from '../graph/engine.js';
import type { ContextBundle, BundleSection, GraphNode } from '../types.js';
import { debug } from '../util/log.js';

/** Rough token estimate: 1 token ≈ 4 characters */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface BundleOptions {
  /** How many levels of transitive dependencies to include */
  depth?: number;
  /** Include source code of the target (symbol lines or file source) */
  includeSource?: boolean;
  /** Max lines per dependency snippet (used when includeDependencySource is true) */
  maxDependencyLines?: number;
  /** Max lines of the target's own code before truncation (default 200) */
  maxTargetLines?: number;
  /** Include a (capped) source snippet for each direct dependency (default false) */
  includeDependencySource?: boolean;
}

const DEFAULT_OPTIONS: Required<BundleOptions> = {
  depth: 2,
  includeSource: true,
  maxDependencyLines: 30,
  maxTargetLines: 200,
  includeDependencySource: false,
};

const SYMBOL_KINDS = new Set(['function', 'method', 'class', 'interface']);
const NODE_ID_KINDS = [
  'function',
  'method',
  'class',
  'interface',
  'variable',
  'type',
  'enum',
  'file',
];
const MAX_NEIGHBOURS = 15;

export class BundleGenerator {
  constructor(
    private readonly db: GraphDb,
    private readonly engine: GraphEngine,
    private readonly projectRoot: string,
  ) {}

  /**
   * Generate a context bundle for a file path or a node ID.
   * Symbol node IDs (function/method/class/interface) with line ranges produce
   * a symbol-scoped bundle; anything else produces a file bundle.
   */
  generate(filePathOrNodeId: string, opts: BundleOptions = {}): ContextBundle {
    const options = { ...DEFAULT_OPTIONS, ...opts };

    const symbol = this.resolveSymbol(filePathOrNodeId);
    const hasRange =
      symbol !== null && symbol.startLine !== undefined && symbol.endLine !== undefined;
    const rootPath =
      symbol && !symbol.isExternal && symbol.filePath
        ? symbol.filePath
        : this.resolveTarget(filePathOrNodeId);

    const sections =
      symbol && hasRange
        ? this.generateSymbolSections(symbol, options)
        : this.generateFileSections(rootPath, options);

    // Filter empty sections
    const nonEmpty = sections.filter((s) => s.content.trim().length > 0);

    const lineCount = nonEmpty.reduce((n, s) => n + s.content.split('\n').length, 0);
    const charCount = nonEmpty.reduce((n, s) => n + s.content.length, 0);
    const sizeContent = `≈ ${lineCount} lines, ${charCount} chars`;
    nonEmpty.push({
      title: 'Size',
      content: sizeContent,
      tokenEstimate: estimateTokens(sizeContent),
    });

    const totalTokens = nonEmpty.reduce((sum, s) => sum + s.tokenEstimate, 0);

    return {
      generatedAt: new Date().toISOString(),
      rootFile: this.rel(rootPath),
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

  // ─── Bundle assembly ───────────────────────────────────────────────────────

  private generateFileSections(
    filePath: string,
    options: Required<BundleOptions>,
  ): BundleSection[] {
    const sections: BundleSection[] = [];
    const relPath = this.rel(filePath);

    sections.push(this.buildHeader(`**Target file:** \`${relPath}\``));
    sections.push(this.buildGraphOverview());
    sections.push(this.buildFileNodes(filePath, relPath));

    const fileNodeId = `file:${filePath}`;
    const depsResult = this.engine.deps(fileNodeId, options.depth);
    if (depsResult) {
      sections.push(this.buildDepsSection(depsResult.direct, depsResult.transitive, options));
    }

    sections.push(this.buildReverseImporters(fileNodeId));
    sections.push(this.buildClassHierarchy(filePath));

    if (options.includeSource && fs.existsSync(filePath)) {
      sections.push(this.buildSourceSection(filePath, relPath, options.maxTargetLines));
    }
    return sections;
  }

  private generateSymbolSections(
    symbol: GraphNode,
    options: Required<BundleOptions>,
  ): BundleSection[] {
    const sections: BundleSection[] = [];
    const filePath = symbol.filePath;
    const range = `${this.rel(filePath)}:${symbol.startLine}-${symbol.endLine}`;

    sections.push(this.buildHeader(`**Target:** ${symbol.kind} \`${symbol.name}\` — \`${range}\``));

    if (options.includeSource) {
      const code = this.symbolCode(symbol, options.maxTargetLines);
      if (code) sections.push(code);
    }

    const callers = this.engine.callers(symbol.id)?.callers ?? [];
    const callees = this.engine.callees(symbol.id)?.callees ?? [];
    sections.push(this.buildNeighbours('Callers', callers));
    sections.push(this.buildNeighbours('Callees', callees));

    if (symbol.kind === 'class' || symbol.kind === 'interface') {
      sections.push(this.buildClassHierarchy(filePath));
    }

    const depsResult = this.engine.deps(`file:${filePath}`, 1);
    if (depsResult) {
      sections.push(
        this.buildDepsSection(depsResult.direct, [], { ...options, depth: 1 }, 'Imports'),
      );
    }
    return sections;
  }

  // ─── Section builders ──────────────────────────────────────────────────────

  private buildHeader(targetLine: string): BundleSection {
    const stats = this.db.getStats();
    const content = [
      targetLine,
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

  /** File outline: signature, range and doc for each symbol (nested by range). */
  private buildFileNodes(filePath: string, relPath: string): BundleSection {
    const nodes = this.db.getNodesByFile(filePath).filter((n) => n.kind !== 'file');
    if (nodes.length === 0) {
      return {
        title: `Symbols in \`${relPath}\``,
        content: '_No symbols found._',
        tokenEstimate: 5,
      };
    }

    const ranged = nodes
      .filter((n) => n.startLine !== undefined && n.endLine !== undefined)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
      .sort((a, b) => a.startLine! - b.startLine! || b.endLine! - a.endLine!);
    const unranged = nodes.filter((n) => n.startLine === undefined || n.endLine === undefined);

    const lines: string[] = [];
    const stack: GraphNode[] = [];
    for (const node of ranged) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
      while (stack.length > 0 && stack[stack.length - 1].endLine! < node.startLine!) stack.pop();
      const indent = '  '.repeat(stack.length);
      const label = node.signature ?? `${node.kind} ${node.name}`;
      const doc = node.doc ? ` — ${node.doc}` : '';
      lines.push(`${indent}- \`${label}\` L${node.startLine}-${node.endLine}${doc}`);
      stack.push(node);
    }

    if (unranged.length > 0) {
      const grouped = this.groupByKind(unranged);
      for (const [kind, kindNodes] of Object.entries(grouped)) {
        lines.push(`**${capitalize(kind)}s**`);
        for (const node of kindNodes) {
          lines.push(`- \`${node.name}\` — ${node.description}`);
        }
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
    title = 'Dependencies',
  ): BundleSection {
    const lines: string[] = [];

    if (direct.length === 0) {
      return { title, content: '_No imports._', tokenEstimate: 3 };
    }

    lines.push(`**Direct imports** (${direct.length})`);
    for (const dep of direct) {
      const relDep = dep.isExternal ? dep.name : this.rel(dep.filePath);
      const rangeStr =
        !dep.isExternal && dep.startLine !== undefined && dep.endLine !== undefined
          ? `:${dep.startLine}-${dep.endLine}`
          : '';
      const sig = dep.signature ? ` \`${dep.signature}\`` : '';
      lines.push(
        `- \`${relDep}${rangeStr}\` [${dep.kind}]${sig}${dep.description ? ` — ${dep.description}` : ''}`,
      );
      if (options.includeDependencySource && !dep.isExternal) {
        const snippet = this.readRange(
          dep.filePath,
          dep.startLine ?? 1,
          dep.endLine,
          options.maxDependencyLines,
        );
        if (snippet) {
          const ext = path.extname(dep.filePath).slice(1);
          lines.push('', `\`\`\`${ext}\n${snippet.text}\n\`\`\``, '');
        }
      }
    }

    if (transitive.length > 0 && options.depth > 1) {
      lines.push('');
      lines.push(`**Transitive imports** (${transitive.length} total)`);
      const nonExternal = transitive.filter((n) => !n.isExternal).slice(0, 10);
      for (const dep of nonExternal) {
        lines.push(`- \`${this.rel(dep.filePath)}\``);
      }
      if (transitive.length > 10) {
        lines.push(`- _… and ${transitive.length - 10} more_`);
      }
    }

    const content = lines.join('\n');
    return { title, content, tokenEstimate: estimateTokens(content) };
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
      const relPath = from.isExternal ? from.name : this.rel(from.filePath);
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

  /** File source: whole file when small, else the first `maxLines` lines (the outline is a separate section). */
  private buildSourceSection(filePath: string, relPath: string, maxLines: number): BundleSection {
    const snippet = this.readRange(filePath, 1, undefined, maxLines);
    if (!snippet) return { title: `Source: \`${relPath}\``, content: '', tokenEstimate: 0 };
    const ext = path.extname(filePath).slice(1);
    const content = `\`\`\`${ext}\n${snippet.text}\n\`\`\``;
    return {
      title:
        snippet.more > 0
          ? `Source (first ${maxLines} lines): \`${relPath}\``
          : `Source: \`${relPath}\``,
      content,
      tokenEstimate: estimateTokens(content),
    };
  }

  private symbolCode(symbol: GraphNode, maxLines: number): BundleSection | null {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- value presence guaranteed by prior check/invariant
    const snippet = this.readRange(symbol.filePath, symbol.startLine!, symbol.endLine, maxLines);
    if (!snippet) return null;
    const ext = path.extname(symbol.filePath).slice(1);
    const content = `\`\`\`${ext}\n${snippet.text}\n\`\`\``;
    return {
      title: `Source: \`${this.rel(symbol.filePath)}:${symbol.startLine}-${symbol.endLine}\``,
      content,
      tokenEstimate: estimateTokens(content),
    };
  }

  private buildNeighbours(
    title: string,
    items: Array<{ node: GraphNode; reason: string }>,
  ): BundleSection {
    if (items.length === 0) {
      return { title, content: `_No ${title.toLowerCase()} found._`, tokenEstimate: 5 };
    }
    const lines: string[] = [];
    for (const { node, reason } of items.slice(0, MAX_NEIGHBOURS)) {
      const loc =
        node.isExternal || !node.filePath
          ? 'external'
          : node.startLine !== undefined && node.endLine !== undefined
            ? `${this.rel(node.filePath)}:${node.startLine}-${node.endLine}`
            : this.rel(node.filePath);
      const label =
        node.kind === 'file'
          ? `${this.rel(node.filePath)} (module-level)`
          : (node.signature ?? node.name);
      const doc = node.doc ? ` — ${node.doc}` : '';
      lines.push(`- \`${label}\` — \`${loc}\` (${reason})${doc}`);
    }
    if (items.length > MAX_NEIGHBOURS) {
      lines.push(`- _… and ${items.length - MAX_NEIGHBOURS} more_`);
    }
    const content = lines.join('\n');
    return { title: `${title} (${items.length})`, content, tokenEstimate: estimateTokens(content) };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Read lines [start, end] (1-based, inclusive; end defaults to EOF), capped
   * at `maxLines`. `more` is the number of lines cut off by the cap.
   */
  private readRange(
    filePath: string,
    start: number,
    end: number | undefined,
    maxLines: number,
  ): { text: string; more: number } | null {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      debug('bundle', `cannot read ${filePath}`, err);
      return null;
    }
    const all = source.split(/\r?\n/);
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    const from = Math.max(1, start);
    const to = Math.min(all.length, end ?? all.length);
    const slice = all.slice(from - 1, to);
    if (slice.length <= maxLines) return { text: slice.join('\n'), more: 0 };
    const more = slice.length - maxLines;
    return { text: `${slice.slice(0, maxLines).join('\n')}\n… (${more} more lines)`, more };
  }

  private rel(p: string): string {
    if (!p) return p;
    return path.relative(this.projectRoot, p).replace(/\\/g, '/');
  }

  /**
   * Resolve a target to a symbol node if it is (or embeds) a node id.
   * Callers (CLI) may have path-resolved the id against the project root, so
   * also try every `<kind>:` suffix of the string.
   */
  private resolveSymbol(target: string): GraphNode | null {
    const direct = this.db.getNode(target);
    if (direct && SYMBOL_KINDS.has(direct.kind)) return direct;
    for (const kind of NODE_ID_KINDS) {
      const idx = target.indexOf(`${kind}:`);
      if (idx <= 0) continue;
      const node = this.db.getNode(target.slice(idx));
      if (node && SYMBOL_KINDS.has(node.kind)) return node;
    }
    return null;
  }

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
