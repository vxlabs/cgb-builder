/**
 * Base interface all language adapters must implement.
 */

import type { ParsedFile, SupportedLanguage } from '../types.js';

export interface LanguageAdapter {
  readonly language: SupportedLanguage;
  /** Parse a source file and return extracted nodes + edges */
  parse(filePath: string, source: string): Promise<ParsedFile>;
}
