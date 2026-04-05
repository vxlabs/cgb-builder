# System Patterns

## Design Patterns in Use

### 1. Adapter Pattern — Language Adapters
Each language has its own adapter class implementing a common interface:
```typescript
interface LanguageAdapter {
  readonly language: SupportedLanguage;
  parse(filePath: string, source: string): Promise<ParsedFile>;
}
```
Adapters: `TypeScriptAdapter`, `CSharpAdapter`, `PythonAdapter`, `GoAdapter`, `JavaAdapter`.  
Registry in `src/parser/index.ts`:
```typescript
const ADAPTERS: Record<SupportedLanguage, LanguageAdapter> = { ... }
```

### 2. Singleton — TreeSitterEngine
`treeSitterEngine` is a module-level singleton exported from `src/parser/tree-sitter-engine.ts`. It:
- Initialises `web-tree-sitter` once (`Parser.init()`)
- Caches loaded language grammars in a `Map<SupportedLanguage, Parser.Language>`
- All adapters share this singleton to avoid redundant WASM init

### 3. Incremental Updates (Hash-based)
`Parser.parseFile()` checks `contentHash` (SHA-256 of file contents) against the stored `FileRecord`. Files are only re-parsed if their hash changed. This makes `cgb watch` cheap.

### 4. Graph Traversal (BFS)
`GraphEngine` uses BFS for:
- `deps(nodeId, depth)` — forward edges (imports/calls)
- `impact(nodeId, depth)` — reverse edges (who imports this)
- `path(from, to)` — Dijkstra-like shortest path

### 5. Lazy Service Loading in CLI
The CLI uses `async import()` to lazy-load all service modules. This avoids WASM init cost when the user just runs `cgb --help`.

## Node ID Convention

Stable, deterministic node IDs are constructed by `makeNodeId()` in `src/parser/utils.ts`:
```
file node:      "file:<absolutePath>"
class node:     "class:<absolutePath>#<ClassName>"
function node:  "function:<absolutePath>#<FunctionName>"
external dep:   "external_dep:<packageName>"
```

## Edge ID Convention

```
"<fromId>|<edgeKind>|<toId>"
```

## Language Detection

`detectLanguage(filePath: string): SupportedLanguage | null` uses `LANGUAGE_EXTENSIONS` map in `src/types.ts`. Returns `null` for unsupported extensions, which causes the file to be skipped silently.

## Ignore Patterns

Default ignores in `src/parser/index.ts`:
```
**/node_modules/**  **/dist/**  **/build/**  **/bin/**  **/obj/**
**/.git/**  **/.cgb/**  **/vendor/**  **/__pycache__/**
**/coverage/**  **/*.min.js  **/*.d.ts
```

## Bundle Generation Strategy

`BundleGenerator.generate()` compiles a Markdown document with sections:
1. Header (file path, graph stats, timestamp, estimated tokens)
2. Architectural layers table
3. Symbols defined in the target file (classes, interfaces, functions)
4. Dependencies (direct imports)
5. Imported by (reverse dependencies)
6. Class hierarchy (inherits/implements chains)
7. Source code of the target file
8. Source of direct dependency files (if `depth > 0`)

Token estimate: `Math.ceil(content.length / 4)` (rough 4 chars/token heuristic).

## Error Handling

- Language adapters catch all Tree-sitter errors silently (`try { } catch { }`) — malformed source files are skipped, not fatal
- `Parser.parseFile()` catches adapter errors and returns `{ status: 'error', error: message }`
- CLI commands call `db.close()` before `process.exit()`
