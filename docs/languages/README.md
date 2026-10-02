# Language support matrix

Current extraction quality per language adapter. Source of truth is the smoke tests in
`src/parser/__tests__/adapters.test.ts` (each remaining gap below is an `it.todo` there).

Legend: ✅ works, ⚠️ partial, ❌ missing.

| Language | Classes | Functions | Methods | Calls | Imports (local) | Imports (external) | Inherits / implements | Line ranges | Signature | Doc / exported |
|---|---|---|---|---|---|---|---|---|---|---|
| TypeScript / JavaScript | see [typescript.md](typescript.md) (slice 03) | | | | | | | | | |
| C# | ✅ | ✅ | ✅ (scoped to class) | ⚠️ same-class only | ❌ | ⚠️ first namespace segment | ⚠️ inherits ✅, interfaces emitted as `inherits` | ✅ | ✅ | ✅ (`///` docs, `public`) |
| Python | ✅ | ✅ | ⚠️ emitted as `function`, not class-scoped | ❌ | ✅ relative imports resolve to `file→file` edges | ✅ | ✅ inherits | ✅ | ✅ | ✅ (docstrings, no leading `_`) |
| Go | ✅ (structs) | ✅ | ⚠️ not scoped to receiver | ❌ | ❌ all external | ✅ | ❌ | ✅ | ✅ | ✅ (`//` docs, capitalised) |
| Java | ✅ | n/a | ⚠️ not class-scoped | ❌ | ❌ | ⚠️ first package segment | ✅ inherits + implements | ✅ | ✅ | ✅ (Javadoc, `public`) |
| Rust | ✅ (structs) | ✅ | ⚠️ not scoped to impl type | ❌ | ❌ `crate::` is external | ✅ | ❌ (`impl Trait for`) | ✅ | ✅ | ✅ (`///` docs, `pub`) |
| Ruby | ❌ grammar crashes | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ implemented, untestable | ⚠️ implemented, untestable | ⚠️ implemented, untestable |
| PHP | ✅ | ✅ | ⚠️ not class-scoped | ❌ | ❌ | ❌ no import edges | ❌ | ✅ | ✅ | ✅ (docblocks, visibility) |
| C | ✅ (struct emitted once) | ✅ | n/a | ❌ | ❌ quoted includes are external | ✅ | n/a | ✅ | ✅ | ⚠️ `static` → not exported; no doc extraction verified |
| C++ | ✅ | ✅ | ⚠️ not class-scoped | ❌ | ❌ quoted includes are external | ✅ | ❌ | ✅ | ✅ | ⚠️ as C |
| Kotlin | ✅ | ✅ (top-level) | ✅ (kind `method`, not class-scoped id) | ❌ | ❌ | ⚠️ first package segment | ❌ | ✅ | ✅ | ✅ (KDoc, visibility) |

## Notes

- Every adapter also emits `exports` edges from the file to each top-level symbol.
- Line ranges are 1-based and inclusive; file nodes span `1..lastLine`. Signatures are the
  declaration header up to the body start (`{`, `:` or `=`), collapsed to one line (<= 200 chars).
- Node IDs and kinds are unchanged by slice 09, including unscoped method IDs (`#greet`); scoping
  methods to their class would rename IDs and is out of scope.
- Python relative imports (`from .b import x`, `from . import x`, `from ..pkg.mod import z`)
  resolve against the importing file's package dir (`<path>.py`, then `<path>/__init__.py`).
  Unresolvable relative imports produce no edge and no external node (logged with `CGB_DEBUG=1`).
- Ruby: the `tree-sitter-ruby.wasm` grammar throws `Cannot read properties of undefined (reading 'apply')`
  on any input with `web-tree-sitter` 0.20.8 (the failure is inside the grammar's external scanner,
  reached via `Parser.parse`), so no Ruby file can be indexed. The Ruby adapter has the same metadata
  code as the others but it cannot be exercised until the grammar/runtime pair is fixed.
- "Local" imports means resolving to another file node in the project; today only the TypeScript
  and Python adapters attempt this.
- Call-edge extraction for languages that lack it is a future slice.
