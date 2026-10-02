/**
 * Shared utilities used by multiple language adapters.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import type { SyntaxNode } from 'web-tree-sitter';
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-var-requires -- untyped third-party/dynamic value; behaviour unchanged
      if (require('fs').existsSync(resolved + ext)) {
        return resolved + ext;
      }
      // Try index file
      const indexPath = path.join(resolved, `index${ext}`);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-var-requires -- untyped third-party/dynamic value; behaviour unchanged
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
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
  };
  return MAP[ext] ?? null;
}

/** Truncate description to a reasonable length */
export function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

// ─── Schema v2 metadata helpers ──────────────────────────────────────────────

/** 1-based inclusive line range of a tree-sitter node. */
export function nodeRange(n: SyntaxNode): { startLine: number; endLine: number } {
  return { startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 };
}

/**
 * Split an identifier into lowercase, space-joined words.
 * "parseFileAsync" -> "parse file async"; "HTTPServer_v2" -> "http server v 2".
 */
export function splitIdentifier(s: string): string {
  return s
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Collapse whitespace, trim, and truncate (with "…") to at most `max` chars. */
export function oneLine(text: string, max = 200): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

const DOC_MAX = 300;

/** Reduce raw comment lines to the first paragraph (stopping at a blank line or @tag). */
function firstParagraph(lines: string[]): string | undefined {
  const para: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('@')) break;
    if (line === '') {
      if (para.length > 0) break;
      continue;
    }
    para.push(line);
  }
  const text = oneLine(para.join(' '), DOC_MAX);
  return text === '' ? undefined : text;
}

function blockCommentLines(text: string): string[] {
  return text
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*+ ?/, ''));
}

function isCommentNode(n: SyntaxNode | null): n is SyntaxNode {
  return !!n && n.type.includes('comment');
}

/** Comments directly above `start` (no blank-line gap), nearest-last order. */
function precedingComments(start: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  let expectedRow = start.startPosition.row;
  let prev = start.previousSibling;
  while (isCommentNode(prev) && prev.endPosition.row >= expectedRow - 1) {
    out.unshift(prev);
    expectedRow = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  return out;
}

/* eslint-disable no-irregular-whitespace -- zero-width space is intentional in the doc comment below */
/**
 * Extract the first paragraph of the doc comment attached to `n`.
 *  - jsdoc:  `/** ... *​/` immediately above the node (or its export_statement parent)
 *  - slash:  consecutive `///` / `//` lines (a `/* *​/` block is also accepted)
 *  - hash:   consecutive `#` lines
 *  - python: the docstring (first string statement of the body)
 */
export function leadingDocComment(
  n: SyntaxNode,
  source: string,
  style: 'jsdoc' | 'hash' | 'slash' | 'python',
): string | undefined {
  if (style === 'python') {
    const body = n.childForFieldName('body');
    const first = body?.namedChild(0);
    if (!first || first.type !== 'expression_statement') return undefined;
    const str = first.namedChild(0);
    if (!str || !str.type.startsWith('string')) return undefined;
    const raw = source
      .slice(str.startIndex, str.endIndex)
      .replace(/^[rRuUbBfF]*("""|'''|"|')/, '')
      .replace(/("""|'''|"|')$/, '');
    return firstParagraph(raw.split(/\r?\n/));
  }

  const start = style === 'jsdoc' && n.parent?.type === 'export_statement' ? n.parent : n;
  const comments = precedingComments(start);
  if (comments.length === 0) return undefined;
  const text = (c: SyntaxNode): string => source.slice(c.startIndex, c.endIndex);

  if (style === 'jsdoc') {
    const last = comments[comments.length - 1];
    const t = text(last);
    if (!t.startsWith('/**')) return undefined;
    return firstParagraph(blockCommentLines(t));
  }

  if (style === 'hash') {
    const lines = comments
      .filter((c) => text(c).startsWith('#'))
      .map((c) => text(c).replace(/^#+ ?/, ''));
    return lines.length ? firstParagraph(lines) : undefined;
  }

  // slash
  const last = comments[comments.length - 1];
  const lt = text(last);
  if (lt.startsWith('/*')) return firstParagraph(blockCommentLines(lt));
  const lines = comments
    .filter((c) => text(c).startsWith('//'))
    .map((c) =>
      text(c)
        .replace(/^\/+ ?/, '')
        .replace(/<\/?[A-Za-z][^>]*>/g, ' '),
    );
  return lines.length ? firstParagraph(lines) : undefined;
}
