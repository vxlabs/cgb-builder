# Product Context

## Problem Being Solved

AI coding assistants spend enormous amounts of tokens loading entire files to understand a codebase. In a large project, loading 10–20 files per task can easily burn 50–100K tokens per session — most of which is irrelevant to the actual task at hand.

**The core insight:** an AI agent needs to know *how* code connects (who imports what, who calls what, which classes inherit from which) far more than it needs to read every line. A compact graph-derived summary of "everything touching `UserService`" is 95% smaller than dumping all related files.

## Objective

Build a **fully automated, polyglot code graph builder** (`cgb`) that:

1. **Scans** a project's source files automatically (on demand, on file save, or via git hooks)
2. **Builds** a persistent dependency/call/inheritance graph stored in a local SQLite database (`.cgb/graph.db`)
3. **Answers** structural questions instantly via a CLI: deps, callers, impact analysis, shortest paths, search
4. **Generates AI context bundles** — compact Markdown documents (typically 1,000–5,000 tokens) that give an AI agent exactly the structural context it needs for a specific task, instead of dumping entire files

## Target Users

Developers who work with AI coding assistants (Cursor, Claude Code, GitHub Copilot) on medium-to-large codebases where token efficiency matters.

## Goals

| Goal | Metric |
|------|--------|
| Reduce AI context token spend | From ~50K tokens/session → ~3–8K tokens via bundles |
| Polyglot support | TypeScript, JavaScript, C#, Python, Go, Java |
| Zero-config automation | `cgb init` + `cgb watch` — no manual config |
| No native compilation | Runs on any OS without Visual Studio / build tools |
| Incremental updates | Only re-parse changed files (content-hash checked) |

## What This Is NOT

- Not a full LSP / language server
- Not a runtime call tracer (static analysis only)
- Not a code search engine (though `cgb search` exists for quick node lookup)
- Not a replacement for reading code — it *supplements* AI agents with structural context
