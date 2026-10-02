# Slice 19: Docs and manifest reconciliation, v1.3.0 bump

## Goal
Make every user-facing doc and manifest match the code as it now exists, and prepare the v1.3.0 release notes. The 2026-10-02 audit found heavy drift:
- the README claims call extraction for all 12 languages
- the README lists 26 tools while there were 27
- CLI flags in the README are wrong
- the CHANGELOG lists DB helpers that never existed
- `.claude-plugin/*` lists 6 non-existent tools
- `cgb install` embeds a stale tool table

## Prerequisites
All code slices 01–17. This can run in parallel with 18, because it doesn't touch `src/` except one string table in `src/cli/install.ts` (see the tasks). If 18 is in flight, **do not** edit `install.ts`; leave that task for after 18 and report it.

## Files touched
- `README.md`, `CHANGELOG.md`
- `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/INDEX.md`, `docs/FEATURES.md` (reconciliation pass only; tracks already updated their sections)
- `docs/languages/README.md`: merge the TS/JS rows from `docs/languages/typescript.md`
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- `package.json`: `version` → `1.3.0`, and add `"templates"` to `files`
- `src/cli/install.ts`: the embedded tool-table string only (conditional, see Prerequisites)
- `memory-bank/progress.md` if it still exists (mark the call-graph gap resolved)

## Suggested model
Haiku. This is a docs pass that needs careful cross-checking against the code. Use Sonnet if Haiku struggles with the tool inventory.

## Read only these files
- `docs/MCP_TOOLS.md` is the **source of truth for tools**.
- `docs/COMMANDS.md` and `docs/USAGE.md` are the source of truth for the CLI.
- `docs/SCHEMA.md` is the source of truth for storage.
- `docs/languages/*.md` is the source of truth for language support.
- `docs/FEATURES.md`
- the files you edit
- to confirm counts: `grep -n "name: 'cgb_" src/mcp/server.ts` and `node dist/cli/index.js --help`, plus `--help` for each subcommand

## Background
v1.3.0 release content, one bullet per slice:
- **Parser.** TS/JS/TSX extraction rewritten: functions, methods, types, enums and namespaces. Real `exports` edges. tsconfig `paths`, re-exports, scoped packages. A linker pass adds TS `calls` edges and cross-file heritage. Line ranges, signatures and docs are stored for all languages, and Python relative imports are fixed.
- **Storage.** sql.js replaced by better-sqlite3 (WAL), with no FK cascades (fixing stale edges) and schema v2 with an FTS5 index. The graph DB is rebuilt automatically on upgrade.
- **Search.** Ranked exact → prefix → BM25. Embeddings are optional.
- **Analysis.** Louvain actually runs. Bundles are symbol-scoped, LOC-based large functions, safe rename apply with drift check, real dead-code detection.
- **MCP.** Optional root, compact paginated output, new `cgb_symbol`, `cgb_callers` and `cgb_callees`, unified `cgb_search` (with `cgb_embed_search` deprecated), auto-freshness.
- **Claude Code.** `cgb install --platform claude-code` writes `.mcp.json`, plus an optional PostToolUse hook, a CLAUDE.md block and `cgb update`.
- **Hardening.** Stderr logging (`CGB_DEBUG`), safe git exec, working-tree diffs, viz on localhost, batched traversals, lint/format enforced in CI.
- **Breaking.**
  - `install --platform claude` now targets Claude Code; use `claude-desktop` for the old behaviour.
  - Existing `.cgb/graph.db` files are rebuilt.
  - The MCP output shape is compact and paginated, with relative `file` fields.

Rules:
- Every number in a doc (tool count, language count, test count) must come from a command you ran, not from memory.
- Remove claims that are not implemented rather than softening them.
- `.claude-plugin/*`: make the tool list exactly match `docs/MCP_TOOLS.md`. Set the version to 1.3.0. Keep their existing structure unless it is invalid JSON.

## Tasks
1. Rebuild (`npm run build`) and collect the facts: the tool list, CLI help and test count (`npx jest 2>&1 | tail -5`).
2. Rewrite the README sections that drift (features, tool table, CLI usage, languages, Claude Code setup). Link to `docs/MCP_TOOLS.md` and `docs/languages/` instead of duplicating long tables.
3. Add a `CHANGELOG.md` 1.3.0 entry, using the content above, dated on the day you run this. Correct the inaccurate 1.1.0 claims with a short "Corrections" note rather than rewriting history.
4. Update the module map and design decisions in `docs/ARCHITECTURE.md` to cover better-sqlite3, the linker, freshness and FTS5. Move the shipped items in `docs/ROADMAP.md` to done and add the remaining todos from slice 09. Add `MCP_TOOLS.md` and `languages/` to `docs/INDEX.md`.
5. Update the plugin manifests, `package.json`, and the tool table in `install.ts` (if allowed).

## Out of scope
- Code changes beyond the one string table.
- Publishing or tagging the release.

## Done when
```
npm run build
npx jest
node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'));JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8'))"
```
All pass. The tool count in the README equals `grep -c "name: 'cgb_" src/mcp/server.ts`. Every CLI command shown in the README exists in `--help`.

## Finish
1. Tick `- [x] 19` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit: `docs(slice-19): reconcile docs and manifests for v1.3.0`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: the claims removed and corrected, and whether the `install.ts` table was deferred.
