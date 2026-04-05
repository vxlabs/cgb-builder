# Active Context

## Current Status: Core Stable + MCP Server ✅

Import resolution bug fixed, unit tests written (39 passing), MCP server built and verified.

## Session History

### Session 1 — Planning & Scaffolding
- Assessed the idea of a code graph to reduce AI token spend → confirmed valuable
- Clarified requirements: **polyglot** (all languages) + **fully automatic** (file-save/git-hooks)
- Scaffolded the Node.js + TypeScript project structure

### Session 2 — Core Implementation
Implemented all major components in order (types, db, parser, adapters, engine, watcher, bundle, CLI).

### Session 3 — Bug Fixes & First Run
**Critical bug:** `web-tree-sitter` v0.26.8 incompatible WASM ABI. Fixed by downgrading to `web-tree-sitter@0.20.8`.

**First successful run:** 16 files parsed, 50 nodes, 100 edges, 0 errors.

### Session 4 — Stabilize Core + Build MCP Server

#### 1. Import Resolution Bug Fix
**Problem:** `cgb impact` returned 0 affected nodes for all internal files.

**Root cause:** `resolveTs()` in `src/parser/adapters/typescript.ts` received paths like
`'../graph/db.js'`, resolved to `C:\...\graph\db.js`, then tried to append `.ts` →
looked for `db.js.ts` (doesn't exist). Fell back to returning `db.js` path. The resulting
import edge pointed to a phantom node `file:...\db.js` instead of the real node `file:...\db.ts`.

**Fix applied to:**
- `src/parser/adapters/typescript.ts` — `resolveTs()`: strip `.js/.jsx/.mjs/.cjs` before resolving
- `src/parser/utils.ts` — `resolveImportPath()`: same logic for shared utility

**After fix:** `cgb impact src/types.ts` correctly reports 13 affected files.

#### 2. Unit Tests
Added `jest.config.json` `moduleNameMapper` to strip `.js` extension (needed for ts-jest).

Written tests:
- `src/graph/__tests__/db.test.ts` — 19 tests covering GraphDb CRUD, stats, search
- `src/graph/__tests__/engine.test.ts` — 20 tests covering deps, impact, path, search, cycles, orphans

All 39 tests pass.

#### 3. MCP Server
Installed `@modelcontextprotocol/sdk`.

Built `src/mcp/server.ts` with 7 tools via stdio transport:
- `cgb_init` — scan project and build graph
- `cgb_deps` — file dependency query
- `cgb_impact` — reverse dependency impact analysis
- `cgb_search` — fuzzy search across nodes
- `cgb_bundle` — generate AI context bundle (Markdown)
- `cgb_stats` — graph statistics summary
- `cgb_path` — shortest dependency path

Added `cgb mcp` command to CLI (`src/cli/index.ts`).

**Verified via stdio:** `tools/list` returns all 7 tools; `cgb_stats` and `cgb_impact` return correct data.

## Cursor/Claude Code Integration

Add this to your Cursor `settings.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cgb": {
      "command": "node",
      "args": ["C:/Users/sadiq/Desktop/Projects/code_graph_builder/dist/cli/index.js", "mcp"]
    }
  }
}
```

Or after `npm install -g .`:

```json
{
  "mcpServers": {
    "cgb": {
      "command": "cgb",
      "args": ["mcp"]
    }
  }
}
```

## Known Issues / Limitations

| Issue | Severity | Notes |
|-------|----------|-------|
| Unicode rendering in Windows PowerShell | Cosmetic | Shell output garbled; file output correct |
| Call graph (`calls` edges) not populated | Feature gap | Defined in schema but no extraction |
| Java import resolution | Minor | All Java imports treated as external |
| No git hooks | Future | Auto-refresh on commit not yet implemented |

## Next Steps (Priority Order)

1. **Validate on a real external project** — clone a non-trivial TS or C# project, run `cgb init`, verify quality
2. **Git hooks** — `post-commit` hook to auto-refresh graph on file changes
3. **Improve bundle quality** — add method signatures, doc comment extraction
4. **Call graph extraction** — populate `calls` edges for functions/methods
5. **npm publish** — after external validation passes

## Critical Constraints (Do Not Change)

- `web-tree-sitter@0.20.8` — do NOT upgrade (WASM ABI incompatibility with newer versions)
- `.js` extensions in TS source imports are standard ESM output convention
- `sql.js` for SQLite — pure WASM avoids Windows native compilation
