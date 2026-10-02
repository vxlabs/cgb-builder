/**
 * viz/index.ts — Generate a self-contained interactive D3 graph HTML page
 * with multiple views (graph, stats, tree), detail panels, and file explorer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import type { GraphDb } from '../graph/db.js';
import type { GraphEngine } from '../graph/engine.js';

// ─── Serialisable types ────────────────────────────────────────────────────────

export interface VizNode {
  id: string;
  label: string;
  kind: string;
  file: string;
  group: number;
  description: string;
  language: string | null;
  isExternal: boolean;
  fanIn: number;
  fanOut: number;
  communityId: number | null;
  meta: string;
}

export interface VizEdge {
  source: string;
  target: string;
  kind: string;
  reason: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  children?: FileTreeNode[];
  nodeCount?: number;
}

export interface VizStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  languageBreakdown: Record<string, number>;
  topConnected: Array<{ id: string; label: string; kind: string; total: number }>;
  cycleCount: number;
  orphanCount: number;
}

export interface VizCommunity {
  id: number;
  name: string;
  size: number;
  cohesion: number;
  dominantLanguage: string | null;
}

export interface VizData {
  nodes: VizNode[];
  edges: VizEdge[];
  stats: VizStats;
  communities: VizCommunity[];
  fileTree: FileTreeNode[];
}

/** @deprecated Use VizData instead */
export type VizGraph = VizData;

// ─── Build graph data from db ─────────────────────────────────────────────────

const KIND_GROUPS: Record<string, number> = {
  file: 0, class: 1, function: 2, method: 3, interface: 4,
  type: 5, variable: 6, test: 7, module: 8, external_dep: 9,
};

export function buildVizGraph(db: GraphDb, engine?: GraphEngine): VizData {
  const rawNodes = db.getAllNodes();
  const rawEdges = db.getAllEdges();

  // Fan-in / fan-out
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const e of rawEdges) {
    fanIn.set(e.toId, (fanIn.get(e.toId) ?? 0) + 1);
    fanOut.set(e.fromId, (fanOut.get(e.fromId) ?? 0) + 1);
  }

  const nodes: VizNode[] = rawNodes.map((n) => ({
    id: n.id,
    label: n.name,
    kind: n.kind,
    file: n.filePath,
    group: KIND_GROUPS[n.kind] ?? 9,
    description: n.description || '',
    language: n.language,
    isExternal: n.isExternal,
    fanIn: fanIn.get(n.id) ?? 0,
    fanOut: fanOut.get(n.id) ?? 0,
    communityId: (n as any).communityId ?? null,
    meta: n.meta || '{}',
  }));

  const nodeIds = new Set(nodes.map((n) => n.id));

  const edges: VizEdge[] = rawEdges
    .filter((e) => nodeIds.has(e.fromId) && nodeIds.has(e.toId))
    .map((e) => ({ source: e.fromId, target: e.toId, kind: e.kind, reason: e.reason || '' }));

  // Stats
  const basicStats = db.getStats();
  const nodesByKind = db.getNodeCountByKind();
  const edgesByKind = db.getEdgeCountByKind();

  const languageBreakdown: Record<string, number> = {};
  for (const n of rawNodes) {
    if (n.language) languageBreakdown[n.language] = (languageBreakdown[n.language] ?? 0) + 1;
  }

  // Top connected
  const totalEdges = new Map<string, number>();
  for (const n of nodes) {
    totalEdges.set(n.id, n.fanIn + n.fanOut);
  }
  const sorted = [...totalEdges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const topConnected = sorted.map(([id, total]) => {
    const n = nodeMap.get(id)!;
    return { id, label: n.label, kind: n.kind, total };
  });

  let cycleCount = 0;
  let orphanCount = 0;
  if (engine) {
    try { cycleCount = engine.detectCycles().length; } catch { /* empty */ }
    try { orphanCount = engine.orphans().length; } catch { /* empty */ }
  }

  const stats: VizStats = {
    nodeCount: basicStats.nodes,
    edgeCount: basicStats.edges,
    fileCount: basicStats.files,
    nodesByKind, edgesByKind, languageBreakdown,
    topConnected, cycleCount, orphanCount,
  };

  // Communities
  let communities: VizCommunity[] = [];
  try {
    communities = db.getCommunities().map((c) => ({
      id: c.id, name: c.name, size: c.size,
      cohesion: c.cohesion, dominantLanguage: c.dominantLanguage ?? null,
    }));
  } catch { /* empty */ }

  // File tree
  const fileTree = buildFileTree(rawNodes.filter((n) => n.kind === 'file').map((n) => n.filePath));

  return { nodes, edges, stats, communities, fileTree };
}

function buildFileTree(filePaths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [] };

  for (const fp of filePaths) {
    const parts = fp.replace(/\\/g, '/').split('/').filter(Boolean);
    let current = root;
    let currentPath = '';
    for (let i = 0; i < parts.length; i++) {
      currentPath += (currentPath ? '/' : '') + parts[i];
      const isFile = i === parts.length - 1;
      let child = current.children?.find((c) => c.name === parts[i]);
      if (!child) {
        child = { name: parts[i], path: currentPath };
        if (!isFile) child.children = [];
        if (!current.children) current.children = [];
        current.children.push(child);
      }
      if (isFile) {
        child.nodeCount = 1;
      }
      current = child;
    }
  }

  return root.children ?? [];
}

// ─── HTML generation ──────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildCss(): string {
  return `<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0d1117; color: #c9d1d9; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; overflow: hidden; }
#app { display: flex; flex-direction: column; height: 100vh; }

/* ── Header ── */
header {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px;
  background: #161b22; border-bottom: 1px solid #30363d;
  flex-shrink: 0;
}
header h1 { font-size: 14px; font-weight: 600; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#stats { font-size: 12px; color: #8b949e; margin-left: auto; white-space: nowrap; }
.tab-bar { display: flex; gap: 2px; margin-left: 24px; }
.tab-btn {
  background: transparent; color: #8b949e; border: none; border-bottom: 2px solid transparent;
  padding: 6px 14px; font-size: 12px; font-weight: 500; cursor: pointer; transition: all .15s;
}
.tab-btn:hover { color: #c9d1d9; }
.tab-btn.active { color: #58a6ff; border-bottom-color: #58a6ff; }

/* ── Controls ── */
#controls {
  display: flex; gap: 10px; align-items: center;
  padding: 8px 16px;
  background: #161b22; border-bottom: 1px solid #30363d;
  flex-shrink: 0; flex-wrap: wrap;
}
.ctrl-label { font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 6px; }
input[type=range] { accent-color: #58a6ff; width: 80px; }
select, input[type=text] {
  background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
  padding: 3px 8px; border-radius: 6px; font-size: 12px; outline: none;
}
select:focus, input:focus { border-color: #58a6ff; }
.btn {
  background: #21262d; color: #c9d1d9; border: 1px solid #30363d;
  padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
}
.btn:hover { background: #30363d; }

/* ── Edge filter ── */
.edge-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.edge-filters label { font-size: 11px; color: #8b949e; display: flex; align-items: center; gap: 3px; cursor: pointer; }
.edge-filters input[type=checkbox] { accent-color: #58a6ff; }

/* ── Main layout ── */
#main { display: flex; flex: 1; overflow: hidden; }

/* ── File Explorer (left) ── */
#fileExplorer {
  width: 250px; flex-shrink: 0; overflow-y: auto;
  background: #0d1117; border-right: 1px solid #30363d;
  font-size: 12px; display: none;
}
#fileExplorer.open { display: block; }
#fileExplorer .fe-header {
  padding: 8px 12px; border-bottom: 1px solid #30363d;
  display: flex; align-items: center; gap: 6px;
}
#fileExplorer .fe-header input {
  flex: 1; background: #161b22; border: 1px solid #30363d;
  color: #c9d1d9; padding: 3px 8px; border-radius: 4px; font-size: 11px; outline: none;
}
#fileExplorer .fe-tree { padding: 4px 0; }
.fe-item { padding: 3px 8px; cursor: pointer; display: flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fe-item:hover { background: #161b22; }
.fe-item.active { background: #1f2937; color: #58a6ff; }
.fe-dir-toggle { width: 12px; text-align: center; color: #8b949e; font-size: 10px; flex-shrink: 0; }
.fe-icon { flex-shrink: 0; color: #8b949e; }
.fe-children { display: none; }
.fe-children.expanded { display: block; }

/* ── Center content ── */
#centerContent { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }

/* ── Canvas (Graph view) ── */
#graphView { flex: 1; display: flex; overflow: hidden; }
#canvas { flex: 1; overflow: hidden; }
#canvas > svg { width: 100%; height: 100%; }

/* ── Details Panel (right) ── */
#detailsPanel {
  width: 320px; flex-shrink: 0; overflow-y: auto;
  background: #0d1117; border-left: 1px solid #30363d;
  display: none; font-size: 12px;
}
#detailsPanel.open { display: block; }
.dp-header {
  padding: 12px; border-bottom: 1px solid #30363d;
  display: flex; align-items: flex-start; justify-content: space-between;
}
.dp-close { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 16px; padding: 0 4px; }
.dp-close:hover { color: #e6edf3; }
.dp-body { padding: 12px; }
.dp-section { margin-bottom: 16px; }
.dp-section h3 { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.dp-badge {
  display: inline-block; padding: 1px 8px; border-radius: 4px;
  font-size: 11px; font-weight: 600;
}
.dp-metric { display: flex; gap: 16px; margin: 8px 0; }
.dp-metric-item { text-align: center; }
.dp-metric-value { font-size: 18px; font-weight: 700; color: #e6edf3; }
.dp-metric-label { font-size: 10px; color: #8b949e; }
.dp-edge-group { margin-bottom: 8px; }
.dp-edge-kind { font-size: 10px; color: #8b949e; text-transform: uppercase; margin-bottom: 2px; }
.dp-edge-link {
  display: block; padding: 2px 0; color: #58a6ff; text-decoration: none; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dp-edge-link:hover { text-decoration: underline; }
.dp-filepath { color: #8b949e; word-break: break-all; margin: 4px 0; }
.dp-desc { color: #c9d1d9; line-height: 1.5; margin: 6px 0; }

/* ── Stats View ── */
#statsView { display: none; flex: 1; overflow-y: auto; padding: 24px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
.stat-card {
  background: #161b22; border: 1px solid #30363d; border-radius: 8px;
  padding: 16px; text-align: center;
}
.stat-card .stat-value { font-size: 28px; font-weight: 700; color: #e6edf3; }
.stat-card .stat-label { font-size: 12px; color: #8b949e; margin-top: 4px; }
.chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
.chart-container {
  background: #161b22; border: 1px solid #30363d; border-radius: 8px;
  padding: 16px;
}
.chart-container h3 { font-size: 13px; color: #e6edf3; margin-bottom: 12px; }
.top-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.top-table th { text-align: left; color: #8b949e; padding: 6px 8px; border-bottom: 1px solid #30363d; font-weight: 500; }
.top-table td { padding: 6px 8px; border-bottom: 1px solid #21262d; }
.top-table tr { cursor: pointer; }
.top-table tr:hover { background: #161b22; }
.health-row { display: flex; gap: 16px; margin-top: 8px; }
.health-badge { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; }
.health-ok { background: #0d2818; color: #3fb950; }
.health-warn { background: #2d1b00; color: #e3b341; }

/* ── Tree View ── */
#treeView { display: none; flex: 1; overflow: hidden; padding: 16px; flex-direction: column; }
.tree-controls { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-shrink: 0; }
.tree-controls input { flex: 1; max-width: 400px; }
#treeCanvas { flex: 1; overflow: auto; }
#treeCanvas svg { min-width: 100%; min-height: 100%; }

/* ── Tooltip ── */
#tooltip {
  position: fixed; background: #1c2128; border: 1px solid #30363d;
  border-radius: 8px; padding: 10px 14px; font-size: 12px;
  pointer-events: none; opacity: 0; transition: opacity .15s;
  max-width: 300px; word-break: break-all; line-height: 1.6;
  box-shadow: 0 8px 24px rgba(0,0,0,.5); z-index: 1000;
}
#tooltip.visible { opacity: 1; }
#tooltip strong { color: #e6edf3; }
#tooltip .kind-badge {
  display: inline-block; padding: 1px 6px; border-radius: 4px;
  font-size: 11px; font-weight: 600; margin-left: 4px;
}

/* ── Legend ── */
#legend {
  position: fixed; bottom: 16px; right: 16px;
  background: #161b22; border: 1px solid #30363d;
  border-radius: 8px; padding: 10px 14px; font-size: 11px; line-height: 1.8;
  z-index: 100; max-height: 50vh; overflow-y: auto;
}
#legend h4 { font-size: 10px; color: #8b949e; text-transform: uppercase; margin: 6px 0 2px; }
#legend h4:first-child { margin-top: 0; }
.legend-item { display: flex; align-items: center; gap: 6px; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.legend-line { width: 18px; height: 2px; flex-shrink: 0; }

/* ── Context Menu ── */
#contextMenu {
  position: fixed; background: #1c2128; border: 1px solid #30363d;
  border-radius: 8px; padding: 4px 0; font-size: 12px; display: none;
  box-shadow: 0 8px 24px rgba(0,0,0,.5); z-index: 2000; min-width: 180px;
}
.ctx-item {
  padding: 6px 14px; cursor: pointer; display: flex; align-items: center; gap: 8px;
}
.ctx-item:hover { background: #30363d; }
.ctx-sep { height: 1px; background: #30363d; margin: 4px 0; }

@media (max-width: 900px) {
  .chart-row { grid-template-columns: 1fr; }
  #fileExplorer { width: 200px; }
  #detailsPanel { width: 280px; }
}
</style>`;
}

function buildHeaderHtml(title: string): string {
  return `<header>
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <circle cx="10" cy="10" r="9" stroke="#58a6ff" stroke-width="1.5"/>
    <circle cx="4" cy="10" r="2" fill="#58a6ff"/>
    <circle cx="16" cy="10" r="2" fill="#58a6ff"/>
    <circle cx="10" cy="4" r="2" fill="#3fb950"/>
    <circle cx="10" cy="16" r="2" fill="#3fb950"/>
    <line x1="6" y1="10" x2="8" y2="10" stroke="#8b949e" stroke-width="1"/>
    <line x1="12" y1="10" x2="14" y2="10" stroke="#8b949e" stroke-width="1"/>
    <line x1="10" y1="6" x2="10" y2="8" stroke="#8b949e" stroke-width="1"/>
    <line x1="10" y1="12" x2="10" y2="14" stroke="#8b949e" stroke-width="1"/>
  </svg>
  <h1>${escHtml(title)}</h1>
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="graph">Graph</button>
    <button class="tab-btn" data-tab="stats">Stats</button>
    <button class="tab-btn" data-tab="tree">Tree</button>
  </div>
  <span id="stats"></span>
</header>`;
}

function buildControlsHtml(): string {
  return `<div id="controls">
  <button class="btn" id="btnExplorer" title="Toggle file explorer">&#128193; Files</button>
  <label class="ctrl-label">Search <input type="text" id="search" placeholder="node name..." style="width:160px"></label>
  <label class="ctrl-label">Kind
    <select id="filterKind">
      <option value="">All</option>
      <option value="file">file</option>
      <option value="class">class</option>
      <option value="function">function</option>
      <option value="method">method</option>
      <option value="interface">interface</option>
      <option value="type">type</option>
      <option value="test">test</option>
      <option value="module">module</option>
      <option value="external_dep">external</option>
    </select>
  </label>
  <div class="edge-filters" id="edgeFilters"></div>
  <label class="ctrl-label">Link dist <input type="range" id="linkStrength" min="10" max="300" value="80"></label>
  <label class="ctrl-label">Charge <input type="range" id="charge" min="-500" max="-10" value="-120"></label>
  <button class="btn" id="btnReset">Reset zoom</button>
  <button class="btn" id="btnFreeze">Freeze</button>
</div>`;
}

function buildMainHtml(): string {
  return `<div id="main">
  <div id="fileExplorer">
    <div class="fe-header">
      <span class="fe-icon">&#128193;</span>
      <input type="text" id="feSearch" placeholder="Filter files...">
    </div>
    <div class="fe-tree" id="feTree"></div>
  </div>
  <div id="centerContent">
    <div id="graphView"><div id="canvas"></div></div>
    <div id="statsView"></div>
    <div id="treeView">
      <div class="tree-controls">
        <label class="ctrl-label">Root node
          <input type="text" id="treeRoot" list="nodeList" placeholder="Select a node..." style="width:300px">
          <datalist id="nodeList"></datalist>
        </label>
        <label class="ctrl-label">Depth <input type="range" id="treeDepth" min="1" max="8" value="4" style="width:80px"> <span id="treeDepthVal">4</span></label>
      </div>
      <div id="treeCanvas"></div>
    </div>
  </div>
  <div id="detailsPanel">
    <div class="dp-header">
      <div id="dpTitle"></div>
      <button class="dp-close" id="dpClose">&times;</button>
    </div>
    <div class="dp-body" id="dpBody"></div>
  </div>
</div>`;
}

function buildOverlaysHtml(): string {
  return `<div id="tooltip"></div>
<div id="legend"></div>
<div id="contextMenu">
  <div class="ctx-item" data-action="deps">&#128269; Show dependencies</div>
  <div class="ctx-item" data-action="dependents">&#128270; Show dependents</div>
  <div class="ctx-item" data-action="isolate">&#127758; Isolate neighbors</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" data-action="details">&#128196; View details</div>
  <div class="ctx-item" data-action="copy">&#128203; Copy ID</div>
</div>`;
}

function buildScript(dataJson: string): string {
  return `<script>
// d3 loaded via <script> tag in <head>
(function() {

const DATA = ${dataJson};

// ─── Palettes ──────────────────────────────────────────────────────────────
const NODE_PALETTE = [
  '#58a6ff','#a371f7','#3fb950','#56d364','#e3b341',
  '#ffa657','#f85149','#79c0ff','#d2a8ff','#8b949e',
];
const NODE_KIND_LABELS = ['file','class','function','method','interface','type','variable','test','module','external'];

const EDGE_PALETTE = {
  imports:    '#58a6ff',
  calls:      '#3fb950',
  inherits:   '#a371f7',
  implements: '#e3b341',
  exports:    '#ffa657',
  contains:   '#484f58',
  tested_by:  '#79c0ff',
  depends_on: '#f85149',
};
const EDGE_DASH = {
  imports: '',
  calls: '6,3',
  inherits: '2,3',
  implements: '8,4,2,4',
  exports: '4,4',
  contains: '1,3',
  tested_by: '6,2,2,2',
  depends_on: '10,4',
};

// ─── State ─────────────────────────────────────────────────────────────────
let frozen = false;
let simulation;
let currentTab = 'graph';
let selectedNode = null;
let contextTarget = null;
const nodeMap = new Map(DATA.nodes.map(n => [n.id, n]));

// ─── Edge filter state ─────────────────────────────────────────────────────
const edgeKinds = [...new Set(DATA.edges.map(e => e.kind))].sort();
const enabledEdgeKinds = new Set(edgeKinds);

function initEdgeFilters() {
  const container = document.getElementById('edgeFilters');
  container.innerHTML = '<span style="font-size:11px;color:#8b949e;margin-right:4px">Edges:</span>' +
    edgeKinds.map(k => {
      const checked = enabledEdgeKinds.has(k) ? 'checked' : '';
      const color = EDGE_PALETTE[k] || '#8b949e';
      return '<label><input type="checkbox" data-edge-kind="' + k + '" ' + checked + '>' +
        '<span style="color:' + color + '">' + k + '</span></label>';
    }).join('');

  container.addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.dataset.edgeKind) {
      if (cb.checked) enabledEdgeKinds.add(cb.dataset.edgeKind);
      else enabledEdgeKinds.delete(cb.dataset.edgeKind);
      rerender();
    }
  });
}

// ─── Tab system ────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('graphView').style.display = tab === 'graph' ? 'flex' : 'none';
  document.getElementById('controls').style.display = tab === 'graph' ? 'flex' : 'none';
  document.getElementById('statsView').style.display = tab === 'stats' ? 'block' : 'none';
  document.getElementById('treeView').style.display = tab === 'tree' ? 'flex' : 'none';
  const legend = document.getElementById('legend');
  if (legend) legend.style.display = tab === 'graph' ? 'block' : 'none';

  if (tab === 'stats') renderStatsView();
  if (tab === 'tree') initTreeView();
}

document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ─── SVG setup ─────────────────────────────────────────────────────────────
const container = document.getElementById('canvas');
const W = () => container.clientWidth;
const H = () => container.clientHeight;

const svg = d3.select('#canvas').append('svg');
const defs = svg.append('defs');
const g = svg.append('g');

// Arrow markers per edge kind
for (const [kind, color] of Object.entries(EDGE_PALETTE)) {
  defs.append('marker')
    .attr('id', 'arrow-' + kind).attr('viewBox', '0 -5 10 10')
    .attr('refX', 18).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', color).attr('opacity', 0.6);
}

// ─── Stats line ────────────────────────────────────────────────────────────
document.getElementById('stats').textContent =
  DATA.stats.nodeCount.toLocaleString() + ' nodes \\u00b7 ' +
  DATA.stats.edgeCount.toLocaleString() + ' edges \\u00b7 ' +
  DATA.stats.fileCount.toLocaleString() + ' files';

// ─── Build legend ──────────────────────────────────────────────────────────
function buildLegend() {
  const legend = document.getElementById('legend');
  const presentNodeGroups = [...new Set(DATA.nodes.map(n => n.group))].sort();
  const presentEdgeKinds = [...new Set(DATA.edges.map(e => e.kind))].sort();

  let html = '<h4>Nodes</h4>';
  html += presentNodeGroups.map(g =>
    '<div class="legend-item"><div class="legend-dot" style="background:' + NODE_PALETTE[g] + '"></div>' +
    NODE_KIND_LABELS[g] + '</div>'
  ).join('');

  html += '<h4>Edges</h4>';
  html += presentEdgeKinds.map(k => {
    const c = EDGE_PALETTE[k] || '#8b949e';
    const dash = EDGE_DASH[k] || '';
    return '<div class="legend-item">' +
      '<svg width="18" height="10"><line x1="0" y1="5" x2="18" y2="5" stroke="' + c + '" stroke-width="2"' +
      (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/></svg>' + k + '</div>';
  }).join('');

  legend.innerHTML = html;
}

// ─── Zoom ──────────────────────────────────────────────────────────────────
const zoom = d3.zoom().scaleExtent([0.03, 6])
  .on('zoom', e => g.attr('transform', e.transform));
svg.call(zoom);
document.getElementById('btnReset')
  .addEventListener('click', () => zoomToFit(60));

// ─── Simulation ────────────────────────────────────────────────────────────
function buildSimulation(nodes, links, distance, charge) {
  // Scale forces based on graph size
  const n = nodes.length;
  const scaledCharge = n > 200 ? charge * 2 : charge;
  const scaledDist = n > 200 ? Math.max(distance, 120) : distance;

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(scaledDist))
    .force('charge', d3.forceManyBody().strength(scaledCharge).distanceMax(600))
    .force('center', d3.forceCenter(W() / 2, H() / 2).strength(0.05))
    .force('collision', d3.forceCollide(d => nodeRadius(d) + 4))
    .force('x', d3.forceX(W() / 2).strength(0.02))
    .force('y', d3.forceY(H() / 2).strength(0.02));

  // Community clustering force
  const hasCommunities = nodes.some(n => n.communityId != null);
  if (hasCommunities) {
    const centroids = new Map();
    sim.force('cluster', (alpha) => {
      centroids.clear();
      const counts = new Map();
      for (const n of nodes) {
        if (n.communityId == null) continue;
        const c = centroids.get(n.communityId) || { x: 0, y: 0 };
        c.x += n.x || 0;
        c.y += n.y || 0;
        centroids.set(n.communityId, c);
        counts.set(n.communityId, (counts.get(n.communityId) || 0) + 1);
      }
      for (const [id, c] of centroids) {
        const cnt = counts.get(id);
        c.x /= cnt;
        c.y /= cnt;
      }
      for (const n of nodes) {
        if (n.communityId == null) continue;
        const c = centroids.get(n.communityId);
        if (!c) continue;
        n.vx += (c.x - n.x) * alpha * 0.08;
        n.vy += (c.y - n.y) * alpha * 0.08;
      }
    });
  }

  return sim;
}

function nodeRadius(d) {
  const total = (d.fanIn || 0) + (d.fanOut || 0);
  return Math.min(10, Math.max(3, 3 + Math.log2(total + 1) * 1.2));
}

function zoomToFit(padding) {
  const pad = padding || 40;
  const nodes = [];
  g.selectAll('circle').each(function(d) { if (d.x != null) nodes.push(d); });
  if (!nodes.length) return;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of nodes) {
    if (d.x < x0) x0 = d.x;
    if (d.y < y0) y0 = d.y;
    if (d.x > x1) x1 = d.x;
    if (d.y > y1) y1 = d.y;
  }

  const w = x1 - x0 || 1;
  const h = y1 - y0 || 1;
  const cw = W();
  const ch = H();
  const scale = Math.min((cw - pad * 2) / w, (ch - pad * 2) / h, 2);
  const tx = cw / 2 - (x0 + w / 2) * scale;
  const ty = ch / 2 - (y0 + h / 2) * scale;

  svg.transition().duration(800).call(
    zoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(scale)
  );
}

// ─── Rendering ─────────────────────────────────────────────────────────────
let link, node, label;

function render(filterKind, searchTerm) {
  const filteredNodes = DATA.nodes.filter(n =>
    (!filterKind || n.kind === filterKind) &&
    (!searchTerm || n.label.toLowerCase().includes(searchTerm.toLowerCase()))
  );
  const visibleIds = new Set(filteredNodes.map(n => n.id));
  const filteredEdges = DATA.edges.filter(e =>
    visibleIds.has(e.source) && visibleIds.has(e.target) && enabledEdgeKinds.has(e.kind)
  );

  const nodes = filteredNodes.map(n => ({ ...n }));
  const links = filteredEdges.map(e => ({ ...e }));

  g.selectAll('*').remove();

  // Links
  link = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', d => EDGE_PALETTE[d.kind] || '#30363d')
    .attr('stroke-width', 1)
    .attr('stroke-opacity', 0.5)
    .attr('stroke-dasharray', d => EDGE_DASH[d.kind] || '')
    .attr('marker-end', d => 'url(#arrow-' + d.kind + ')');

  // Nodes
  node = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => NODE_PALETTE[d.group] ?? NODE_PALETTE[9])
    .attr('stroke', '#0d1117').attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); if (!frozen) { d.fx = null; d.fy = null; } })
    )
    .on('mouseover', showTooltip)
    .on('mousemove', moveTooltip)
    .on('mouseout', hideTooltip)
    .on('click', (event, d) => { event.stopPropagation(); openDetails(d); highlightNeighbours(d, nodes, links); })
    .on('contextmenu', (event, d) => { event.preventDefault(); event.stopPropagation(); showContextMenu(event, d); });

  // Labels
  label = g.append('g').selectAll('text').data(nodes).join('text')
    .text(d => d.label)
    .attr('font-size', 10).attr('fill', '#e6edf3').attr('font-weight', 500)
    .attr('dx', d => nodeRadius(d) + 4).attr('dy', 3).style('pointer-events', 'none');

  // Simulation
  if (simulation) simulation.stop();
  const dist = +document.getElementById('linkStrength').value;
  const charge = +document.getElementById('charge').value;
  simulation = buildSimulation(nodes, links, dist, charge);

  let tickCount = 0;
  let fitted = false;
  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('cx', d => d.x).attr('cy', d => d.y);
    label.attr('x', d => d.x).attr('y', d => d.y);

    tickCount++;
    if (!fitted && tickCount > 60) {
      fitted = true;
      zoomToFit(60);
    }
  });
}

// ─── Highlight neighbours ──────────────────────────────────────────────────
function highlightNeighbours(d, nodes, links) {
  const connected = new Set([d.id]);
  links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s === d.id) connected.add(t);
    if (t === d.id) connected.add(s);
  });
  node.attr('opacity', n => connected.has(n.id) ? 1 : 0.08);
  label.attr('opacity', n => connected.has(n.id) ? 1 : 0.05);
  link.attr('stroke-width', l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return (s === d.id || t === d.id) ? 2 : 1;
  });
  link.attr('opacity', l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return (s === d.id || t === d.id) ? 0.9 : 0.03;
  });
}
svg.on('click', () => { node?.attr('opacity', 1); link?.attr('opacity', 0.5).attr('stroke-width', 1); label?.attr('opacity', 1); });

// ─── Tooltip ───────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');
function showTooltip(event, d) {
  const color = NODE_PALETTE[d.group] ?? NODE_PALETTE[9];
  tooltip.innerHTML =
    '<strong>' + esc(d.label) + '</strong>' +
    '<span class="kind-badge" style="background:' + color + '22;color:' + color + '">' + d.kind + '</span><br>' +
    '<span style="color:#8b949e">' + esc(d.file || '') + '</span>' +
    (d.description ? '<br><span style="color:#adbac7">' + esc(d.description) + '</span>' : '') +
    '<br><span style="color:#8b949e">In: ' + d.fanIn + ' Out: ' + d.fanOut + '</span>';
  tooltip.classList.add('visible');
  moveTooltip(event);
}
function moveTooltip(event) {
  tooltip.style.left = Math.min(event.clientX + 14, window.innerWidth - 320) + 'px';
  tooltip.style.top = (event.clientY - 10) + 'px';
}
function hideTooltip() { tooltip.classList.remove('visible'); }

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── Context Menu ──────────────────────────────────────────────────────────
const ctxMenu = document.getElementById('contextMenu');

function showContextMenu(event, d) {
  contextTarget = d;
  ctxMenu.style.display = 'block';
  ctxMenu.style.left = Math.min(event.clientX, window.innerWidth - 200) + 'px';
  ctxMenu.style.top = Math.min(event.clientY, window.innerHeight - 180) + 'px';
}

document.addEventListener('click', () => { ctxMenu.style.display = 'none'; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ctxMenu.style.display = 'none'; closeDetails(); } });

ctxMenu.addEventListener('click', (e) => {
  const action = e.target.closest('.ctx-item')?.dataset.action;
  if (!action || !contextTarget) return;
  ctxMenu.style.display = 'none';

  if (action === 'details') {
    openDetails(contextTarget);
  } else if (action === 'copy') {
    navigator.clipboard?.writeText(contextTarget.id);
  } else if (action === 'deps') {
    filterToConnected(contextTarget.id, 'out');
  } else if (action === 'dependents') {
    filterToConnected(contextTarget.id, 'in');
  } else if (action === 'isolate') {
    filterToConnected(contextTarget.id, 'both');
  }
});

function filterToConnected(nodeId, direction) {
  const connected = new Set([nodeId]);
  const queue = [nodeId];
  const maxDepth = 3;
  const depthMap = new Map([[nodeId, 0]]);

  while (queue.length) {
    const current = queue.shift();
    const depth = depthMap.get(current);
    if (depth >= maxDepth) continue;

    DATA.edges.forEach(e => {
      let neighbor = null;
      if (direction !== 'in' && e.source === current && !connected.has(e.target)) neighbor = e.target;
      if (direction !== 'out' && e.target === current && !connected.has(e.source)) neighbor = e.source;
      if (neighbor) {
        connected.add(neighbor);
        depthMap.set(neighbor, depth + 1);
        queue.push(neighbor);
      }
    });
  }

  // Temporarily override search to show only connected nodes
  document.getElementById('search').value = '';
  document.getElementById('filterKind').value = '';

  const filteredNodes = DATA.nodes.filter(n => connected.has(n.id));
  const nodes = filteredNodes.map(n => ({ ...n }));
  const visibleIds = new Set(nodes.map(n => n.id));
  const links = DATA.edges
    .filter(e => visibleIds.has(e.source) && visibleIds.has(e.target) && enabledEdgeKinds.has(e.kind))
    .map(e => ({ ...e }));

  g.selectAll('*').remove();

  link = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', d => EDGE_PALETTE[d.kind] || '#30363d')
    .attr('stroke-width', 0.8).attr('stroke-opacity', 0.4)
    .attr('stroke-dasharray', d => EDGE_DASH[d.kind] || '')
    .attr('marker-end', d => 'url(#arrow-' + d.kind + ')');

  node = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => NODE_PALETTE[d.group] ?? NODE_PALETTE[9])
    .attr('stroke', d => d.id === nodeId ? '#e6edf3' : '#0d1117')
    .attr('stroke-width', d => d.id === nodeId ? 2 : 1)
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); if (!frozen) { d.fx = null; d.fy = null; } })
    )
    .on('mouseover', showTooltip).on('mousemove', moveTooltip).on('mouseout', hideTooltip)
    .on('click', (event, d) => { event.stopPropagation(); openDetails(d); })
    .on('contextmenu', (event, d) => { event.preventDefault(); showContextMenu(event, d); });

  label = g.append('g').selectAll('text').data(nodes).join('text')
    .text(d => d.label).attr('font-size', 9).attr('fill', '#8b949e')
    .attr('dx', d => nodeRadius(d) + 3).attr('dy', 3).style('pointer-events', 'none');

  if (simulation) simulation.stop();
  simulation = buildSimulation(nodes, links, 100, -200);
  let fitDone = false;
  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('cx', d => d.x).attr('cy', d => d.y);
    label.attr('x', d => d.x).attr('y', d => d.y);
    if (!fitDone && simulation.alpha() < 0.3) { fitDone = true; zoomToFit(60); }
  });
}

// ─── Details Panel ─────────────────────────────────────────────────────────
function openDetails(d) {
  selectedNode = d;
  const panel = document.getElementById('detailsPanel');
  panel.classList.add('open');

  const color = NODE_PALETTE[d.group] ?? NODE_PALETTE[9];
  document.getElementById('dpTitle').innerHTML =
    '<strong style="font-size:14px;color:#e6edf3">' + esc(d.label) + '</strong>' +
    '<span class="dp-badge" style="background:' + color + '22;color:' + color + ';margin-left:8px">' + d.kind + '</span>';

  // Build body
  let html = '';

  // File path
  html += '<div class="dp-filepath">' + esc(d.file || 'N/A') + '</div>';

  // Description
  if (d.description) {
    html += '<div class="dp-desc">' + esc(d.description) + '</div>';
  }

  // Metrics
  html += '<div class="dp-metric">' +
    '<div class="dp-metric-item"><div class="dp-metric-value">' + d.fanIn + '</div><div class="dp-metric-label">Fan-in</div></div>' +
    '<div class="dp-metric-item"><div class="dp-metric-value">' + d.fanOut + '</div><div class="dp-metric-label">Fan-out</div></div>' +
    '</div>';

  // Language & external
  if (d.language || d.isExternal) {
    html += '<div class="dp-section">';
    if (d.language) html += '<span class="dp-badge" style="background:#21262d;color:#c9d1d9">' + d.language + '</span> ';
    if (d.isExternal) html += '<span class="dp-badge" style="background:#2d1b00;color:#e3b341">external</span>';
    html += '</div>';
  }

  // Community
  if (d.communityId != null) {
    const comm = DATA.communities.find(c => c.id === d.communityId);
    if (comm) {
      html += '<div class="dp-section"><h3>Community</h3>' + esc(comm.name) + ' (size: ' + comm.size + ')</div>';
    }
  }

  // Metadata
  try {
    const meta = JSON.parse(d.meta);
    const keys = Object.keys(meta);
    if (keys.length > 0) {
      html += '<div class="dp-section"><h3>Metadata</h3>';
      for (const k of keys) {
        html += '<div style="margin:2px 0"><span style="color:#8b949e">' + esc(k) + ':</span> ' + esc(String(meta[k])) + '</div>';
      }
      html += '</div>';
    }
  } catch {}

  // Incoming edges
  const incoming = DATA.edges.filter(e => e.target === d.id);
  if (incoming.length) {
    html += '<div class="dp-section"><h3>Incoming (' + incoming.length + ')</h3>';
    const grouped = groupBy(incoming, 'kind');
    for (const [kind, edges] of Object.entries(grouped)) {
      html += '<div class="dp-edge-group"><div class="dp-edge-kind" style="color:' + (EDGE_PALETTE[kind] || '#8b949e') + '">' + kind + ' (' + edges.length + ')</div>';
      for (const e of edges.slice(0, 20)) {
        const src = nodeMap.get(e.source);
        html += '<a class="dp-edge-link" data-node-id="' + e.source + '">' + esc(src?.label || e.source) + '</a>';
      }
      if (edges.length > 20) html += '<div style="color:#8b949e">...and ' + (edges.length - 20) + ' more</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // Outgoing edges
  const outgoing = DATA.edges.filter(e => e.source === d.id);
  if (outgoing.length) {
    html += '<div class="dp-section"><h3>Outgoing (' + outgoing.length + ')</h3>';
    const grouped = groupBy(outgoing, 'kind');
    for (const [kind, edges] of Object.entries(grouped)) {
      html += '<div class="dp-edge-group"><div class="dp-edge-kind" style="color:' + (EDGE_PALETTE[kind] || '#8b949e') + '">' + kind + ' (' + edges.length + ')</div>';
      for (const e of edges.slice(0, 20)) {
        const tgt = nodeMap.get(e.target);
        html += '<a class="dp-edge-link" data-node-id="' + e.target + '">' + esc(tgt?.label || e.target) + '</a>';
      }
      if (edges.length > 20) html += '<div style="color:#8b949e">...and ' + (edges.length - 20) + ' more</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  document.getElementById('dpBody').innerHTML = html;

  // Edge link navigation
  document.getElementById('dpBody').addEventListener('click', (e) => {
    const link = e.target.closest('[data-node-id]');
    if (link) {
      const targetNode = nodeMap.get(link.dataset.nodeId);
      if (targetNode) {
        openDetails(targetNode);
        focusNode(targetNode.id);
      }
    }
  });
}

function closeDetails() {
  document.getElementById('detailsPanel').classList.remove('open');
  selectedNode = null;
}
document.getElementById('dpClose').addEventListener('click', closeDetails);

function focusNode(nodeId) {
  if (!node) return;
  const target = node.data().find(n => n.id === nodeId);
  if (target && target.x != null) {
    const scale = 1.5;
    const tx = W() / 2 - target.x * scale;
    const ty = H() / 2 - target.y * scale;
    svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));

    node.attr('stroke', n => n.id === nodeId ? '#e6edf3' : '#0d1117')
        .attr('stroke-width', n => n.id === nodeId ? 3 : 1.5);
  }
}

function groupBy(arr, key) {
  const result = {};
  for (const item of arr) {
    const k = item[key];
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

// ─── Stats View ────────────────────────────────────────────────────────────
let statsRendered = false;

function renderStatsView() {
  if (statsRendered) return;
  statsRendered = true;
  const el = document.getElementById('statsView');
  const s = DATA.stats;

  let html = '';

  // Summary cards
  html += '<div class="stats-grid">';
  html += statCard(s.nodeCount, 'Nodes');
  html += statCard(s.edgeCount, 'Edges');
  html += statCard(s.fileCount, 'Files');
  html += statCard(DATA.communities.length, 'Communities');
  html += '</div>';

  // Chart row: node kinds + edge kinds
  html += '<div class="chart-row">';
  html += '<div class="chart-container"><h3>Nodes by Kind</h3><div id="chartNodeKinds"></div></div>';
  html += '<div class="chart-container"><h3>Edges by Kind</h3><div id="chartEdgeKinds"></div></div>';
  html += '</div>';

  // Chart row: language + top connected
  html += '<div class="chart-row">';
  html += '<div class="chart-container"><h3>Languages</h3><div id="chartLanguages"></div></div>';
  html += '<div class="chart-container"><h3>Top Connected Nodes</h3>';
  html += '<table class="top-table"><thead><tr><th>Node</th><th>Kind</th><th>Edges</th></tr></thead><tbody>';
  for (const t of s.topConnected) {
    html += '<tr data-node-id="' + t.id + '"><td>' + esc(t.label) + '</td><td>' + t.kind + '</td><td>' + t.total + '</td></tr>';
  }
  html += '</tbody></table></div>';
  html += '</div>';

  // Health
  html += '<div class="chart-container"><h3>Health Indicators</h3><div class="health-row">';
  html += '<span class="health-badge ' + (s.cycleCount > 0 ? 'health-warn' : 'health-ok') + '">' +
    s.cycleCount + ' cycles</span>';
  html += '<span class="health-badge ' + (s.orphanCount > 5 ? 'health-warn' : 'health-ok') + '">' +
    s.orphanCount + ' orphan nodes</span>';
  html += '</div></div>';

  el.innerHTML = html;

  // Render bar charts
  renderBarChart('#chartNodeKinds', s.nodesByKind, NODE_PALETTE, { file:0,class:1,function:2,method:3,interface:4,type:5,variable:6,test:7,module:8,external_dep:9 });
  renderBarChart('#chartEdgeKinds', s.edgesByKind, EDGE_PALETTE);
  renderDonutChart('#chartLanguages', s.languageBreakdown);

  // Top connected clicks
  el.querySelectorAll('[data-node-id]').forEach(row => {
    row.addEventListener('click', () => {
      switchTab('graph');
      setTimeout(() => focusNode(row.dataset.nodeId), 300);
    });
  });
}

function statCard(value, label) {
  return '<div class="stat-card"><div class="stat-value">' + value.toLocaleString() + '</div><div class="stat-label">' + label + '</div></div>';
}

function renderBarChart(selector, data, colorMap, indexMap) {
  const el = document.querySelector(selector);
  if (!el) return;
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.innerHTML = '<span style="color:#8b949e">No data</span>'; return; }

  const width = el.clientWidth || 300;
  const barH = 22;
  const height = entries.length * barH + 4;
  const maxVal = Math.max(...entries.map(e => e[1]));
  const labelW = 100;

  const svgEl = d3.select(selector).append('svg').attr('width', width).attr('height', height);

  entries.forEach(([key, val], i) => {
    let color;
    if (indexMap && indexMap[key] != null) color = NODE_PALETTE[indexMap[key]];
    else if (typeof colorMap === 'object' && !Array.isArray(colorMap)) color = colorMap[key];
    else color = '#58a6ff';
    if (!color) color = '#8b949e';

    const barW = ((val / maxVal) * (width - labelW - 50)) || 0;
    const y = i * barH;

    svgEl.append('text').attr('x', labelW - 6).attr('y', y + barH / 2 + 4)
      .attr('text-anchor', 'end').attr('fill', '#c9d1d9').attr('font-size', 11).text(key);
    svgEl.append('rect').attr('x', labelW).attr('y', y + 2).attr('width', barW).attr('height', barH - 6)
      .attr('fill', color).attr('rx', 3).attr('opacity', 0.8);
    svgEl.append('text').attr('x', labelW + barW + 6).attr('y', y + barH / 2 + 4)
      .attr('fill', '#8b949e').attr('font-size', 11).text(val);
  });
}

function renderDonutChart(selector, data) {
  const el = document.querySelector(selector);
  if (!el) return;
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.innerHTML = '<span style="color:#8b949e">No data</span>'; return; }

  const size = 200;
  const radius = size / 2 - 10;
  const inner = radius * 0.5;
  const colors = d3.scaleOrdinal(d3.schemeTableau10);

  const svgEl = d3.select(selector).append('svg').attr('width', size + 180).attr('height', size);
  const gEl = svgEl.append('g').attr('transform', 'translate(' + size / 2 + ',' + size / 2 + ')');

  const pie = d3.pie().value(d => d[1]).sort(null);
  const arc = d3.arc().innerRadius(inner).outerRadius(radius);

  gEl.selectAll('path').data(pie(entries)).join('path')
    .attr('d', arc).attr('fill', (d, i) => colors(i)).attr('stroke', '#0d1117').attr('stroke-width', 1.5);

  // Legend
  const legendG = svgEl.append('g').attr('transform', 'translate(' + (size + 10) + ', 10)');
  entries.forEach(([key, val], i) => {
    legendG.append('rect').attr('x', 0).attr('y', i * 18).attr('width', 10).attr('height', 10)
      .attr('fill', colors(i)).attr('rx', 2);
    legendG.append('text').attr('x', 16).attr('y', i * 18 + 9)
      .attr('fill', '#c9d1d9').attr('font-size', 11).text(key + ' (' + val + ')');
  });
}

// ─── Tree View ─────────────────────────────────────────────────────────────
let treeInited = false;

function initTreeView() {
  if (treeInited) return;
  treeInited = true;

  // Populate datalist
  const list = document.getElementById('nodeList');
  const fileNodes = DATA.nodes.filter(n => n.kind === 'file' || n.kind === 'module');
  fileNodes.sort((a, b) => a.label.localeCompare(b.label));
  list.innerHTML = fileNodes.map(n => '<option value="' + n.id + '">' + esc(n.label) + '</option>').join('');

  const depthSlider = document.getElementById('treeDepth');
  depthSlider.addEventListener('input', () => {
    document.getElementById('treeDepthVal').textContent = depthSlider.value;
    renderTree();
  });

  document.getElementById('treeRoot').addEventListener('change', renderTree);
  document.getElementById('treeRoot').addEventListener('input', debounce(renderTree, 400));

  // Auto-select the first file/module node so the tree renders on tab open
  if (fileNodes.length > 0) {
    document.getElementById('treeRoot').value = fileNodes[0].id;
  }
  renderTree();
}

function renderTree() {
  const rootId = document.getElementById('treeRoot').value;
  const maxDepth = +document.getElementById('treeDepth').value;
  const container = document.getElementById('treeCanvas');

  if (!rootId || !nodeMap.has(rootId)) {
    container.innerHTML = '<div style="color:#8b949e;padding:40px;text-align:center">Select a node to visualize its dependency tree</div>';
    return;
  }

  // BFS to build tree
  const root = nodeMap.get(rootId);
  const treeData = { name: root.label, kind: root.kind, id: root.id, children: [] };
  const visited = new Set([rootId]);
  const queue = [{ node: treeData, depth: 0 }];

  while (queue.length) {
    const { node: current, depth } = queue.shift();
    if (depth >= maxDepth) continue;

    const outEdges = DATA.edges.filter(e =>
      e.source === current.id && (e.kind === 'imports' || e.kind === 'depends_on' || e.kind === 'calls')
    );

    for (const e of outEdges) {
      if (visited.has(e.target)) continue;
      visited.add(e.target);
      const targetNode = nodeMap.get(e.target);
      if (!targetNode) continue;
      const child = { name: targetNode.label, kind: targetNode.kind, id: e.target, edgeKind: e.kind, children: [] };
      current.children.push(child);
      queue.push({ node: child, depth: depth + 1 });
    }
  }

  // D3 tree layout
  container.innerHTML = '';
  const totalNodes = countNodes(treeData);
  const nodeH = 24;
  const width = Math.max(600, maxDepth * 220 + 200);
  const height = Math.max(300, totalNodes * nodeH + 40);
  const marginLeft = 120;

  const svgEl = d3.select('#treeCanvas').append('svg')
    .attr('width', width).attr('height', height);
  const gEl = svgEl.append('g').attr('transform', 'translate(' + marginLeft + ', 20)');

  const hierarchy = d3.hierarchy(treeData);
  const treeLayout = d3.tree().size([height - 40, width - marginLeft - 100]);
  treeLayout(hierarchy);

  // Links
  gEl.selectAll('path.tree-link').data(hierarchy.links()).join('path')
    .attr('class', 'tree-link')
    .attr('d', d3.linkHorizontal().x(d => d.y).y(d => d.x))
    .attr('fill', 'none')
    .attr('stroke', d => EDGE_PALETTE[d.target.data.edgeKind] || '#30363d')
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.6)
    .attr('stroke-dasharray', d => EDGE_DASH[d.target.data.edgeKind] || '');

  // Nodes
  const nodeGroups = gEl.selectAll('g.tree-node').data(hierarchy.descendants()).join('g')
    .attr('class', 'tree-node')
    .attr('transform', d => 'translate(' + d.y + ',' + d.x + ')')
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      const n = nodeMap.get(d.data.id);
      if (n) openDetails(n);
    })
    .on('dblclick', (event, d) => {
      document.getElementById('treeRoot').value = d.data.id;
      renderTree();
    });

  nodeGroups.append('circle')
    .attr('r', 5)
    .attr('fill', d => {
      const group = { file:0,class:1,function:2,method:3,interface:4,type:5,variable:6,test:7,module:8,external_dep:9 }[d.data.kind] ?? 9;
      return NODE_PALETTE[group];
    })
    .attr('stroke', '#0d1117').attr('stroke-width', 1.5);

  nodeGroups.append('text')
    .attr('dx', 10).attr('dy', 4)
    .attr('font-size', 11).attr('fill', '#c9d1d9')
    .text(d => d.data.name);
}

function countNodes(tree) {
  let count = 1;
  for (const c of (tree.children || [])) count += countNodes(c);
  return count;
}

// ─── File Explorer ─────────────────────────────────────────────────────────
function initFileExplorer() {
  const tree = DATA.fileTree;
  const container = document.getElementById('feTree');
  container.innerHTML = renderFileTreeHtml(tree, 0);

  // Toggle directories
  container.addEventListener('click', (e) => {
    const item = e.target.closest('.fe-item');
    if (!item) return;

    const childrenEl = item.nextElementSibling;
    if (childrenEl && childrenEl.classList.contains('fe-children')) {
      childrenEl.classList.toggle('expanded');
      const toggle = item.querySelector('.fe-dir-toggle');
      if (toggle) toggle.textContent = childrenEl.classList.contains('expanded') ? '\\u25BE' : '\\u25B8';
    } else {
      // File click — filter graph to this file
      const filePath = item.dataset.path;
      if (filePath) {
        document.querySelectorAll('.fe-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        switchTab('graph');
        document.getElementById('search').value = '';
        document.getElementById('filterKind').value = '';
        filterToFile(filePath);
      }
    }
  });

  // Filter
  document.getElementById('feSearch').addEventListener('input', debounce((e) => {
    const term = e.target.value.toLowerCase();
    container.querySelectorAll('.fe-item').forEach(item => {
      const path = (item.dataset.path || item.textContent).toLowerCase();
      item.style.display = (!term || path.includes(term)) ? 'flex' : 'none';
    });
    if (term) {
      container.querySelectorAll('.fe-children').forEach(c => c.classList.add('expanded'));
    }
  }, 200));

  // Toggle button
  document.getElementById('btnExplorer').addEventListener('click', () => {
    document.getElementById('fileExplorer').classList.toggle('open');
  });
}

function renderFileTreeHtml(nodes, depth) {
  let html = '';
  const sorted = [...nodes].sort((a, b) => {
    const aDir = a.children ? 0 : 1;
    const bDir = b.children ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name);
  });

  for (const node of sorted) {
    const indent = depth * 16;
    if (node.children) {
      html += '<div class="fe-item" style="padding-left:' + (8 + indent) + 'px">' +
        '<span class="fe-dir-toggle">\\u25B8</span>' +
        '<span class="fe-icon">\\uD83D\\uDCC1</span> ' + esc(node.name) +
        '</div>';
      html += '<div class="fe-children">' + renderFileTreeHtml(node.children, depth + 1) + '</div>';
    } else {
      html += '<div class="fe-item" data-path="' + esc(node.path) + '" style="padding-left:' + (8 + indent + 16) + 'px">' +
        '<span class="fe-icon">\\uD83D\\uDCC4</span> ' + esc(node.name) +
        '</div>';
    }
  }
  return html;
}

function filterToFile(filePath) {
  const fileNodes = DATA.nodes.filter(n => n.file && n.file.replace(/\\\\\\\\/g, '/').endsWith(filePath.replace(/\\\\\\\\/g, '/')));
  if (!fileNodes.length) return;

  const fileIds = new Set(fileNodes.map(n => n.id));
  // Also include direct neighbors
  DATA.edges.forEach(e => {
    if (fileIds.has(e.source)) fileIds.add(e.target);
    if (fileIds.has(e.target)) fileIds.add(e.source);
  });

  const filteredNodes = DATA.nodes.filter(n => fileIds.has(n.id));
  const nodes = filteredNodes.map(n => ({ ...n }));
  const visibleIds = new Set(nodes.map(n => n.id));
  const links = DATA.edges
    .filter(e => visibleIds.has(e.source) && visibleIds.has(e.target) && enabledEdgeKinds.has(e.kind))
    .map(e => ({ ...e }));

  g.selectAll('*').remove();

  link = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', d => EDGE_PALETTE[d.kind] || '#30363d')
    .attr('stroke-width', 0.8).attr('stroke-opacity', 0.4)
    .attr('stroke-dasharray', d => EDGE_DASH[d.kind] || '')
    .attr('marker-end', d => 'url(#arrow-' + d.kind + ')');

  node = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => NODE_PALETTE[d.group] ?? NODE_PALETTE[9])
    .attr('stroke', '#0d1117').attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); if (!frozen) { d.fx = null; d.fy = null; } })
    )
    .on('mouseover', showTooltip).on('mousemove', moveTooltip).on('mouseout', hideTooltip)
    .on('click', (event, d) => { event.stopPropagation(); openDetails(d); })
    .on('contextmenu', (event, d) => { event.preventDefault(); showContextMenu(event, d); });

  label = g.append('g').selectAll('text').data(nodes).join('text')
    .text(d => d.label).attr('font-size', 9).attr('fill', '#8b949e')
    .attr('dx', d => nodeRadius(d) + 3).attr('dy', 3).style('pointer-events', 'none');

  if (simulation) simulation.stop();
  simulation = buildSimulation(nodes, links, 80, -150);
  let fitDone2 = false;
  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('cx', d => d.x).attr('cy', d => d.y);
    label.attr('x', d => d.x).attr('y', d => d.y);
    if (!fitDone2 && simulation.alpha() < 0.3) { fitDone2 = true; zoomToFit(60); }
  });
}

// ─── Controls ─────────────────────────────────────────────────────────────
let searchTimer;
function debounce(fn, ms) { return function(...args) { clearTimeout(searchTimer); searchTimer = setTimeout(() => fn.apply(this, args), ms); }; }

const rerender = () => render(
  document.getElementById('filterKind').value,
  document.getElementById('search').value
);

document.getElementById('search').addEventListener('input', debounce(rerender, 200));
document.getElementById('filterKind').addEventListener('change', rerender);

document.getElementById('linkStrength').addEventListener('input', () => {
  if (simulation) simulation.force('link').distance(+document.getElementById('linkStrength').value);
  simulation?.alpha(0.3).restart();
});
document.getElementById('charge').addEventListener('input', () => {
  if (simulation) simulation.force('charge').strength(+document.getElementById('charge').value);
  simulation?.alpha(0.3).restart();
});

const btnFreeze = document.getElementById('btnFreeze');
btnFreeze.addEventListener('click', () => {
  frozen = !frozen;
  btnFreeze.textContent = frozen ? 'Resume' : 'Freeze';
  if (frozen) simulation?.stop();
  else simulation?.restart();
});

// ─── Init ──────────────────────────────────────────────────────────────────
initEdgeFilters();
buildLegend();
initFileExplorer();

render('', '');
})();
</script>`;
}

export function generateHtml(data: VizData, title: string): string {
  const dataJson = JSON.stringify(data);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escHtml(title)} — Code Graph</title>
  ${buildCss()}
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"><\/script>
</head>
<body>
<div id="app">
  ${buildHeaderHtml(title)}
  ${buildControlsHtml()}
  ${buildMainHtml()}
</div>
${buildOverlaysHtml()}
${buildScript(dataJson)}
</body>
</html>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface VisualizeOptions {
  output: string;
  title?: string;
  engine?: GraphEngine;
}

export function generateVisualization(db: GraphDb, opts: VisualizeOptions): void {
  const data = buildVizGraph(db, opts.engine);
  const title = opts.title ?? path.basename(opts.output, '.html');
  const html = generateHtml(data, title);
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, html, 'utf-8');
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

export interface ServeOptions {
  port: number;
  title?: string;
  engine?: GraphEngine;
}

export function serveVisualization(db: GraphDb, opts: ServeOptions): http.Server {
  const data = buildVizGraph(db, opts.engine);
  const title = opts.title ?? 'Code Graph';
  const html = generateHtml(data, title);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  server.listen(opts.port);
  return server;
}
