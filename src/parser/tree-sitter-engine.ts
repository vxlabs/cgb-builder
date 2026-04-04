/**
 * Tree-sitter WASM engine orchestrator.
 * Initialises web-tree-sitter, loads language grammars on demand,
 * and provides a unified parse() method that returns a Tree for any
 * supported language.
 */

import * as path from 'path';
import * as fs from 'fs';
import Parser from 'web-tree-sitter';
import type { SupportedLanguage } from '../types.js';

// ─── WASM grammar paths ───────────────────────────────────────────────────────

const WASM_DIR = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

const LANG_WASM_NAMES: Record<SupportedLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
};

// ─── TreeSitterEngine ─────────────────────────────────────────────────────────

export class TreeSitterEngine {
  private parser!: Parser;
  private languageCache = new Map<SupportedLanguage, Parser.Language>();
  private initialised = false;

  async init(): Promise<void> {
    if (this.initialised) return;
    // web-tree-sitter v0.20.x auto-locates tree-sitter.wasm from its package dir
    await Parser.init();
    this.parser = new Parser();
    this.initialised = true;
  }

  /** Parse source text in the given language and return a tree-sitter Tree */
  async parse(source: string, language: SupportedLanguage): Promise<Parser.Tree> {
    await this.init();
    const lang = await this.loadLanguage(language);
    this.parser.setLanguage(lang);
    return this.parser.parse(source);
  }

  /** Return the tree-sitter Language object (cached) */
  async loadLanguage(language: SupportedLanguage): Promise<Parser.Language> {
    if (this.languageCache.has(language)) {
      return this.languageCache.get(language)!;
    }
    const wasmFile = LANG_WASM_NAMES[language];
    const wasmPath = path.join(WASM_DIR, wasmFile);
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM grammar not found for ${language}: ${wasmPath}`);
    }
    const lang = await Parser.Language.load(wasmPath);
    this.languageCache.set(language, lang);
    return lang;
  }

  /** Run a tree-sitter query against a tree and collect all matches */
  query(tree: Parser.Tree, language: Parser.Language, queryString: string): Parser.QueryMatch[] {
    const q = language.query(queryString);
    return q.matches(tree.rootNode);
  }

  /** Collect all captures from a query */
  captures(
    tree: Parser.Tree,
    language: Parser.Language,
    queryString: string,
  ): Parser.QueryCapture[] {
    const q = language.query(queryString);
    return q.captures(tree.rootNode);
  }
}

/** Singleton engine instance shared across adapters */
export const treeSitterEngine = new TreeSitterEngine();
