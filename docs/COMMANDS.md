# CGB CLI Command Reference

## Global Options

| Flag | Description |
|------|-------------|
| `--help` | Show help |
| `--version` | Print version |

---

## `cgb init [root]`

Scan a directory and build (or refresh) the code graph.

```
cgb init [root]
```

| Argument | Default | Description |
|----------|---------|-------------|
| `root` | `.` (cwd) | Project root to scan |

Output: `.cgb/graph.db`

---

## `cgb bundle <target>`

Generate an AI-optimised context bundle for a file.

```
cgb bundle <target> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--depth <n>` | `2` | Transitive dependency depth |
| `--no-source` | — | Exclude the file's raw source |

---

## `cgb deps <target>`

Print all imports of a file.

```
cgb deps <target> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--depth <n>` | `3` | Traversal depth |

---

## `cgb impact <target>`

Show which files would be affected by changes to `target`.

```
cgb impact <target> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--depth <n>` | `10` | Max traversal depth |

---

## `cgb path <from> <to>`

Shortest dependency path between two files.

---

## `cgb search <query>`

Full-text search across node names and file paths.

---

## `cgb stats`

Show graph statistics (files, nodes, edges, orphans, cycles).

---

## `cgb flows [options]`

Show entry points and critical call chains.

| Option | Description |
|--------|-------------|
| `--chain <entry>` | Trace the call chain from a specific entry point |
| `--top <n>` | Top N critical nodes (default: 10) |

---

## `cgb communities [options]`

Detect and display architectural communities.

| Option | Description |
|--------|-------------|
| `--top <n>` | Show top N communities (default: 10) |
| `--overview` | Print single-paragraph architecture overview |

---

## `cgb refactor <subcommand>`

| Subcommand | Description |
|------------|-------------|
| `dead-code` | Find unused exports |
| `suggestions` | High-impact refactoring hints |
| `rename <file> <new-name>` | Preview rename impact |

---

## `cgb wiki [options]`

Generate Markdown documentation from graph communities.

| Option | Default | Description |
|--------|---------|-------------|
| `--out <dir>` | `./wiki` | Output directory |
| `--top <n>` | `10` | Communities to document |

---

## `cgb viz [options]`

Generate an interactive D3 graph visualisation.

| Option | Default | Description |
|--------|---------|-------------|
| `--out <file>` | `cgb-graph.html` | Output HTML file |
| `--max-nodes <n>` | `500` | Node limit for performance |
| `--serve` | — | Open in browser immediately |
| `--port <n>` | `4242` | Port when `--serve` |

---

## `cgb registry <subcommand>`

| Subcommand | Description |
|------------|-------------|
| `register [root] [name]` | Add a repo to the global registry |
| `unregister <name>` | Remove a repo from the registry |
| `list` | List all registered repos |
| `search <query>` | Search nodes across all registered repos |

---

## `cgb install`

Configure the MCP server for AI platforms.

```
cgb install --platform claude-code|claude|claude-desktop|cursor|vscode [--hook] [--claude-md] [-r root]
```

| Option | Description |
|--------|-------------|
| `--platform <name>` | `claude-code` writes project `.mcp.json`; `claude` is an alias of `claude-code`; `claude-desktop` writes the Desktop config |
| `--hook` | claude-code: add a `PostToolUse` hook to `.claude/settings.json` running `cgb update --from-hook` (other platforms: add a `cgb:watch` script) |
| `--claude-md` | claude-code: insert/replace a cgb guide block in `CLAUDE.md` between `<!-- cgb:start -->` / `<!-- cgb:end -->` |
| `--skill` | Also write a Cursor skill snippet |
| `--mcp-path <path>` | Explicit config file to write |
| `-r, --root <path>` | Project root (default: cwd) |

---

## `cgb update [files...]`

Re-parse only the given files (runs the linker). A missing file is treated as deleted.

```
cgb update [files...] [-r root] [--from-hook]
```

`--from-hook` reads Claude Code hook JSON on stdin, takes `tool_input.file_path`, updates it silently
(files outside the root are ignored) and always exits 0.

---

## `cgb eval <subcommand>`

| Subcommand | Description |
|------------|-------------|
| `run [benchmark]` | Run benchmarks against OSS repos |
| `list-repos` | List configured benchmark repos |

`run` options:

| Option | Description |
|--------|-------------|
| `--repos <names>` | Comma-separated repo names |
| `--work-dir <path>` | Working directory for clones |
| `--csv <file>` | Write CSV report |
| `--md <file>` | Write Markdown report |

---

## `cgb mcp`

Start the MCP server (used by AI agents).

```
cgb mcp [-r, --root <path>]
```

`--root` sets the default project root (exported as `CGB_ROOT`); otherwise `CGB_ROOT` or the cwd is used.
