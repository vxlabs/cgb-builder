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

---

### Changes not reflected after edit

**Fix:** Re-run `cgb init` to refresh the graph. The tool uses content hashes so only changed files are re-parsed.
