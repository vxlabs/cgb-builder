/**
 * Shared utilities used by multiple language adapters.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import type { NodeKind, SupportedLanguage } from '../types.js';

/** Generate a stable node ID from a file path and optional symbol name */
export function makeNodeId(kind: NodeKind, filePath: string, symbolName?: string): string {
  const base = symbolName ? `${filePath}#${symbolName}` : filePath;
  return `${kind}:${base}`;
}

/** Generate a stable edge ID */
export function makeEdgeId(fromId: string, kind: string, toId: string): string {
  return `${fromId}|${kind}|${toId}`;
}

/** Compute SHA-256 hash of source text */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Infer display name from a file path */
export function fileDisplayName(filePath: string): string {
  return path.basename(filePath);
}

/** Resolve an import path relative to the importing file */
export function resolveImportPath(
  importingFile: string,
  importPath: string,
  extensions: string[],
): string | null {
  if (importPath.startsWith('.')) {
    const dir = path.dirname(importingFile);
    // Strip any existing extension that may be a compile-time alias (e.g. .js in TS sources)
    // so we can find the actual source file with the correct extension.
    const stripped = importPath.replace(/\.(m?jsx?|cjs|tsx?)$/, '');
    const resolved = path.resolve(dir, stripped);
    // Try appending source extensions
    for (const ext of extensions) {
      if (require('fs').existsSync(resolved + ext)) {
        return resolved + ext;
      }
      // Try index file
      const indexPath = path.join(resolved, `index${ext}`);
      if (require('fs').existsSync(indexPath)) {
        return indexPath;
      }
    }
    return resolved; // Return unresolved base — will remain unlinked until that file is parsed
  }
  return null; // External / node_modules
}

/** Detect language from file extension */
export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  const MAP: Record<string, SupportedLanguage> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.cs': 'csharp',
    '.py': 'python',
    '.go': 'go',
    '.java': 'java',
  };
  return MAP[ext] ?? null;
}

/** Truncate description to a reasonable length */
export function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}
