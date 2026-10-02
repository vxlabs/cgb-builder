## Code graph (cgb)

This project has a code graph exposed through the `cgb` MCP server. Prefer it over grep for
structural questions about the code.

- Know a name? Call `cgb_symbol` first to get its definition and location.
- Who calls this / what does it call? Use `cgb_callers` and `cgb_callees`.
- About to change shared code? Run `cgb_impact` first to see what depends on it.
- Need focused context for a file or symbol? Use `cgb_bundle`.
- Only a fuzzy idea of the name? Use `cgb_search`.

The project root is detected automatically; you do not need to pass it. Tool results include
file paths and line ranges: open them with `Read` using those ranges instead of reading whole files.

If results look stale, run `cgb init` (or `cgb update <file>`) to refresh the graph.
