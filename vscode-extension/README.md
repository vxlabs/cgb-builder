# CGB Explorer — VS Code Extension

Interactive code-graph exploration inside VS Code, powered by **Code Graph Builder**.

## Prerequisites

1. Install `cgb-builder`: `npm install -g cgb-builder`
2. Build the graph for your workspace: `cgb init`

## Commands

| Command | Description |
|---------|-------------|
| `CGB: Open Graph Explorer` | Opens the D3-based full-graph panel |
| `CGB: Show Dependencies` | Focuses the graph on the currently open file |
| `CGB: Show Impact` | Shows files that would be affected by changes to the current file |
| `CGB: Show Graph Stats` | Displays files/nodes/edges count in a notification |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `cgb.dbPath` | `""` | Override the path to `graph.db`. Defaults to `<workspace>/.cgb/graph.db` |

## Development

```bash
cd vscode-extension
npm install
npm run compile
# Press F5 in VS Code to launch the Extension Development Host
```

## Building the VSIX

```bash
npm install -g @vscode/vsce
vsce package
```
