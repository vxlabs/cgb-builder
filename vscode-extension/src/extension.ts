/**
 * CGB Explorer – VS Code Extension
 *
 * Exposes commands to explore the Code Graph Builder graph.db inside VS Code.
 * Graph data is read with better-sqlite3; the graph panel renders via D3.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type Database from 'better-sqlite3';

// ─── Types (mirrors src/types.ts) ────────────────────────────────────────────

interface GraphNode {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  isExternal: number;
  exportedAs?: string;
}

interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: string;
}

interface DbStats {
  files: number;
  nodes: number;
  edges: number;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function openDb(dbPath: string): Database.Database {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  return BetterSqlite3(dbPath, { readonly: true });
}

function getDbPath(workspaceRoot: string): string | null {
  const cfg = vscode.workspace.getConfiguration('cgb');
  const custom = cfg.get<string>('dbPath');
  if (custom && fs.existsSync(custom)) return custom;
  // default: <root>/.cgb/graph.db
  const defaultPath = path.join(workspaceRoot, '.cgb', 'graph.db');
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

function readStats(db: Database.Database): DbStats {
  const files = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
  const nodes = (db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n;
  const edges = (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n;
  return { files, nodes, edges };
}

function readNodes(db: Database.Database, limit = 500): GraphNode[] {
  return db.prepare(
    `SELECT id, name, kind, filePath, isExternal, exportedAs
     FROM nodes WHERE isExternal = 0 LIMIT ?`,
  ).all(limit) as GraphNode[];
}

function readEdges(db: Database.Database, limit = 2000): GraphEdge[] {
  return db.prepare(
    `SELECT e.id, e.fromId, e.toId, e.kind
     FROM edges e
     JOIN nodes a ON a.id = e.fromId AND a.isExternal = 0
     JOIN nodes b ON b.id = e.toId  AND b.isExternal = 0
     LIMIT ?`,
  ).all(limit) as GraphEdge[];
}

function searchNodes(db: Database.Database, query: string, limit = 20): GraphNode[] {
  const q = `%${query.toLowerCase()}%`;
  return db.prepare(
    `SELECT id, name, kind, filePath, isExternal, exportedAs
     FROM nodes WHERE LOWER(name) LIKE ? OR LOWER(filePath) LIKE ? LIMIT ?`,
  ).all(q, q, limit) as GraphNode[];
}

function getNeighbours(db: Database.Database, nodeId: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const outEdges = db.prepare(
    `SELECT e.id, e.fromId, e.toId, e.kind FROM edges e WHERE e.fromId = ?`,
  ).all(nodeId) as GraphEdge[];
  const inEdges = db.prepare(
    `SELECT e.id, e.fromId, e.toId, e.kind FROM edges e WHERE e.toId = ?`,
  ).all(nodeId) as GraphEdge[];
  const allEdges = [...outEdges, ...inEdges];
  const relatedIds = new Set(allEdges.flatMap(e => [e.fromId, e.toId]));
  const nodes = db.prepare(
    `SELECT id, name, kind, filePath, isExternal, exportedAs
     FROM nodes WHERE id IN (${[...relatedIds].map(() => '?').join(',')})`,
  ).all(...relatedIds) as GraphNode[];
  return { nodes, edges: allEdges };
}

// ─── Webview panel HTML ───────────────────────────────────────────────────────

function getWebviewHtml(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
  graphData: { nodes: GraphNode[]; edges: GraphEdge[]; stats: DbStats },
): string {
  const nonce = Math.random().toString(36).slice(2);
  const graphJson = JSON.stringify(graphData);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://d3js.org; style-src 'unsafe-inline';">
  <title>CGB Graph Explorer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1e1e1e; color: #ccc; font-family: system-ui, sans-serif; overflow: hidden; }
    #toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #252526; border-bottom: 1px solid #3c3c3c; }
    #toolbar input { flex: 1; background: #3c3c3c; border: none; border-radius: 4px; color: #ccc; padding: 4px 8px; font-size: 13px; }
    #toolbar button { background: #0e639c; border: none; border-radius: 4px; color: #fff; cursor: pointer; padding: 4px 10px; font-size: 12px; }
    #toolbar button:hover { background: #1177bb; }
    #stats { font-size: 11px; color: #888; white-space: nowrap; }
    #graph { width: 100vw; height: calc(100vh - 41px); }
    .node circle { cursor: pointer; }
    .node text { font-size: 10px; fill: #ccc; pointer-events: none; }
    .link { stroke: #555; stroke-width: 1; stroke-opacity: 0.7; }
    .link.IMPORTS { stroke: #4fc3f7; }
    .link.CALLS { stroke: #a5d6a7; }
    .link.CONTAINS { stroke: #fff176; }
    #tooltip { position: fixed; background: #252526; border: 1px solid #3c3c3c; border-radius: 4px; padding: 6px 10px; font-size: 11px; pointer-events: none; display: none; max-width: 300px; word-break: break-all; z-index: 999; }
  </style>
</head>
<body>
  <div id="toolbar">
    <input id="search" type="text" placeholder="Search nodes…" />
    <button id="resetBtn">Reset</button>
    <button id="fitBtn">Fit</button>
    <span id="stats"></span>
  </div>
  <svg id="graph"></svg>
  <div id="tooltip"></div>

  <script nonce="${nonce}" src="https://d3js.org/d3.v7.min.js"></script>
  <script nonce="${nonce}">
    const RAW = ${graphJson};

    const COLOR = {
      file: '#4fc3f7', function: '#a5d6a7', class: '#fff176',
      interface: '#f48fb1', type: '#ce93d8', variable: '#ffcc80',
      default: '#90a4ae',
    };

    const vscode = acquireVsCodeApi();
    const svg = d3.select('#graph');
    const width = () => window.innerWidth;
    const height = () => window.innerHeight - 41;

    let state = { nodes: RAW.nodes, edges: RAW.edges };

    document.getElementById('stats').textContent =
      \`\${RAW.stats.files} files · \${RAW.stats.nodes} nodes · \${RAW.stats.edges} edges (showing \${state.nodes.length}/\${state.edges.length})\`;

    // ─── simulation ──────────────────────────────────────────────────────────

    let sim;
    let gMain;

    function render(nodes, edges) {
      svg.selectAll('*').remove();

      const zoom = d3.zoom().scaleExtent([0.05, 5]).on('zoom', e => gMain.attr('transform', e.transform));
      svg.attr('width', width()).attr('height', height()).call(zoom);
      gMain = svg.append('g');

      const nodeMap = new Map(nodes.map(n => [n.id, { ...n, x: width() / 2 + (Math.random() - 0.5) * 400, y: height() / 2 + (Math.random() - 0.5) * 400 }]));
      const linkData = edges.filter(e => nodeMap.has(e.fromId) && nodeMap.has(e.toId));

      svg.append('defs').append('marker')
        .attr('id', 'arrow').attr('viewBox', '0 -5 10 10').attr('refX', 18).attr('refY', 0)
        .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#555');

      const link = gMain.append('g').selectAll('line').data(linkData).join('line')
        .attr('class', d => \`link \${d.kind}\`)
        .attr('marker-end', 'url(#arrow)');

      const tooltip = document.getElementById('tooltip');

      const node = gMain.append('g').selectAll('g').data([...nodeMap.values()]).join('g')
        .attr('class', 'node')
        .call(d3.drag()
          .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
          .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }),
        )
        .on('mouseover', (e, d) => {
          tooltip.style.display = 'block';
          tooltip.innerHTML = \`<b>\${d.name}</b><br>\${d.kind}<br><span style="color:#888">\${d.filePath}</span>\`;
        })
        .on('mousemove', e => { tooltip.style.left = (e.clientX + 12) + 'px'; tooltip.style.top = (e.clientY + 12) + 'px'; })
        .on('mouseout',  () => { tooltip.style.display = 'none'; })
        .on('click', (e, d) => {
          vscode.postMessage({ command: 'nodeClick', nodeId: d.id, filePath: d.filePath });
        });

      node.append('circle').attr('r', d => d.kind === 'file' ? 7 : 5)
        .attr('fill', d => COLOR[d.kind] ?? COLOR.default)
        .attr('stroke', '#1e1e1e').attr('stroke-width', 1.5);

      node.append('text').text(d => d.name.slice(0, 20)).attr('dx', 8).attr('dy', 4);

      sim = d3.forceSimulation([...nodeMap.values()])
        .force('link', d3.forceLink(linkData).id(d => d.id).distance(60))
        .force('charge', d3.forceManyBody().strength(-80))
        .force('center', d3.forceCenter(width() / 2, height() / 2))
        .on('tick', () => {
          link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
              .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
          node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
        });

      document.getElementById('fitBtn').onclick = () => {
        svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
      };
      document.getElementById('resetBtn').onclick = () => render(state.nodes, state.edges);
    }

    render(state.nodes, state.edges);

    // ─── search ──────────────────────────────────────────────────────────────

    const searchInput = document.getElementById('search');
    let debounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const q = searchInput.value.trim().toLowerCase();
        if (!q) { render(state.nodes, state.edges); return; }
        const matched = new Set(state.nodes.filter(n =>
          n.name.toLowerCase().includes(q) || n.filePath.toLowerCase().includes(q),
        ).map(n => n.id));
        const filteredEdges = state.edges.filter(e => matched.has(e.fromId) || matched.has(e.toId));
        const involvedIds = new Set(filteredEdges.flatMap(e => [e.fromId, e.toId]));
        [...matched].forEach(id => involvedIds.add(id));
        render(state.nodes.filter(n => involvedIds.has(n.id)), filteredEdges);
      }, 200);
    });

    // ─── messages from extension ─────────────────────────────────────────────

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.command === 'updateGraph') {
        state = msg.graphData;
        render(state.nodes, state.edges);
        document.getElementById('stats').textContent =
          \`Showing \${state.nodes.length} nodes · \${state.edges.length} edges\`;
      }
    });

    window.addEventListener('resize', () => {
      svg.attr('width', width()).attr('height', height());
    });
  </script>
</body>
</html>`;
}

// ─── Extension entry points ───────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function openGraphPanel(context: vscode.ExtensionContext): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('CGB: No workspace folder open.');
    return;
  }
  const dbPath = getDbPath(root);
  if (!dbPath) {
    const choice = await vscode.window.showErrorMessage(
      'CGB: graph.db not found. Run `cgb init` to build the graph first.',
      'Open Terminal',
    );
    if (choice === 'Open Terminal') {
      const term = vscode.window.createTerminal('CGB Init');
      term.show();
      term.sendText('cgb init');
    }
    return;
  }

  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  const db = openDb(dbPath);
  const stats = readStats(db);
  const nodes = readNodes(db);
  const edges = readEdges(db);
  db.close();

  currentPanel = vscode.window.createWebviewPanel(
    'cgbGraph',
    'CGB Graph Explorer',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  currentPanel.webview.html = getWebviewHtml(currentPanel, context.extensionUri, { nodes, edges, stats });

  currentPanel.webview.onDidReceiveMessage(
    (msg: { command: string; filePath?: string }) => {
      if (msg.command === 'nodeClick' && msg.filePath) {
        const fullPath = path.isAbsolute(msg.filePath)
          ? msg.filePath
          : path.join(root, msg.filePath);
        if (fs.existsSync(fullPath)) {
          vscode.workspace.openTextDocument(fullPath).then(
            (doc: vscode.TextDocument) => vscode.window.showTextDocument(doc),
          );
        }
      }
    },
    undefined,
    context.subscriptions,
  );

  currentPanel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);
}

async function showDepsForActiveFile(context: vscode.ExtensionContext): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;
  const dbPath = getDbPath(root);
  if (!dbPath) { vscode.window.showWarningMessage('CGB: Run `cgb init` first.'); return; }

  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!activeFile) { vscode.window.showWarningMessage('CGB: Open a source file first.'); return; }

  const relPath = path.relative(root, activeFile);
  const db = openDb(dbPath);
  const stats = readStats(db);
  const fileId = `file:${activeFile}`;
  const { nodes, edges } = getNeighbours(db, fileId);
  // include the focal node itself
  const focal = db.prepare('SELECT id, name, kind, filePath, isExternal, exportedAs FROM nodes WHERE id = ?').get(fileId) as GraphNode | undefined;
  if (focal && !nodes.find(n => n.id === focal.id)) nodes.unshift(focal);
  db.close();

  if (nodes.length === 0) {
    vscode.window.showInformationMessage(`CGB: No graph data found for ${relPath}. Run \`cgb init\` if needed.`);
    return;
  }

  if (!currentPanel) {
    await openGraphPanel(context);
    // slight delay to let webview render
    await new Promise(r => setTimeout(r, 500));
  }

  currentPanel?.webview.postMessage({ command: 'updateGraph', graphData: { nodes, edges, stats } });
  currentPanel?.reveal();
}

async function showGraphStats(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;
  const dbPath = getDbPath(root);
  if (!dbPath) { vscode.window.showWarningMessage('CGB: graph.db not found. Run `cgb init` first.'); return; }

  const db = openDb(dbPath);
  const stats = readStats(db);
  db.close();

  vscode.window.showInformationMessage(
    `CGB Graph: ${stats.files} files · ${stats.nodes} nodes · ${stats.edges} edges`,
  );
}

// ─── activate / deactivate ────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('cgb.openGraph',  () => openGraphPanel(context)),
    vscode.commands.registerCommand('cgb.showDeps',   () => showDepsForActiveFile(context)),
    vscode.commands.registerCommand('cgb.showImpact', () => showDepsForActiveFile(context)),
    vscode.commands.registerCommand('cgb.showStats',  () => showGraphStats()),
  );
}

export function deactivate(): void {
  currentPanel?.dispose();
}
