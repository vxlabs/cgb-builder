# Slice 20: End-to-end verification report

## Goal
Independently check that v1.3.0 meets the plan's goal, which is that Claude Code can answer structural questions about a TS codebase from CGB without grep, and record the evidence. This slice is read-and-run only. It fixes nothing; any failures become follow-up items.

## Prerequisites
18 and 19 (everything merged).

## Files touched
- `docs/plans/graph-quality-v1.3/VERIFICATION.md` (new)
- `docs/plans/graph-quality-v1.3/00-README.md` (tick the box only)

## Suggested model
Haiku

## Read only these files
- `docs/plans/graph-quality-v1.3/00-README.md`
- `docs/MCP_TOOLS.md`, `docs/USAGE.md`
- `src/eval/index.ts`: only to learn how to run the benchmark (`node dist/cli/index.js eval --help`)

## Background
The baseline on 2026-10-02 (v1.2.0, this repo's own graph) had:
- 0 `function` and 0 `method` nodes, 0 `calls` edges for TS
- 10 dangling `implements` edges
- search "GraphDb" ranked `class:GraphDb` 5th
- communities ran as Union-Find
- 53 tests

Pass criteria:
| # | Check | Pass if |
|---|---|---|
| V1 | `npm ci && npx tsc --noEmit && npm run lint -- --max-warnings 0 && npm run format:check && npx jest && npm run build` | all green; record the test count |
| V2 | `rm -rf .cgb && node dist/cli/index.js init -r .` then `stats` | function > 50, method > 50, calls > 100 on this repo; record exact numbers |
| V3 | Dangling-edge query: `select count(*) from edges e left join nodes n on n.id = e.to_id where n.id is null`, run through `node -e` with better-sqlite3 | 0 |
| V4 | Function nodes with null `start_line` (`select count(*) from nodes where kind in ('function','method') and start_line is null`) | 0 for TS |
| V5 | CLI search "GraphDb" | `class GraphDb` is first |
| V6 | MCP stdio with `CGB_ROOT=$PWD`: `cgb_symbol {"name":"GraphDb"}`, `cgb_callers` on a known function, `cgb_impact` on `src/graph/db.ts`, `cgb_communities` | symbol has `lines` and `sig`; callers is non-empty; impact is paginated with `total`; communities `algorithm: "louvain"`; no absolute paths in `file` fields |
| V7 | Freshness: add `export function zzzProbe() {}` to a temp copy of the repo, then call `cgb_symbol {"name":"zzzProbe"}` without init | found |
| V8 | `install --platform claude-code -r <tmp>` | valid `.mcp.json` |
| V9 | `eval` benchmark (if it runs offline) | record the results; compare with any prior numbers in the repo |
| V10 | Token economy: char length of `cgb_bundle` for one function versus `wc -c` of its file | bundle < 30% of the file |

Run V7 on a **copy** of the repo in the OS temp dir. Don't modify the working tree.

## Tasks
1. Run V1–V10. Capture the command, the key output (trimmed) and PASS/FAIL for each.
2. Write `VERIFICATION.md`:
   - a summary table
   - details per check
   - a "Follow-ups" list for any FAIL, each phrased as a candidate next slice (goal plus files)
   - the baseline-versus-now comparison table

## Out of scope
- Fixing anything.

## Done when
`VERIFICATION.md` exists with all 10 checks recorded, and `git status` shows only that file and the README tick.

## Finish
1. Tick `- [x] 20` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit: `docs(slice-20): v1.3.0 end-to-end verification report`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: the PASS/FAIL table.
