/**
 * Base interface all language adapters must implement.
 */

import type { ParsedFile, SupportedLanguage } from '../types.js';

/**
 * An unresolved reference found while parsing (a call or a cross-file parent
 * class/interface). The Linker resolves these to edges after the batch is written.
 */
export interface SymbolRef {
  /** caller node id (function/method/file) or class/interface id for heritage */
  fromId: string;
  kind: 'calls' | 'inherits' | 'implements';
  /** bare callee / parent name, e.g. 'find', 'BaseRepo' */
  name: string;
  /** 'this' | 'super' | object/namespace identifier, e.g. 'api', 'utils' */
  qualifier?: string;
  /** `new X()` */
  isNew?: boolean;
  /** 1-based, optional */
  line?: number;
}

export interface ParsedFileWithRefs extends ParsedFile {
  refs?: SymbolRef[];
}

export interface LanguageAdapter {
  readonly language: SupportedLanguage;
  /** Parse a source file and return extracted nodes + edges (and optionally refs to link) */
  parse(filePath: string, source: string): Promise<ParsedFileWithRefs>;
}
