# Plan: Graph Quality v1.3 — make CGB worth querying instead of grep

## Goal
CGB is an MCP server and CLI. Its job is to let Claude Code answer "where is X, who calls X, what breaks if I change X" in one tool call, without grep/read loops. A re-audit on 2026-10-02 against v1.2.0 found that the most important path, TypeScript/JavaScript, is effectively broken. Several features listed as shipped also fail silently:

- TS/JS functions and methods are never extracted. `FUNCTION_QUERY` in `src/parser/adapters/typescript.ts:63` uses `method_definition key:`, but the grammar field is `name:`. The query fails to compile and `catch {}` swallows the error. This repo's own graph has 0 function nodes.
- TS/JS produce no `calls` edges. Only C# emits them, so call_chain, entry_points, criticality, large_functions and dead_code are empty for TS.
- JS class and interface queries use TS-only node types. `.tsx` files are parsed with the TS grammar instead of the TSX grammar. Cross-file extends/implements edges dangle. `@scope/pkg` is stored as `@scope`. There is no tsconfig `paths` support and no handling of re-exports or dynamic `import()`.
- The sql.js build has no FTS5, so search is an unranked `LIKE`. Louvain never runs (`require('graphology').default` is undefined), so the code silently falls back to Union-Find.
- No line ranges, signatures or docs are stored. Claude still has to grep to find the code, and rename-apply rewrites words across whole files.
- Every MCP tool requires `root`. Output is pretty-printed JSON with absolute paths and no pagination. `cgb install --platform claude` writes Claude **Desktop** config with the wrong package name. There is no auto-refresh, and the watcher's ignore regex matches `code_graph_builder` itself.
- There are 53 tests and none cover the parser.

Target release: **v1.3.0**.

## Decisions (final — do not revisit)
| # | Decision |
|---|---|
| D1 | Storage moves from sql.js to **better-sqlite3**: WAL mode, real file DB, prepared statements, FTS5. sql.js is removed. |
| D2 | The parser stays on **tree-sitter WASM** (`web-tree-sitter` 0.20.8 + `tree-sitter-wasms`). No TypeScript compiler API and no type checker. |
| D3 | Scope is all phases: safety net, TS extraction, linker/calls, storage, metadata, search, communities, refactor, MCP ergonomics, Claude Code install, cleanup. |
| D4 | The node ID format is unchanged: `kind:<absPath>#<symbol>` (via `makeNodeId` in `src/parser/utils.ts`). Methods use kind `method` with symbol `<Class>.<name>`. Object-literal methods use `<objectVar>.<key>`. |
| D5 | TS type aliases and enums use kind `type`, with `meta.subkind` set to `"alias"` or `"enum"`. Namespaces and `declare module` use kind `module`. `NodeKind` gets no new members. |
| D6 | Edges have **no foreign keys and no cascades**. Re-parsing a file deletes only that file's nodes and its outgoing edges. A linker pass after each parse batch resolves cross-file refs and prunes dangling edges. |
| D7 | Call resolution is heuristic, with no types. Order: same-file symbol → imported binding (following one level of barrel re-export) → `this.m()` to an enclosing-class method → unresolved. Unresolved calls are dropped, and only their count is kept in the caller's `meta.unresolvedCalls`. |
| D8 | MCP output is compact JSON (no indentation) with repo-relative paths. List tools take `limit` (default 50, max 500) and `offset`, and the response carries `total`, `returned` and `truncated`. |
| D9 | `root` is optional on every tool. It resolves as `args.root ?? process.env.CGB_ROOT ?? process.cwd()`. The CLI `cgb mcp --root X` sets `CGB_ROOT`. |
| D10 | Embeddings are optional. `@xenova/transformers` becomes an `optionalDependency`. Default search is exact-name → prefix → FTS5 BM25. Vector/RRF results are added only when embeddings exist. |
| D11 | Claude Code install writes a project `.mcp.json` entry (`npx -y cgb-builder mcp --root <abs>`) and prints the equivalent `claude mcp add` command. The hook template (PostToolUse on Edit/Write → `cgb update <file>`) is opt-in. |
| D12 | Diagnostics go to **stderr only** (stdout is the MCP stdio channel), gated by `CGB_DEBUG=1`, through `src/util/log.ts`. Empty `catch {}` is banned in touched code. |
| D13 | Lint and format are cleaned up in one dedicated slice at the end. Other slices don't run `eslint --fix` repo-wide. |
| D14 | Spec docs have a single owner per file, by track (see the table below). README, CHANGELOG, ARCHITECTURE and ROADMAP are reconciled only in slice 19. |

## Status
- [x] 01 Safety net: logger, no silent catches, safe git exec
- [x] 02 Adapter test harness (non-TS languages)
- [x] 03 TS/JS/TSX symbol extraction
- [x] 04 TS import resolution (re-exports, tsconfig paths, scoped pkgs)
- [x] 05 Linker pass + TS call edges + incremental correctness
- [x] 06 Storage migration to better-sqlite3
- [x] 07 Schema v2: line ranges, signature, doc, exported, FTS5 table
- [x] 08 TS metadata population
- [x] 09 Other adapters: line ranges + Python relative imports
- [x] 10 Ranked search (FTS5 BM25 + optional embeddings)
- [x] 11 Communities: working Louvain + perf
- [x] 12 Line-range consumers: bundle snippets, real LOC
- [x] 13 Safe refactor apply + dead code via `exported`
- [x] 14 MCP core ergonomics: optional root, compact output, pagination
- [x] 15 MCP new tools (`cgb_symbol`, callers/callees) + auto-freshness
- [x] 16 Claude Code install, `cgb update`, watcher fixes
- [x] 17 Hardening & perf: N+1 batching, git working tree, viz bind
- [x] 18 Lint/format baseline + CI
- [x] 19 Docs & manifest reconciliation, v1.3.0 bump
- [x] 20 End-to-end verification report

## Tracks and doc ownership
| Track | Slices | Code files owned | Spec docs owned |
|---|---|---|---|
| A Parser-TS | 03 → 04 → 05 → 08 | `src/parser/adapters/typescript.ts`, `src/parser/tree-sitter-engine.ts`, `src/parser/ts-config.ts` (new), `src/parser/linker.ts` (new), `src/parser/index.ts`, `src/parser/adapter.ts` | `docs/languages/typescript.md` |
| B Storage | 06 → 07 → 10 | `src/graph/db.ts`, `src/types.ts`, `src/parser/utils.ts`, `src/embed/*`, `package.json` | `docs/SCHEMA.md`, `docs/TROUBLESHOOTING.md` (17 later) |
| C Analysis | 11 → 12 → 13 | `src/communities/index.ts`, `src/bundle/generator.ts`, `src/flows/index.ts`, `src/refactor/index.ts` | `docs/FEATURES.md` |
| D MCP | 14 → 15 | `src/mcp/server.ts` | `docs/MCP_TOOLS.md` (new) |
| E Tooling | 16 | `src/cli/index.ts`, `src/cli/install.ts`, `src/watcher/index.ts`, `templates/` (new) | `docs/USAGE.md`, `docs/COMMANDS.md` |
| F Other langs | 02 → 09 | `src/parser/adapters/<non-TS>.ts`, `src/parser/__tests__/` (shared harness) | `docs/languages/README.md` |
| G Hardening | 01, 17, 18 | `src/util/log.ts`, `src/git/*`, `src/graph/engine.ts`, `src/viz/index.ts`, `.github/workflows/ci.yml` | `docs/TROUBLESHOOTING.md` (after 06) |
| Final | 19, 20 | README, CHANGELOG, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/INDEX.md`, `.claude-plugin/*`, `package.json` version | all, reconciliation only |

## Dependencies and parallel waves
| Slice | Prereqs | Runs in parallel with (same wave) |
|---|---|---|
| 01 | — | 02, 06 |
| 02 | — | 01, 06 |
| 06 | — | 01, 02 |
| 03 | 01, 02 | 07, 11, 14, 16 |
| 07 | 06 | 03, 11, 14, 16 |
| 11 | 01 | 03, 07, 14, 16 |
| 14 | 01, 06 | 03, 07, 11, 16 |
| 16 | 01 | 03, 07, 11, 14 |
| 04 | 03 | 09, 10, 17 |
| 09 | 01, 02, 07 | 04, 10, 17 |
| 10 | 07 | 04, 09, 17 |
| 17 | 01, 06 | 04, 09, 10 |
| 05 | 04, 06 | — (wave 4, alone in track A; others may continue) |
| 08 | 05, 07 | — |
| 12 | 08, 11 | 15 |
| 15 | 05, 07, 10, 14 | 12, 13 |
| 13 | 12 | 15 |
| 18 | all of 01–17 | 19 |
| 19 | all of 01–17 | 18 |
| 20 | 18, 19 | — |

Waves: **W1** 01, 02, 06 → **W2** 03, 07, 11, 14, 16 → **W3** 04, 09, 10, 17 → **W4** 05 → **W5** 08 → **W6** 12, 15 → **W7** 13 → **W8** 18, 19 → **W9** 20.

Shared-file rules (sequential edits only):
- `typescript.ts`: 01 (catch lines) → 03 → 04 → 05 → 08.
- Other adapters: 01 (catch lines) → 09.
- `db.ts`: 06 → 07 → 10.
- `types.ts`: 07, then 17 (one optional `truncated` field only).
- `utils.ts`: 07 only.
- `server.ts`: 14 → 15.
- `git/diff.ts` and its test: 01 → 17.
- `package.json`: 06 → 10 → 19. Slice 16 must not touch it.
- `docs/FEATURES.md`: 11 → 12 → 13 → 19.
- `docs/TROUBLESHOOTING.md`: 06 → 17 → 19.
- `src/cli/install.ts`: 16, then 19 (tool-table string, only after 18).
- Slice 18 reformats all of `src/`, so it runs only once 01–17 are merged.

## Baseline (2026-10-02)
`npx tsc --noEmit` is clean. `npx jest` gives 3 suites and 53 tests passing. `npx eslint src` reports about 6.9k errors (mostly prettier/CRLF), which slice 18 fixes; until then, lint is not a gate.

## How to run a slice
Hand a fresh agent the single file `docs/plans/graph-quality-v1.3/NN-<name>.md`. Each file is self-contained. When the slice is done, the agent ticks its box above.
