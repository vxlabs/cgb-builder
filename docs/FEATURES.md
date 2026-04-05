# CGB Feature Catalogue

## Core Graph

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Build/refresh graph | `cgb init` | `cgb_init` |
| File dependencies | `cgb deps` | `cgb_deps` |
| Reverse dependencies | — | `cgb_callers` |
| Impact analysis | `cgb impact` | `cgb_impact` |
| Shortest path | `cgb path` | `cgb_path` |
| Full-text search | `cgb search` | `cgb_search` |
| Semantic similarity | — | `cgb_embed_search` |
| Similar files | — | `cgb_embed_similar` |
| Graph statistics | `cgb stats` | `cgb_stats` |
| Cycle detection | — | `cgb_stats` |
| Orphan detection | — | `cgb_stats` |

## AI Context

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Context bundle | `cgb bundle` | `cgb_bundle` |
| Review context | — | `cgb_review_context` |
| Change detection | — | `cgb_detect_changes` |

## Architecture Analysis

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Entry points | `cgb flows` | `cgb_entry_points` |
| Critical nodes | `cgb flows --top N` | `cgb_critical_nodes` |
| Call chain trace | `cgb flows --chain X` | `cgb_trace_flow` |
| Community detection | `cgb communities` | `cgb_communities` |
| Architecture overview | `cgb communities --overview` | `cgb_architecture_overview` |
| Large functions | — | `cgb_large_functions` |

## Refactoring

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Dead code detection | `cgb refactor dead-code` | `cgb_dead_code` |
| Refactoring suggestions | `cgb refactor suggestions` | `cgb_refactor_suggestions` |
| Rename preview | `cgb refactor rename` | — |

## Documentation

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Wiki generation | `cgb wiki` | `cgb_generate_wiki` |
| Page for file | — | `cgb_wiki_page` |

## Multi-repo

| Feature | CLI | MCP Tool |
|---------|-----|----------|
| Register repo | `cgb registry register` | — |
| Unregister repo | `cgb registry unregister` | — |
| List repos | `cgb registry list` | — |
| Cross-repo search | `cgb registry search` | `cgb_registry_search` |
| Registry info | — | `cgb_registry_list` |

## Languages Supported

TypeScript · JavaScript · Python · Rust · Go · Ruby · PHP · C · C++ · Kotlin · Jupyter Notebooks

## MCP Prompt Templates

| Prompt | Description |
|--------|-------------|
| `review_changes` | Review staged changes with impact context |
| `architecture_map` | Summarise project architecture |
| `debug_issue` | Debug an issue with graph context |
| `onboard_developer` | Onboard a new developer to the codebase |
| `pre_merge_check` | Pre-merge safety checklist |
