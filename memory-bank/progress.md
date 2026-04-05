# Progress

## Overall Status: Core Stable + MCP Server ✅

| Component | Status | File |
|-----------|--------|------|
| Project scaffold (package.json, tsconfig, eslint, prettier) | ✅ Done | root config files |
| Domain types | ✅ Done | `src/types.ts` |
| SQLite database layer | ✅ Done | `src/graph/db.ts` |
| Tree-sitter WASM engine | ✅ Done | `src/parser/tree-sitter-engine.ts` |
| TypeScript/JavaScript adapter | ✅ Done | `src/parser/adapters/typescript.ts` |
| C# adapter | ✅ Done | `src/parser/adapters/csharp.ts` |
| Python adapter | ✅ Done | `src/parser/adapters/python.ts` |
| Go adapter | ✅ Done | `src/parser/adapters/go.ts` |
| Java adapter | ✅ Done | `src/parser/adapters/java.ts` |
| Parser orchestrator (glob + hash + incremental) | ✅ Done | `src/parser/index.ts` |
| Graph traversal engine | ✅ Done | `src/graph/engine.ts` |
| File watcher (chokidar) | ✅ Done | `src/watcher/index.ts` |
| AI context bundle generator | ✅ Done | `src/bundle/generator.ts` |
| CLI (commander.js) | ✅ Done | `src/cli/index.ts` |
| Library entry point | ✅ Done | `src/index.ts` |
| **Import resolution bug fix** | ✅ Done | `src/parser/adapters/typescript.ts` · `src/parser/utils.ts` |
| **GraphDb unit tests** | ✅ Done | `src/graph/__tests__/db.test.ts` |
| **GraphEngine unit tests** | ✅ Done | `src/graph/__tests__/engine.test.ts` |
| **MCP server** | ✅ Done | `src/mcp/server.ts` |
| **`cgb mcp` CLI command** | ✅ Done | `src/cli/index.ts` |

## Verified Working

```
cgb init -r .
  → Parsed:  16 files in ~480ms
  → Graph:   16 files · 50 nodes · 100 edges
  → 0 errors

cgb deps src/parser/index.ts
  → Direct: 11 deps including internal file nodes (src/graph/db.ts etc.)
  → Transitive: 16 nodes

cgb impact src/types.ts
  → 13 file(s) affected — correctly traverses reverse import graph

cgb stats
  → 11 class nodes, 15 interface nodes, 16 file nodes, 8 external deps
  → 0 cycles detected

# MCP server (stdio transport)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | cgb mcp
  → 7 tools: cgb_init, cgb_deps, cgb_impact, cgb_search, cgb_bundle, cgb_stats, cgb_path

# Tests
npm test → 39 tests passing (GraphDb + GraphEngine)
```

## Bug Fixed: Import Resolution (`resolveTs`)

**Root cause:** `resolveTs()` in `typescript.ts` received import paths like `'../graph/db.js'`,
resolved them to `C:\...\graph\db.js`, then tried to append `.ts` → `db.js.ts` (doesn't exist).
Fell back to `db.js` path → node ID mismatch with the real `file:...\db.ts` node.

**Fix:** Strip `.js/.jsx/.mjs/.cjs` from the import path *before* resolving.
Same fix applied to `resolveImportPath()` in `src/parser/utils.ts`.

## Known Issues (Remaining)

| Issue | Severity | Notes |
|-------|----------|-------|
| Unicode rendering in Windows PowerShell | Cosmetic | `·`, `—` show as garbled chars in shell; file output is correct |
| Call graph (`calls` edges) not populated | Feature gap | `calls` edges defined in schema but no extraction in adapters |
| Doc comment extraction | Feature gap | JSDoc/XML doc → `description` not yet implemented |

## Not Yet Built (Future Work)

| Feature | Priority | Notes |
|---------|----------|-------|
| Git hooks | Medium | `post-commit` hook to auto-refresh graph |
| Validate on real external project | High | Test on a non-trivial TS/C# project |
| npm publish | Low | After external validation |
| Call graph extraction | Low | `calls` edges not yet populated |
| Doc comment extraction | Low | JSDoc/XML doc → `description` field |
| Java import resolution | Medium | Currently treats all Java imports as external |

## Build Health

```
npx tsc --noEmit   → 0 errors ✅
npx tsc            → builds to dist/ ✅
npm test           → 39 tests passing ✅
cgb mcp (stdio)    → 7 MCP tools served ✅
```
