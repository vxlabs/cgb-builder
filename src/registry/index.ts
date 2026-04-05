/**
 * Multi-repo registry module.
 *
 * Maintains a JSON registry of registered cgb projects on disk.
 * Allows cross-repo search by querying each registered graph.
 *
 * Registry file is stored at: ~/.cgb/registry.json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegistryEntry {
  name: string;
  root: string;
  registeredAt: string;
  lastSeen: string;
}

export interface RegistrySearchResult {
  repo: string;
  root: string;
  id: string;
  name: string;
  kind: string;
  filePath: string;
  description: string;
  isExternal: boolean;
}

// ─── RegistryManager ─────────────────────────────────────────────────────────

export class RegistryManager {
  private readonly registryPath: string;

  constructor(registryDir?: string) {
    const dir = registryDir ?? path.join(os.homedir(), '.cgb');
    fs.mkdirSync(dir, { recursive: true });
    this.registryPath = path.join(dir, 'registry.json');
  }

  /** Load the current registry */
  load(): RegistryEntry[] {
    if (!fs.existsSync(this.registryPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as RegistryEntry[];
    } catch {
      return [];
    }
  }

  /** Register a new project (or update an existing one) */
  register(name: string, root: string): RegistryEntry {
    const entries = this.load();
    const now = new Date().toISOString();
    const existingIdx = entries.findIndex((e) => e.root === root);

    const entry: RegistryEntry = {
      name: name || path.basename(root),
      root: path.resolve(root),
      registeredAt: existingIdx >= 0 ? entries[existingIdx].registeredAt : now,
      lastSeen: now,
    };

    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }

    this.save(entries);
    return entry;
  }

  /** Unregister a project by name or root path */
  unregister(nameOrRoot: string): boolean {
    const entries = this.load();
    const before = entries.length;
    const updated = entries.filter(
      (e) => e.name !== nameOrRoot && e.root !== path.resolve(nameOrRoot),
    );
    if (updated.length === before) return false;
    this.save(updated);
    return true;
  }

  /**
   * Search across all registered repos.
   * Opens each graph DB, runs searchNodes, and aggregates results.
   */
  async search(query: string, maxPerRepo = 10): Promise<RegistrySearchResult[]> {
    const entries = this.load();
    const results: RegistrySearchResult[] = [];

    for (const entry of entries) {
      const dbPath = path.join(entry.root, '.cgb', 'graph.db');
      if (!fs.existsSync(dbPath)) continue;

      try {
        const { GraphDb } = await import('../graph/db.js');
        const db = new GraphDb(entry.root);
        await db.init();

        const nodes = db.searchNodes(query);
        for (const node of nodes.slice(0, maxPerRepo)) {
          results.push({
            repo: entry.name,
            root: entry.root,
            id: node.id,
            name: node.name,
            kind: node.kind,
            filePath: node.filePath,
            description: node.description,
            isExternal: node.isExternal,
          });
        }

        db.close();
      } catch {
        // Skip unreachable registries silently
      }
    }

    return results;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private save(entries: RegistryEntry[]): void {
    fs.writeFileSync(this.registryPath, JSON.stringify(entries, null, 2), 'utf8');
  }
}
