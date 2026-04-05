# CGB Usage Guide

## Prerequisites

- Node.js ≥ 18
- `npm install -g cgb-builder` (or build from source: `npm install && npm run build`)

## Quick Start

```bash
# 1 — Navigate to your project
cd /path/to/my-project

# 2 — Build the code graph (creates .cgb/graph.db)
cgb init

# 3 — Explore the graph
cgb deps src/app.ts          # direct dependencies of a file
cgb impact src/services/auth.ts  # what would break if this file changes

# 4 — Open the interactive visualisation (browser opens automatically)
cgb viz --serve
```

## Common Workflows

### Understanding a new codebase

```bash
cgb init                           # scan everything
cgb stats                          # files / nodes / edges overview
cgb communities                    # top-level architecture clusters
cgb flows                          # entry points and critical paths
```

### Before a pull request

```bash
cgb review                         # review context for staged changes
cgb detect-changes                 # list modified files + risk scores
cgb impact <changed-file>          # blast radius analysis
```

### Refactoring

```bash
cgb refactor dead-code             # find unused exports
cgb refactor suggestions           # high-impact improvement hints
cgb refactor rename src/old.ts new-name  # preview rename impact
```

### Documentation generation

```bash
cgb wiki --out docs/wiki           # generate Markdown wiki per community
```

### Multi-repo search

```bash
cgb registry register . my-project   # register current repo
cgb registry search "UserService"     # search across all registered repos
```

## MCP Integration

```bash
cgb install cursor     # auto-configure Cursor
cgb install claude     # auto-configure Claude Code
cgb install vscode     # generate VS Code settings
```

Once installed, AI agents can call 30+ tools including `cgb_deps`, `cgb_impact`,
`cgb_bundle`, `cgb_search`, `cgb_flows`, `cgb_communities`, `cgb_review_context`.
