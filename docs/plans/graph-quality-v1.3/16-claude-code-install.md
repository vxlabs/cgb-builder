# Slice 16: Claude Code install, `cgb update`, watcher fixes

## Goal
Make CGB one command to install into Claude Code, and keep it fresh while Claude edits. Today:
- `cgb install --platform claude` writes **Claude Desktop** config and uses `npx cgb mcp`, but the package is `cgb-builder`.
- `cgb mcp --root` is ignored.
- There's no `cgb update <file>` for hooks.
- `cgb init --watch` closes the DB before starting the watcher.
- The watcher's ignore regexes match anywhere in the absolute path. `/build/` matches `code_graph_builder`, so watching this very repo ignores every file.

## Prerequisites
- 01: `src/util/log.ts`.
- This slice is independent of 14. 14 reads `process.env.CGB_ROOT`; this slice sets it.

## Files touched
- `src/cli/index.ts`
- `src/cli/install.ts`
- `src/watcher/index.ts`
- `templates/claude-code/CLAUDE.cgb.md` (new)
- `templates/claude-code/settings.hooks.json` (new)
- `src/cli/__tests__/install.test.ts` (new)
- `src/watcher/__tests__/watcher.test.ts` (new)
- **Don't edit `package.json`**, since track B owns it during this wave. Slice 19 adds `templates` to the `files` array. Until then, resolve templates relative to `__dirname` (`../../templates/...` from `dist/cli/`), which works in a repo checkout.
- `docs/USAGE.md`, `docs/COMMANDS.md` (owned by track E)

## Suggested model
Sonnet

## Read only these files
- `src/cli/index.ts` (about 790 lines; focus on the `init`, `watch`, `install` and `mcp` commands)
- `src/cli/install.ts`, `src/watcher/index.ts`
- `src/parser/index.ts`: `Parser` constructor and `parseFiles` signature (read only)
- `docs/USAGE.md`, `docs/COMMANDS.md`

## Background
Decisions (final):
- **D9**: the MCP server resolves root as `args.root ?? process.env.CGB_ROOT ?? process.cwd()`. The CLI `mcp` command must set `process.env.CGB_ROOT = path.resolve(opts.root)` before calling `startMcpServer()`.
- **D11**: the Claude Code install writes a **project `.mcp.json`**:
  ```json
  { "mcpServers": { "cgb": { "command": "npx", "args": ["-y", "cgb-builder", "mcp", "--root", "<abs root>"] } } }
  ```
  It merges into an existing file, never clobbering other servers, and is idempotent. It also prints the equivalent `claude mcp add cgb --scope project -- npx -y cgb-builder mcp --root <abs>`. On Windows, use `"command": "cmd", "args": ["/c", "npx", ...]`, since npx is a `.cmd` shim.
- The hook template is opt-in, enabled by `--hook`. Merge into `.claude/settings.json`:
  ```json
  { "hooks": { "PostToolUse": [ { "matcher": "Edit|Write|MultiEdit",
      "hooks": [ { "type": "command", "command": "npx -y cgb-builder update --from-hook" } ] } ] } }
  ```
  `cgb update --from-hook` reads the hook JSON from stdin and takes `tool_input.file_path`. It updates that file silently and **always exits 0**, so a failure never blocks Claude's edit.
- **D12**: stderr only. `cgb update --from-hook` prints nothing on success.
- Keep the existing platforms (cursor, claude-desktop). Rename the existing `claude` target to `claude-desktop`, and keep `claude` as an alias that **now means Claude Code**. Print a one-line notice about the change.

New CLI commands and flags:
- `cgb update [files...] [-r root] [--from-hook]` re-parses only the given files (`Parser.parseFiles(abs, true)`, which runs the linker). A missing file is treated as deleted and removed.
- `cgb install --platform claude-code|claude|claude-desktop|cursor [--hook] [--claude-md] [-r root]`
  - `--claude-md` appends `templates/claude-code/CLAUDE.cgb.md` into the project `CLAUDE.md`, between `<!-- cgb:start -->` / `<!-- cgb:end -->` markers. On re-run it replaces the block between the markers.
  - `CLAUDE.cgb.md` content: a short guide.
    - When to use the cgb tools instead of grep: `cgb_symbol` first when you know a name, `cgb_callers`/`cgb_callees` for who-calls, `cgb_impact` before changing shared code, `cgb_bundle` for focused context, `cgb_search` for fuzzy lookup.
    - Root is automatic. Use `Read` with the returned line ranges.
    - Keep it under 40 lines.
- `cgb init --watch` keeps the DB open, or reopens it, for the watcher.

Watcher fix: match ignore patterns against the **repo-relative, forward-slash path**, segment-anchored:
- `(^|/)node_modules(/|$)`, and similarly for `.git`, `dist`, `build`, `out`, `bin`, `obj`, `.cgb`, `coverage`
- also honour `.gitignore` if the code already has a helper; otherwise leave it

## Tasks
1. Implement the `mcp --root` → `CGB_ROOT` wiring, `cgb update`, the install changes, the templates and the watcher fix.
2. Write `install.test.ts` (temp dir):
   - `.mcp.json` is created
   - merge preserves another server
   - re-running is idempotent
   - the Windows command shape (inject the platform)
   - the hook merge preserves existing hooks
   - the CLAUDE.md marker block is inserted, then replaced on re-run
   - `update --from-hook` with stdin JSON for a file in the root, and for a file outside the root (ignored, exit 0)
3. Write `watcher.test.ts`: for a root path containing `code_graph_builder`, files are not ignored, while `node_modules/x.ts` and `dist/a.js` are. Unit-test the predicate; don't start chokidar unless that's easy.
4. Update `docs/USAGE.md` (a Claude Code quick start: install, optional hook, CLAUDE.md block) and `docs/COMMANDS.md` (`update`, `install` flags, `mcp --root`).

## Out of scope
- `src/mcp/*` (14/15).
- README (19).
- Plugin manifests in `.claude-plugin/` (19).

## Done when
```
npx tsc --noEmit
npx jest src/cli src/watcher
npx jest
npm run build
node dist/cli/index.js install --platform claude-code -r <temp dir> && cat <temp dir>/.mcp.json
echo '{"tool_input":{"file_path":"'$PWD'/src/index.ts"}}' | node dist/cli/index.js update --from-hook -r . ; echo "exit=$?"
```
All pass, the `.mcp.json` is correct, and the hook run exits 0 with no stdout.

## Finish
1. Tick `- [x] 16` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-16): Claude Code install (.mcp.json, hook, CLAUDE.md), cgb update, watcher ignore fix`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, and the generated `.mcp.json` and hook snippet.
