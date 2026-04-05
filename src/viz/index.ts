/**
 * viz/index.ts — Generate a self-contained D3 graph HTML page from the code graph,
 * and optionally serve it over HTTP.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import type { GraphDb } from '../graph/db.js';

// ─── Serialisable types ────────────────────────────────────────────────────────

export interface VizNode {
  id: string;
  label: string;
  kind: string;
  file: string;
  group: number; // community / colour bucket
}

export interface VizEdge {
  source: string;
  target: string;
  kind: string;
}

export interface VizGraph {
  nodes: VizNode[];
  edges: VizEdge[];
}

// ─── Build graph data from db ─────────────────────────────────────────────────

const KIND_GROUPS: Record<string, number> = {
  file: 0,
  class: 1,
  function: 2,
  method: 3,
  interface: 4,
  type: 5,
  variable: 6,
  test: 7,
  module: 8,
};

export function buildVizGraph(db: GraphDb): VizGraph {
  const rawNodes = db.getAllNodes();
  const rawEdges = db.getAllEdges();

  const nodes: VizNode[] = rawNodes.map((n) => ({
    id: n.id,
    label: n.name,
    kind: n.kind,
    file: n.filePath,
    group: KIND_GROUPS[n.kind] ?? 9,
  }));

  const nodeIds = new Set(nodes.map((n) => n.id));

  const edges: VizEdge[] = rawEdges
    .filter((e) => nodeIds.has(e.fromId) && nodeIds.has(e.toId))
    .map((e) => ({ source: e.fromId, target: e.toId, kind: e.kind }));

  return { nodes, edges };
}

// ─── HTML template ─────────────────────────────────────────────────────────────

export function generateHtml(graph: VizGraph, title: string): string {
  const dataJson = JSON.stringify(graph);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escHtml(title)} — Code Graph</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #c9d1d9; font-family: 'Segoe UI', system-ui, sans-serif; overflow: hidden; }

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

    /* ── Controls ── */
    #controls {
      display: flex; gap: 10px; align-items: center;
      padding: 8px 16px;
      background: #161b22; border-bottom: 1px solid #30363d;
      flex-shrink: 0; flex-wrap: wrap;
    }
    label { font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 6px; }
    input[type=range] { accent-color: #58a6ff; width: 80px; }
    select, input[type=text] {
      background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
      padding: 3px 8px; border-radius: 6px; font-size: 12px; outline: none;
    }
    select:focus, input:focus { border-color: #58a6ff; }
    button {
      background: #21262d; color: #c9d1d9; border: 1px solid #30363d;
      padding: 4px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
    }
    button:hover { background: #30363d; }

    /* ── Canvas ── */
    #canvas { flex: 1; overflow: hidden; }
    svg { width: 100%; height: 100%; }

    /* ── Tooltip ── */
    #tooltip {
      position: fixed; background: #1c2128; border: 1px solid #30363d;
      border-radius: 8px; padding: 10px 14px; font-size: 12px;
      pointer-events: none; opacity: 0; transition: opacity .15s;
      max-width: 300px; word-break: break-all; line-height: 1.6;
      box-shadow: 0 8px 24px rgba(0,0,0,.5);
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
    }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  </style>
</head>
<body>
<div id="app">
  <header>
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
    <span id="stats"></span>
  </header>
  <div id="controls">
    <label>Search <input type="text" id="search" placeholder="node name…" style="width:160px"></label>
    <label>Kind
      <select id="filterKind">
        <option value="">All</option>
        <option value="file">file</option>
        <option value="class">class</option>
        <option value="function">function</option>
        <option value="method">method</option>
        <option value="interface">interface</option>
        <option value="type">type</option>
        <option value="variable">variable</option>
        <option value="test">test</option>
        <option value="module">module</option>
      </select>
    </label>
    <label>Link strength <input type="range" id="linkStrength" min="10" max="300" value="80"></label>
    <label>Charge <input type="range" id="charge" min="-500" max="-10" value="-120"></label>
    <button id="btnReset">⟲ Reset zoom</button>
    <button id="btnFreeze">⏸ Freeze</button>
  </div>
  <div id="canvas"></div>
</div>
<div id="tooltip"></div>
<div id="legend"></div>

<script type="module">
import * as d3 from 'https://esm.sh/d3@7';

const RAW = ${dataJson};

// ─── Colour palette ────────────────────────────────────────────────────────
const PALETTE = [
  '#58a6ff', // file      — blue
  '#a371f7', // class     — purple
  '#3fb950', // function  — green
  '#56d364', // method    — light-green
  '#e3b341', // interface — yellow
  '#ffa657', // type      — orange
  '#f85149', // variable  — red
  '#79c0ff', // test      — sky
  '#d2a8ff', // module    — lilac
  '#8b949e', // other     — grey
];

const KIND_LABELS = ['file','class','function','method','interface','type','variable','test','module','other'];

// ─── State ─────────────────────────────────────────────────────────────────
let frozen = false;
let simulation;
const nodeMap = new Map(RAW.nodes.map(n => [n.id, n]));

// ─── SVG setup ─────────────────────────────────────────────────────────────
const container = document.getElementById('canvas');
const W = () => container.clientWidth;
const H = () => container.clientHeight;

const svg = d3.select('#canvas').append('svg');
const g   = svg.append('g');

// Arrow marker
svg.append('defs').append('marker')
  .attr('id','arrow').attr('viewBox','0 -5 10 10').attr('refX',16).attr('refY',0)
  .attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
  .append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#30363d');

// ─── Build legend ──────────────────────────────────────────────────────────
const legend = document.getElementById('legend');
const presentGroups = [...new Set(RAW.nodes.map(n => n.group))].sort();
legend.innerHTML = presentGroups.map(g =>
  '<div class="legend-item">' +
  '<div class="legend-dot" style="background:' + PALETTE[g] + '"></div>' +
  KIND_LABELS[g] +
  '</div>'
).join('');

// ─── Stats ─────────────────────────────────────────────────────────────────
document.getElementById('stats').textContent =
  RAW.nodes.length.toLocaleString() + ' nodes · ' +
  RAW.edges.length.toLocaleString() + ' edges';

// ─── Zoom ──────────────────────────────────────────────────────────────────
const zoom = d3.zoom().scaleExtent([0.05,4])
  .on('zoom', e => g.attr('transform', e.transform));
svg.call(zoom);
document.getElementById('btnReset')
  .addEventListener('click', () => svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity));

// ─── Simulation ────────────────────────────────────────────────────────────
function buildSimulation(nodes, links, strength, charge) {
  return d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(strength))
    .force('charge', d3.forceManyBody().strength(charge))
    .force('center', d3.forceCenter(W()/2, H()/2))
    .force('collision', d3.forceCollide(8));
}

// ─── Rendering ─────────────────────────────────────────────────────────────
let link, node, label;

function render(filterKind, searchTerm) {
  // Filter nodes
  const filteredNodes = RAW.nodes.filter(n =>
    (!filterKind || n.kind === filterKind) &&
    (!searchTerm || n.label.toLowerCase().includes(searchTerm.toLowerCase()))
  );
  const visibleIds = new Set(filteredNodes.map(n => n.id));
  const filteredEdges = RAW.edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));

  // Deep-copy for d3 mutation
  const nodes = filteredNodes.map(n => ({ ...n }));
  const links = filteredEdges.map(e => ({ ...e }));

  g.selectAll('*').remove();

  // Links
  link = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', '#30363d').attr('stroke-width', 1).attr('stroke-opacity', 0.6)
    .attr('marker-end', 'url(#arrow)');

  // Nodes
  node = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r', 6).attr('fill', d => PALETTE[d.group] ?? PALETTE[9])
    .attr('stroke', '#0d1117').attr('stroke-width', 1.5)
    .style('cursor','pointer')
    .call(d3.drag()
      .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag',  (event, d) => { d.fx=event.x; d.fy=event.y; })
      .on('end',   (event, d) => { if (!event.active) simulation.alphaTarget(0); if (!frozen) { d.fx=null; d.fy=null; } })
    )
    .on('mouseover', showTooltip)
    .on('mousemove', moveTooltip)
    .on('mouseout', hideTooltip)
    .on('click', (event, d) => { event.stopPropagation(); highlightNeighbours(d, nodes, links); });

  // Labels (only for small graphs to avoid clutter)
  label = g.append('g').selectAll('text').data(nodes).join('text')
    .text(d => nodes.length < 200 ? d.label : '')
    .attr('font-size', 9).attr('fill', '#8b949e')
    .attr('dx', 8).attr('dy', 4).style('pointer-events','none');

  // Restart simulation
  if (simulation) simulation.stop();
  const strength = +document.getElementById('linkStrength').value;
  const charge   = +document.getElementById('charge').value;
  simulation = buildSimulation(nodes, links, strength, charge);
  simulation.on('tick', () => {
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
        .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    node.attr('cx',d=>d.x).attr('cy',d=>d.y);
    label.attr('x',d=>d.x).attr('y',d=>d.y);
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
  node.attr('opacity', n => connected.has(n.id) ? 1 : 0.15);
  link.attr('opacity', l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return (s===d.id||t===d.id) ? 1 : 0.05;
  });
}
svg.on('click', () => { node?.attr('opacity',1); link?.attr('opacity',0.6); });

// ─── Tooltip ───────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');
function showTooltip(event, d) {
  tooltip.innerHTML =
    '<strong>' + d.label + '</strong>' +
    '<span class="kind-badge" style="background:' + PALETTE[d.group] + '22;color:' + PALETTE[d.group] + '">' + d.kind + '</span><br>' +
    '<span style="color:#8b949e">' + (d.file || '') + '</span>';
  tooltip.classList.add('visible');
  moveTooltip(event);
}
function moveTooltip(event) {
  const x = event.clientX + 14, y = event.clientY - 10;
  tooltip.style.left = Math.min(x, window.innerWidth - 320) + 'px';
  tooltip.style.top  = y + 'px';
}
function hideTooltip() { tooltip.classList.remove('visible'); }

// ─── Controls ─────────────────────────────────────────────────────────────
const rerender = () => render(
  document.getElementById('filterKind').value,
  document.getElementById('search').value
);

document.getElementById('search').addEventListener('input', rerender);
document.getElementById('filterKind').addEventListener('change', rerender);

document.getElementById('linkStrength').addEventListener('input', () => {
  if (simulation) simulation.force('link').distance(+document.getElementById('linkStrength').value);
  simulation?.alpha(0.3).restart();
});
document.getElementById('charge').addEventListener('input', () => {
  if (simulation) simulation.force('charge').strength(+document.getElementById('charge').value);
  simulation?.alpha(0.3).restart();
});

let btnFreeze = document.getElementById('btnFreeze');
btnFreeze.addEventListener('click', () => {
  frozen = !frozen;
  btnFreeze.textContent = frozen ? '▶ Resume' : '⏸ Freeze';
  if (frozen) simulation?.stop();
  else simulation?.restart();
});

// ─── Initial render ────────────────────────────────────────────────────────
render('', '');
</script>
</body>
</html>`;
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface VisualizeOptions {
  /** Absolute path to write the HTML file */
  output: string;
  /** Project title shown in the header */
  title?: string;
}

export function generateVisualization(db: GraphDb, opts: VisualizeOptions): void {
  const graph = buildVizGraph(db);
  const title = opts.title ?? path.basename(opts.output, '.html');
  const html = generateHtml(graph, title);
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, html, 'utf-8');
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

export interface ServeOptions {
  port: number;
  title?: string;
}

export function serveVisualization(db: GraphDb, opts: ServeOptions): http.Server {
  const graph = buildVizGraph(db);
  const title = opts.title ?? 'Code Graph';
  const html  = generateHtml(graph, title);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  server.listen(opts.port);
  return server;
}
