# Slice 10: Ranked search (FTS5 BM25, optional embeddings)

## Goal
Make search return the right symbol first. Today `searchNodes` is an unranked `LIKE ... LIMIT 100`: searching "GraphDb" returns `WikiGenerator` first and `class:GraphDb` fifth. Hybrid search's BM25 leg is always empty, and the default embedding provider (`@xenova/transformers`) isn't even a dependency.

## Prerequisites
- 07: the `nodes_fts` FTS5 table exists and is kept in sync, and `splitIdentifier` is in `src/parser/utils.ts`.

## Files touched
- `src/graph/db.ts`: `searchNodes`, `searchNodesRanked`
- `src/embed/index.ts`
- `src/embed/providers.ts`
- `package.json` and `package-lock.json`: move `@xenova/transformers` to `optionalDependencies`
- `src/graph/__tests__/search.test.ts` (new)
- `src/embed/__tests__/hybrid.test.ts` (new)
- `docs/SCHEMA.md`: the "FTS5 Search" section

## Suggested model
Sonnet

## Read only these files
- `src/graph/db.ts`: the search functions and the FTS maintenance added in 07
- `src/embed/index.ts`, `src/embed/providers.ts`
- `src/parser/utils.ts`: `splitIdentifier` (read only)
- `src/graph/engine.ts`: `search()` (read only, to confirm it delegates)
- `docs/SCHEMA.md`

## Background
Decisions (final):
- **D10**: embeddings are optional. The default search is exact-name → prefix → FTS5 BM25. Vector and RRF results are added only when embeddings exist.
- **D12**: log to stderr via `src/util/log.ts`.

FTS table (from 07): `nodes_fts(node_id UNINDEXED, name, name_tokens, signature, doc, path_tokens)`.

Search contract. Slices 14 and 15 call these exactly:
```ts
interface SearchOptions { limit?: number /*default 30, max 500*/; kinds?: NodeKind[]; includeExternal?: boolean /*default false*/ }
searchNodes(query: string, opts?: SearchOptions): GraphNode[];               // ranked, deduped
searchNodesRanked(query: string, opts?: SearchOptions): Array<{ id: string; score: number; matchedBy: 'exact' | 'prefix' | 'fts' }>;
```
Callers that pass `searchNodesRanked(query, 50)` must keep working. Accept `number | SearchOptions` as the second argument.

Ranking:
1. **exact**: `name = ? COLLATE NOCASE` → score 1000. Also match the last segment of method names (`Class.m` matches `m`).
2. **prefix**: `name LIKE ? ESCAPE '\'` with `query%` → `500 - min(len(name) - len(query), 400)`.
3. **fts**: build the MATCH expression from `splitIdentifier(query)` tokens, each double-quoted plus `*` (prefix), joined with spaces (AND). If that returns nothing, retry with OR. Rank with `bm25(nodes_fts, 0, 10, 5, 2, 1, 1)`, using weights in column order `node_id, name, name_tokens, signature, doc, path_tokens`. Map the score to `100 / (1 + rank_position)`.
4. Merge by id, keeping the highest score. Tie-break by kind priority (`class, interface, function, method, type, module, file, external_dep`), then by shorter name.
5. Excluding external nodes is the default. Sanitise FTS syntax characters (`"`, `*`, `:`, `(`, `)`, `^`, `-`) from user input before quoting.

Hybrid (`src/embed/index.ts` `hybridSearch`):
- Lists fused with RRF k=60: **lexical** = `searchNodesRanked` (replacing the empty BM25 leg and the LIKE leg), plus **vector** only when `getEmbeddingCount() > 0` and a query embedding can be produced.
- Keep the existing query-shape boosts. Embedding input text must include `signature` and `doc` when present.

Providers:
- If the configured or default provider module is missing (`@xenova/transformers` not installed), fall back to the TF-IDF path (or no vectors) with a single `warnOnce`. Never throw from search because of a missing provider.

## Tasks
1. Implement the search contract in `db.ts`.
2. Update `hybridSearch` and the providers as described. Move `@xenova/transformers` to `optionalDependencies` (`npm pkg set` or edit, then `npm install`).
3. Write `search.test.ts`, seeding nodes `GraphDb`, `GraphDbOptions`, `WikiGenerator` (which has a doc mentioning "graph db"), a method `GraphEngine.search`, and an external `graphology`:
   - "GraphDb" ranks `class GraphDb` first
   - "graphdb" (lowercase) does too
   - "graph db" finds both GraphDb nodes ahead of WikiGenerator
   - "search" finds the method
   - `kinds` filtering
   - externals excluded by default
   - inputs `"a:b(" `, `%` and `-x` don't throw
4. Write `hybrid.test.ts`: works with zero embeddings (lexical only), and RRF ordering when fake vectors are inserted.
5. Update the "FTS5 Search" section of `docs/SCHEMA.md` with the ranking algorithm.

## Out of scope
- MCP tool descriptions and merging the search tools (15).
- Embedding build CLI changes.

## Done when
```
npm install
npx tsc --noEmit
npx jest
npm run build
node dist/cli/index.js init -r . && node dist/cli/index.js search GraphDb -r .
```
All pass. The CLI search prints `class GraphDb` as the first result.

## Finish
1. Tick `- [x] 10` in `docs/plans/graph-quality-v1.3/00-README.md`.
2. Commit only the files above plus that README: `feat(slice-10): ranked FTS5 search with optional embeddings`. End the message with the Co-Authored-By trailer your harness specifies.
3. Report: test count, and the top 5 results for "GraphDb", "parse file" and "louvain" on this repo.
