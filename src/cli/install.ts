/**
 * cgb install — auto-configure MCP for Cursor, Claude Code, or custom path.
 *
 * Platforms:
 *   claude-code    → <root>/.mcp.json (project scope); `claude` is an alias
 *   claude-desktop → ~/.claude/claude_desktop_config.json (or %APPDATA%\Claude\claude_desktop_config.json)
 *   cursor         → .cursor/mcp.json
 *   vscode         → .vscode/mcp.json
 *
 * Also optionally:
 *   --skill      Generate .cursor/skills/cgb/SKILL.md with tool descriptions
 *   --hook       claude-code: PostToolUse hook in .claude/settings.json; others: "cgb:watch" script
 *   --claude-md  Insert a cgb guide block into the project CLAUDE.md (claude-code)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { debug } from '../util/log.js';

export interface InstallOptions {
  root: string;
  platform?: string;
  mcpPath?: string;
  skill: boolean;
  hook: boolean;
  claudeMd?: boolean;
  /** Injected for tests; defaults to process.platform */
  osPlatform?: NodeJS.Platform;
  /** Injected for tests; defaults to <package>/templates/claude-code */
  templatesDir?: string;
  /** Suppress console output (tests) */
  quiet?: boolean;
}

export const CLAUDE_MD_START = '<!-- cgb:start -->';
export const CLAUDE_MD_END = '<!-- cgb:end -->';
const HOOK_COMMAND = 'npx -y cgb-builder update --from-hook';

function defaultTemplatesDir(): string {
  // dist/cli/install.js -> ../../templates/claude-code (same relative path from src/cli)
  return path.resolve(__dirname, '..', '..', 'templates', 'claude-code');
}

/** Map user-facing platform names to canonical targets. */
export function normalizePlatform(platform: string): string {
  return platform === 'claude' ? 'claude-code' : platform;
}

// ─── Platform detection ───────────────────────────────────────────────────────

function detectPlatform(root: string): string {
  if (fs.existsSync(path.join(root, '.cursor'))) return 'cursor';
  if (fs.existsSync(path.join(root, '.vscode'))) return 'vscode';
  return 'cursor'; // sensible default
}

function getMcpConfigPath(platform: string, root: string): string {
  switch (platform) {
    case 'cursor':
      return path.join(root, '.cursor', 'mcp.json');
    case 'vscode':
      return path.join(root, '.vscode', 'mcp.json');
    case 'claude-code':
      return path.join(root, '.mcp.json');
    case 'claude-desktop': {
      if (process.platform === 'win32') {
        const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Claude', 'claude_desktop_config.json');
      }
      return path.join(os.homedir(), '.claude', 'claude_desktop_config.json');
    }
    default:
      return path.join(root, '.cursor', 'mcp.json');
  }
}

// ─── MCP config writers ───────────────────────────────────────────────────────

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
}

/** The `cgb` server entry. On Windows npx is a .cmd shim, so go through cmd /c. */
export function buildServerEntry(
  root: string,
  osPlatform: NodeJS.Platform = process.platform,
): McpServerEntry {
  const npxArgs = ['-y', 'cgb-builder', 'mcp', '--root', root];
  if (osPlatform === 'win32') return { command: 'cmd', args: ['/c', 'npx', ...npxArgs] };
  return { command: 'npx', args: npxArgs };
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err) {
    debug('install', `malformed JSON in ${file}, starting fresh`, err);
    return fallback;
  }
}

/** Merge the cgb server into an MCP config file without touching other servers. Idempotent. */
export function writeMcpConfig(
  configPath: string,
  root: string,
  osPlatform: NodeJS.Platform = process.platform,
  withEnv = false,
): void {
  const existing = readJson<McpConfig>(configPath, {});
  if (!existing.mcpServers) existing.mcpServers = {};

  const entry = buildServerEntry(root, osPlatform);
  if (withEnv) entry.env = { CGB_ROOT: root };
  existing.mcpServers['cgb'] = entry;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

// ─── Claude Code: hooks + CLAUDE.md ───────────────────────────────────────────

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type: string; command?: string }>;
}
interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

/** Merge the PostToolUse update hook into .claude/settings.json, preserving existing hooks. */
export function mergeClaudeHook(
  root: string,
  templatesDir: string = defaultTemplatesDir(),
): string {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const template = readJson<ClaudeSettings>(path.join(templatesDir, 'settings.hooks.json'), {
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: HOOK_COMMAND }] },
      ],
    },
  });
  const settings = readJson<ClaudeSettings>(settingsPath, {});
  if (!settings.hooks) settings.hooks = {};

  for (const [event, entries] of Object.entries(template.hooks ?? {})) {
    const current = settings.hooks[event] ?? [];
    for (const entry of entries) {
      const cmds = (entry.hooks ?? []).map((h) => h.command);
      const present = current.some((c) => (c.hooks ?? []).some((h) => cmds.includes(h.command)));
      if (!present) current.push(entry);
    }
    settings.hooks[event] = current;
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return settingsPath;
}

/** Insert or replace the marker-delimited cgb block in the project CLAUDE.md. */
export function upsertClaudeMd(root: string, templatesDir: string = defaultTemplatesDir()): string {
  const target = path.join(root, 'CLAUDE.md');
  const body = fs.readFileSync(path.join(templatesDir, 'CLAUDE.cgb.md'), 'utf-8').trim();
  const block = `${CLAUDE_MD_START}\n${body}\n${CLAUDE_MD_END}`;

  let existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  const startIdx = existing.indexOf(CLAUDE_MD_START);
  const endIdx = existing.indexOf(CLAUDE_MD_END);
  if (startIdx !== -1 && endIdx > startIdx) {
    existing = existing.slice(0, startIdx) + block + existing.slice(endIdx + CLAUDE_MD_END.length);
  } else {
    existing =
      existing.length > 0 ? existing.replace(/\s*$/, '') + '\n\n' + block + '\n' : block + '\n';
  }
  fs.writeFileSync(target, existing, 'utf-8');
  return target;
}

// ─── cgb update ───────────────────────────────────────────────────────────────

export interface UpdateOptions {
  root: string;
  files: string[];
  fromHook?: boolean;
  /** stdin text for --from-hook (injected for tests) */
  stdin?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf-8');
}

/** Extract tool_input.file_path from Claude Code hook JSON. */
export function filePathFromHook(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as { tool_input?: { file_path?: unknown } };
    const p = j.tool_input?.file_path;
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch (err) {
    debug('update', 'invalid hook JSON', err);
    return null;
  }
}

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Re-parse the given files (missing files are removed from the graph).
 * With fromHook it never throws and prints nothing on success.
 * Returns the number of files processed.
 */
export async function runUpdate(options: UpdateOptions): Promise<number> {
  const root = path.resolve(options.root);
  let files = options.files;
  try {
    if (options.fromHook) {
      const raw = options.stdin ?? (await readStdin());
      const p = filePathFromHook(raw);
      files = p ? [p] : [];
    }
    const abs = files.map((f) => path.resolve(root, f)).filter((f) => isInside(root, f));
    if (abs.length === 0) return 0;

    const { GraphDb } = await import('../graph/db.js');
    const { Parser } = await import('../parser/index.js');
    const { detectLanguage } = await import('../parser/utils.js');
    const db = new GraphDb(root);
    await db.init();
    try {
      const parser = new Parser(db, root);
      for (const f of abs) if (!fs.existsSync(f)) parser.removeFile(f);
      const parseable = abs.filter((f) => fs.existsSync(f) && detectLanguage(f));
      if (parseable.length > 0) await parser.parseFiles(parseable, true);
      db.persist();
    } finally {
      db.close();
    }
    return abs.length;
  } catch (err) {
    if (!options.fromHook) throw err;
    debug('update', 'hook update failed', err);
    return 0;
  }
}

// ─── Skill generation ─────────────────────────────────────────────────────────

const SKILL_CONTENT = `# Code Graph Builder (cgb) Skill

## When to use this skill

Use the **cgb** MCP tools whenever you need to:

- Understand the dependencies of a file before editing it
- Assess the blast-radius of a planned change
- Find entry points, call chains, or critical nodes
- Review incoming git changes with full context
- Navigate the architecture of a large codebase

## Available tools (30 total)

See [docs/MCP_TOOLS.md](https://github.com/vxlabs/cgb-builder/blob/main/docs/MCP_TOOLS.md) for the complete reference.

| Tool | Purpose |
|------|---------|
| \`cgb_init\` | Scan a project and build / refresh the code graph |
| \`cgb_deps\` | Get direct and transitive dependencies of a file |
| \`cgb_impact\` | Find all files affected by a change |
| \`cgb_symbol\` | Lookup a symbol by name or ID with callers/callees |
| \`cgb_callers\` | Who calls a symbol (BFS over calls edges) |
| \`cgb_callees\` | What a symbol calls (BFS over calls edges) |
| \`cgb_search\` | Full-text search (exact → prefix → BM25) with optional vector |
| \`cgb_bundle\` | Generate a compact AI context bundle for a file |
| \`cgb_stats\` | Graph statistics overview |
| \`cgb_path\` | Shortest dependency path between two files |
| \`cgb_detect_changes\` | Detect git changes with risk scoring |
| \`cgb_review_context\` | Build a full code-review context from git diff |
| \`cgb_large_functions\` | Find large/complex functions by connectivity |
| \`cgb_entry_points\` | Find call-chain entry points |
| \`cgb_call_chain\` | Trace a call chain from a node |
| \`cgb_criticality\` | Score nodes by business criticality |
| \`cgb_communities\` | Detect module clusters (Louvain) |
| \`cgb_architecture\` | High-level architecture overview |
| \`cgb_dead_code\` | Detect unreachable / dead code |
| \`cgb_rename_preview\` | Preview impact of renaming a symbol |
| \`cgb_apply_refactor\` | Apply a stored rename preview to disk |
| \`cgb_refactor_suggest\` | Structural refactoring suggestions |
| \`cgb_wiki_generate\` | Generate Markdown wiki from graph |
| \`cgb_wiki_section\` | Generate wiki for a single community |
| \`cgb_registry_register\` | Register a repo in the global registry |
| \`cgb_registry_list\` | List registered repos |
| \`cgb_registry_search\` | Cross-repo symbol search |
| \`cgb_embed_build\` | Compute and store vector embeddings for nodes |
| \`cgb_embed_search\` | (Deprecated: use cgb_search) Semantic similarity search |
| \`cgb_embed_similar\` | Find nodes similar to a given node |

## Workflow examples

### Before editing a file
\`\`\`
1. cgb_deps   → understand what the file depends on
2. cgb_impact → understand what depends on the file
3. cgb_bundle → load full AI context for editing session
\`\`\`

### Before merging a PR
\`\`\`
1. cgb_review_context → full review summary + risk score
2. cgb_dead_code      → check for newly introduced dead code
3. cgb_detect_changes → confirm blast radius
\`\`\`

### Debugging an issue
\`\`\`
1. cgb_entry_points → find candidate entry points
2. cgb_call_chain   → trace the execution path
3. cgb_criticality  → identify high-risk nodes in the chain
\`\`\`
`;

function writeSkill(root: string): void {
  const skillDir = path.join(root, '.cursor', 'skills', 'cgb');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_CONTENT, 'utf-8');
}

// ─── Hook injection ───────────────────────────────────────────────────────────

function addHook(root: string): void {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
    scripts?: Record<string, string>;
  };

  if (!pkg.scripts) pkg.scripts = {};

  if (pkg.scripts['cgb:watch']) return; // already present

  pkg.scripts['cgb:watch'] = 'cgb watch';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

// ─── Main entry point ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/require-await -- async kept for API/signature compatibility
export async function runInstall(options: InstallOptions): Promise<void> {
  const { root, skill, hook } = options;
  const log = (m: string): void => {
    if (!options.quiet) console.log(m);
  };
  const osPlatform = options.osPlatform ?? process.platform;
  const templatesDir = options.templatesDir ?? defaultTemplatesDir();

  const requested = options.platform;
  const platform = requested ? normalizePlatform(requested) : detectPlatform(root);
  const configPath = options.mcpPath ?? getMcpConfigPath(platform, root);

  log(`\ncgb install\n`);
  if (requested === 'claude') {
    log(
      `  Note: --platform claude now targets Claude Code (.mcp.json); use claude-desktop for Claude Desktop.`,
    );
  }
  log(`  Project root : ${root}`);
  log(`  Platform     : ${platform}`);
  log(`  MCP config   : ${configPath}\n`);

  writeMcpConfig(configPath, root, osPlatform, platform === 'claude-desktop');
  log(`MCP config written to: ${path.relative(root, configPath) || configPath}`);

  if (platform === 'claude-code') {
    log(
      `\nEquivalent command:\n  claude mcp add cgb --scope project -- npx -y cgb-builder mcp --root ${root}`,
    );
    if (hook) {
      const settingsPath = mergeClaudeHook(root, templatesDir);
      log(`Update hook added to: ${path.relative(root, settingsPath)}`);
    }
    if (options.claudeMd) {
      const target = upsertClaudeMd(root, templatesDir);
      log(`cgb guide written to: ${path.relative(root, target)}`);
    }
  } else if (hook) {
    addHook(root);
    log(`Added "cgb:watch" script to package.json`);
  }

  if (skill) {
    writeSkill(root);
    log(`Cursor skill written to: .cursor/skills/cgb/SKILL.md`);
  }

  log(`
Next steps:
  1. Restart your editor / Claude Code to pick up the new MCP server.
  2. Run \`cgb init\` to build the initial graph.
  3. Start asking the AI questions about your codebase!
`);
}
