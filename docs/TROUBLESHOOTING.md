# CGB Troubleshooting

## `cgb init` errors

### "Cannot read file" / parse errors on TypeScript files

**Symptom:** Parser warns about certain `.ts` files.

**Cause:** Decorators or advanced syntax unsupported by the heuristic parser.

**Fix:** These files are skipped; the rest of the graph is still built. Open an issue with the offending snippet.

---

### `graph.db` grows very large

**Symptom:** `.cgb/graph.db` is several hundred MB.

**Cause:** The repo has many generated files (e.g., `dist/`, `__generated__/`).

**Fix:** Create `.cgbignore` in the project root with glob patterns to exclude:

```
dist/**
**/__generated__/**
node_modules/**
```

---

## MCP server issues

### Cursor / Claude Code shows "tool not found"

**Fix:**
1. Run `cgb install cursor` (or `cgb install claude`) to regenerate the config.
2. Restart the editor.
3. Verify `.cursor/mcp.json` (or `~/.config/claude/mcp.json`) contains `cgb-builder`.

---

### MCP server exits immediately

**Fix:** Check that the graph has been built first:

```bash
cgb init      # build .cgb/graph.db
cgb mcp       # start MCP server
```

---

## Visualisation issues

### `cgb viz --serve` opens blank page

**Fix:** The HTML is self-contained but requires a browser that allows ES modules from `localhost`.  
Try: `cgb viz --out graph.html` and open the file directly.

---

### Graph is too dense to read

**Fix:** Use `--max-nodes` to reduce the node count:

```bash
cgb viz --max-nodes 100 --serve
```

---

## Multi-repo issues

### `cgb registry search` returns no results

**Fix:**
1. Ensure repos are registered: `cgb registry list`
2. Ensure each registered repo has a built graph (`cgb init` inside the repo).

---

## General

### `Cannot find module 'better-sqlite3'`

**Fix:**

```bash
npm rebuild better-sqlite3   # recompile for current Node version
```

If that fails, ensure you have a C++ compiler installed:

- **Windows:** Install "Desktop development with C++" from the VS Build Tools installer.
- **macOS:** `xcode-select --install`
- **Linux:** `apt install build-essential`

#### Native module install (better-sqlite3)

CGB stores its graph with `better-sqlite3`, a native module. `npm install` normally downloads a
prebuilt binary for Node 20/22 on Windows, macOS and Linux. If no prebuild matches your
platform or Node version, npm falls back to a source build, which needs a C++ toolchain:

- **Windows:** install Visual Studio Build Tools ("Desktop development with C++") and Python 3.
  If the wrong toolset is picked, set `npm config set msvs_version 2022` (or your installed
  version) and re-run `npm install`.
- Use Node >= 20 (an unsupported Node version is the most common cause of a missing prebuild).
- After switching Node versions run `npm rebuild better-sqlite3`.
- An old `.cgb/graph.db` written by a pre-1.3 (sql.js) build is detected and rebuilt
  automatically; re-run `cgb init` afterwards.

---

### Viz server not reachable from another machine

`cgb viz` listens on `127.0.0.1` only by default. To expose it on another interface (for example in a container), set `CGB_VIZ_HOST`, e.g. `CGB_VIZ_HOST=0.0.0.0 cgb viz`. Only do this on a trusted network; the viz has no authentication.

---

### detect-changes shows files I did not commit

`detect-changes` (and the MCP change tools) now include uncommitted work. With no `--base`, the diff is the working tree against `HEAD` (staged and unstaged changes) plus untracked files, which count as fully added. With a base, `base..HEAD` is merged with working-tree changes. Ignored files (`.gitignore`) are excluded.

---

### Changes not reflected after edit

**Fix:** Re-run `cgb init` to refresh the graph. The tool uses content hashes so only changed files are re-parsed.
