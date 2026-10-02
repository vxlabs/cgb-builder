# CGB CLI Command Reference

## Global Options

| Flag | Description |
|------|-------------|
| `--help` | Show help |
| `--version` | Print version |

### Common per-command options

Every command that reads or writes the graph accepts:

| Option | Description |
|--------|-------------|
| `-r, --root <path>` | Project root (default: cwd) |
| `--db-dir <path>` | Directory holding `graph.db`. Precedence: `--db-dir` > env `CGB_DB_DIR` > `<root>/.cgb`. |

Paths inside the DB are stored **relative to the project root**, so one cached DB can be reused by any
worktree/checkout of the same repository. A DB written by cgb < 1.2.0 stores absolute paths; rebuild it
with `cgb init --force`.

---

## `cgb init [root]`

Scan a directory and build (or refresh) the code graph.

```
cgb init [path] [--root <path>] [--db-dir <path>] [--force] [--watch]
```

| Argument / option | Default | Description |
|-------------------|---------|-------------|
| `path` | `.` (cwd) | Project root to scan (same as `--root`) |
| `--force` | off | Re-parse files even if unchanged |
| `--watch` | off | Keep watching after the scan |

Files that no longer exist are pruned from the graph on every scan.

Output: `<db-dir>/graph.db` (default `.cgb/graph.db`)

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

Show entry points, critical nodes and large functions, or trace a call chain.

| Option | Description |
|--------|-------------|
| `--chain <entry>` | Trace the call chain from a node id, file path or exact symbol name |
| `--depth <n>` | Max depth for `--chain` (default: 5) |
| `--top <n>` | Max entries per list (default: 20) |
| `--json` | JSON: `{entryPoints, criticalNodes, largeFunctions}` (or an array of steps with `--chain`); paths root-relative |

---

## `cgb communities [options]`

Detect and display architectural communities (weighted Louvain). Read-only: nothing is persisted.

| Option | Description |
|--------|-------------|
| `--top <n>` | Show only the N largest communities (default: all) |
| `--overview` | Architecture overview instead: layers, cycles, orphans, coupling, health score |
| `--json` | JSON output; paths root-relative |

---

## `cgb refactor <subcommand>`

| Subcommand | Description |
|------------|-------------|
| `dead-code` | Find unused exports |
| `suggest` | High-impact refactoring hints |
| `rename-preview <nodeId>` | Preview rename impact |

---

## `cgb wiki [options]`

Generate Markdown documentation from graph communities.

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | `<root>/wiki` | Output directory |
| `--json` | off | Print `[{communityId, title, files[], markdown}]` to stdout instead of writing files. File paths and markdown are root-relative and contain no timestamps; the last entry is the index page with `communityId: "index"`. |

---

## `cgb detect-changes` / `cgb review-context`

```
cgb detect-changes  [--base <ref>] [--json]
cgb review-context  [--base <ref>] [--format markdown|json] [--output <file>]
```

`review-context --format json` is deterministic: arrays are sorted, there are no timestamps, and every path is
relative to the project root, so the same repo state yields byte-identical output regardless of where it is checked out.

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

## `cgb install <platform>`

Configure the MCP server for AI platforms.

Platforms: `cursor` | `claude` | `vscode`

| Option | Description |
|--------|-------------|
| `--mcp-port <n>` | Custom MCP server port |

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
cgb mcp [--root <path>] [--db-dir <path>] [--read-only]
```

| Option | Description |
|--------|-------------|
| `--root <path>` | Default `root` for tool calls that omit it |
| `--db-dir <path>` | Directory holding `graph.db` |
| `--read-only` | Register only non-mutating tools; never writes the DB or the filesystem. Communities are detected but not persisted, embedding queries never call a remote provider, prompts are not served, and the DB must already exist (`cgb init`). |

Tools served with `--read-only`: `cgb_deps`, `cgb_impact`, `cgb_search`, `cgb_bundle`, `cgb_stats`, `cgb_path`,
`cgb_detect_changes`, `cgb_review_context`, `cgb_large_functions`, `cgb_entry_points`, `cgb_call_chain`,
`cgb_criticality`, `cgb_communities`, `cgb_architecture`, `cgb_dead_code`, `cgb_rename_preview`,
`cgb_refactor_suggest`, `cgb_wiki_section`, `cgb_registry_list`, `cgb_registry_search`, `cgb_embed_search`,
`cgb_embed_similar`.
