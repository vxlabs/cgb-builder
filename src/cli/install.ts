/**
 * cgb install — auto-configure MCP for Cursor, Claude Code, or custom path.
 *
 * Platforms detected:
 *   cursor      → .cursor/mcp.json
 *   claude      → ~/.claude/claude_desktop_config.json (or %APPDATA%\Claude\claude_desktop_config.json)
 *   vscode      → .vscode/mcp.json
 *
 * Also optionally:
 *   --skill     Generate .cursor/skills/cgb/SKILL.md with tool descriptions
 *   --hook      Add "cgb:watch" script to package.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface InstallOptions {
  root: string;
  platform?: string;
  mcpPath?: string;
  skill: boolean;
  hook: boolean;
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
    case 'claude': {
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

interface McpConfig {
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

function writeMcpConfig(configPath: string, root: string): void {
  // Read existing config if present
  let existing: McpConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as McpConfig;
    } catch {
      // malformed — start fresh
    }
  }

  if (!existing.mcpServers) existing.mcpServers = {};

  existing.mcpServers['cgb'] = {
    command: 'npx',
    args: ['cgb', 'mcp'],
    env: { CGB_ROOT: root },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
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

## Available tools

| Tool | Purpose |
|------|---------|
| \`cgb_init\` | Scan a project and build / refresh the code graph |
| \`cgb_deps\` | Get direct and transitive dependencies of a file |
| \`cgb_impact\` | Find all files affected by a change |
| \`cgb_search\` | Full-text search over node names, paths, and descriptions |
| \`cgb_bundle\` | Generate a compact AI context bundle for a file |
| \`cgb_stats\` | Graph statistics overview |
| \`cgb_path\` | Shortest dependency path between two files |
| \`cgb_detect_changes\` | Detect git changes with risk scoring |
| \`cgb_review_context\` | Build a full code-review context from git diff |
| \`cgb_large_functions\` | Find large/complex functions by connectivity |
| \`cgb_entry_points\` | Find call-chain entry points |
| \`cgb_call_chain\` | Trace a call chain from a node |
| \`cgb_criticality\` | Score nodes by business criticality |
| \`cgb_communities\` | Detect module clusters |
| \`cgb_architecture\` | High-level architecture overview |
| \`cgb_dead_code\` | Detect unreachable / dead code |
| \`cgb_rename_preview\` | Preview impact of renaming a symbol |
| \`cgb_refactor_suggest\` | Structural refactoring suggestions |
| \`cgb_wiki_generate\` | Generate Markdown wiki from graph |
| \`cgb_wiki_section\` | Generate wiki for a single community |
| \`cgb_registry_register\` | Register a repo in the global registry |
| \`cgb_registry_list\` | List registered repos |
| \`cgb_registry_search\` | Cross-repo symbol search |
| \`cgb_embed_search\` | Semantic similarity search over nodes |
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

export async function runInstall(options: InstallOptions): Promise<void> {
  const { root, skill, hook } = options;

  const platform = options.platform ?? detectPlatform(root);
  const configPath = options.mcpPath ?? getMcpConfigPath(platform, root);

  console.log(`\n🔧 cgb install\n`);
  console.log(`  Project root : ${root}`);
  console.log(`  Platform     : ${platform}`);
  console.log(`  MCP config   : ${configPath}\n`);

  // Write MCP config
  writeMcpConfig(configPath, root);
  console.log(`✅ MCP config written to: ${path.relative(root, configPath)}`);

  // Optional: skill
  if (skill) {
    writeSkill(root);
    console.log(`✅ Cursor skill written to: .cursor/skills/cgb/SKILL.md`);
  }

  // Optional: hook
  if (hook) {
    addHook(root);
    console.log(`✅ Added "cgb:watch" script to package.json`);
  }

  console.log(`
Next steps:
  1. Restart Cursor / Claude Code to pick up the new MCP server.
  2. Run \`cgb init\` (or call cgb_init from the AI) to build the initial graph.
  3. Start asking the AI questions about your codebase!
`);
}
