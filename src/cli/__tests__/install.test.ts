import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runInstall,
  runUpdate,
  buildServerEntry,
  filePathFromHook,
  CLAUDE_MD_START,
  CLAUDE_MD_END,
} from '../install';

const templatesDir = path.resolve(__dirname, '..', '..', '..', 'templates', 'claude-code');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-install-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const install = (extra: Record<string, unknown> = {}) =>
  runInstall({
    root,
    platform: 'claude-code',
    skill: false,
    hook: false,
    quiet: true,
    osPlatform: 'linux',
    templatesDir,
    ...extra,
  });
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

describe('install claude-code', () => {
  it('creates .mcp.json', async () => {
    await install();
    expect(readJson(path.join(root, '.mcp.json'))).toEqual({
      mcpServers: { cgb: { command: 'npx', args: ['-y', 'cgb-builder', 'mcp', '--root', root] } },
    });
  });

  it('preserves other servers and is idempotent', async () => {
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }),
    );
    await install();
    const first = fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8');
    await install();
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8')).toBe(first);
    const cfg = readJson(path.join(root, '.mcp.json'));
    expect(cfg.mcpServers.other).toEqual({ command: 'x', args: [] });
    expect(Object.keys(cfg.mcpServers)).toEqual(['other', 'cgb']);
  });

  it('uses cmd /c on Windows', () => {
    // eslint-disable-next-line no-useless-escape -- literal Windows path fixture
    expect(buildServerEntry('C:\p', 'win32')).toEqual({
      command: 'cmd',
      // eslint-disable-next-line no-useless-escape -- literal Windows path fixture
      args: ['/c', 'npx', '-y', 'cgb-builder', 'mcp', '--root', 'C:\p'],
    });
  });

  it('treats --platform claude as claude-code', async () => {
    await install({ platform: 'claude' });
    expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(true);
  });

  it('merges the hook and keeps existing hooks, idempotently', async () => {
    const settings = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings));
    fs.writeFileSync(
      settings,
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        },
      }),
    );
    await install({ hook: true });
    await install({ hook: true });
    const s = readJson(settings);
    expect(s.permissions.allow).toEqual(['Bash(ls)']);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe('echo hi');
    expect(s.hooks.PostToolUse[1]).toEqual({
      matcher: 'Edit|Write|MultiEdit',
      hooks: [{ type: 'command', command: 'npx -y cgb-builder update --from-hook' }],
    });
  });

  it('inserts then replaces the CLAUDE.md block', async () => {
    const md = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(md, '# Mine\n\nkeep me\n');
    await install({ claudeMd: true });
    let text = fs.readFileSync(md, 'utf-8');
    expect(text).toContain('keep me');
    expect(text).toContain(CLAUDE_MD_START);
    expect(text).toContain('cgb_symbol');

    text = text.replace('cgb_symbol', 'STALE_MARKER') + '\nafter block\n';
    fs.writeFileSync(md, text);
    await install({ claudeMd: true });
    const again = fs.readFileSync(md, 'utf-8');
    expect(again).not.toContain('STALE_MARKER');
    expect(again).toContain('cgb_symbol');
    expect(again).toContain('after block');
    expect(again.split(CLAUDE_MD_START)).toHaveLength(2);
    expect(again.split(CLAUDE_MD_END)).toHaveLength(2);
  });

  it('keeps CLAUDE.cgb.md under 40 lines', () => {
    const lines = fs.readFileSync(path.join(templatesDir, 'CLAUDE.cgb.md'), 'utf-8').split('\n');
    expect(lines.length).toBeLessThan(40);
  });
});

describe('update --from-hook', () => {
  it('parses hook JSON', () => {
    expect(filePathFromHook('{"tool_input":{"file_path":"/a/b.ts"}}')).toBe('/a/b.ts');
    expect(filePathFromHook('not json')).toBeNull();
    expect(filePathFromHook('{}')).toBeNull();
  });

  it('updates a file inside the root', async () => {
    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'export function hello() { return 1; }\n');
    const n = await runUpdate({
      root,
      files: [],
      fromHook: true,
      stdin: JSON.stringify({ tool_input: { file_path: file } }),
    });
    expect(n).toBe(1);
    expect(fs.existsSync(path.join(root, '.cgb'))).toBe(true);
  });

  it('ignores a file outside the root and does not throw', async () => {
    const outside = path.join(os.tmpdir(), 'cgb-outside-file.ts');
    const n = await runUpdate({
      root,
      files: [],
      fromHook: true,
      stdin: JSON.stringify({ tool_input: { file_path: outside } }),
    });
    expect(n).toBe(0);
    expect(fs.existsSync(path.join(root, '.cgb'))).toBe(false);
  });

  it('swallows garbage stdin', async () => {
    await expect(runUpdate({ root, files: [], fromHook: true, stdin: '%%%' })).resolves.toBe(0);
  });
});
