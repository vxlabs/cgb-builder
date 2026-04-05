/**
 * Embed module: lightweight TF-IDF-based similarity search over graph nodes.
 *
 * Without an external embedding service every node is represented as a
 * bag-of-words vector derived from its name, kind, file path, and description.
 * Cosine similarity is used to rank candidates.
 *
 * This provides "good enough" semantic search for medium-sized repos and can be
 * swapped for a real embedding API in the future.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphDb } from '../graph/db.js';
import type { GraphNode } from '../types.js';
import type { EmbeddingProvider } from './providers.js';
import { getProvider } from './providers.js';

export type { EmbeddingProvider };
export { getProvider };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmbedResult {
  id: string;
  name: string;
  filePath: string;
  kind: string;
  score: number;
  description?: string | null;
}

// ─── Vector helpers ───────────────────────────────────────────────────────────

export function encodeVector(vec: number[]): Uint8Array {
  const buf = new Float32Array(vec);
  return new Uint8Array(buf.buffer);
}

export function decodeVector(bytes: Uint8Array): number[] {
  const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return Array.from(f32);
}


// ─── Node text for embedding ──────────────────────────────────────────────────

export function nodeToText(node: GraphNode): string {
  return [node.name, node.kind, node.description ?? '', node.language ?? '']
    .filter(Boolean)
    .join(' ');
}

// ─── Embedding compute + store ────────────────────────────────────────────────

/**
 * Compute embeddings for all non-external nodes and store in DB.
 * Skips nodes whose text hash matches what is already stored (incremental).
 */
export async function embedNodes(
  db: GraphDb,
  provider: EmbeddingProvider,
  batchSize = 64,
): Promise<{ embedded: number; skipped: number }> {
  const nodes = db.getAllNodes().filter((n) => !n.isExternal);
  const toEmbed: GraphNode[] = [];
  let skipped = 0;

  for (const node of nodes) {
    const text = nodeToText(node);
    const textHash = crypto.createHash('sha256').update(text).digest('hex');
    const existing = db.getEmbedding(node.id);
    if (existing && existing.textHash === textHash) {
      skipped++;
      continue;
    }
    toEmbed.push(node);
  }

  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);
    const texts = batch.map(nodeToText);
    const vectors = await provider.embed(texts);
    for (let j = 0; j < batch.length; j++) {
      const node = batch[j];
      const text = texts[j];
      const textHash = crypto.createHash('sha256').update(text).digest('hex');
      db.upsertEmbedding({
        nodeId: node.id,
        vector: encodeVector(vectors[j]),
        textHash,
        provider: provider.name,
      });
    }
  }

  // Persist provider name so hybridSearch can embed queries with the same model
  try {
    const metaPath = path.join(db.getDbDir(), 'embed-meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ provider: provider.name }), 'utf8');
  } catch {
    // Non-fatal — search will fall back to centroid approximation
  }

  return { embedded: toEmbed.length, skipped };
}

// ─── RRF merge ────────────────────────────────────────────────────────────────

function rrfMerge(lists: Array<Array<{ id: string }>>, k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach(({ id }, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ─── Hybrid search ────────────────────────────────────────────────────────────

export interface HybridSearchOptions {
  limit?: number;
  contextFiles?: string[]; // nodes in these files get a 1.5x boost
}

/**
 * Three-way hybrid search: FTS5 BM25 + vector cosine + LIKE keyword.
 * Results are merged with Reciprocal Rank Fusion and boosted by node kind
 * and context-file membership.
 */
export async function hybridSearch(
  db: GraphDb,
  query: string,
  options: HybridSearchOptions = {},
): Promise<EmbedResult[]> {
  const { limit = 20, contextFiles } = options;
  const contextSet = new Set(contextFiles ?? []);

  // 1. FTS5 BM25
  const bm25 = db.searchNodesRanked(query, 50);

  // 2. Vector cosine using stored embeddings (if available)
  const vectorRanked: Array<{ id: string }> = [];
  const embeddingCount = db.getEmbeddingCount();
  if (embeddingCount > 0) {
    let queryVec: number[] | null = null;

    // Attempt to embed the query using the same provider that built the index
    try {
      const metaPath = path.join(db.getDbDir(), 'embed-meta.json');
      if (fs.existsSync(metaPath)) {
        const { provider: providerName } = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
          provider: string;
        };
        const provider = getProvider(providerName);
        queryVec = await provider.embedQuery(query);
      }
    } catch {
      // Provider unavailable or API error — fall through to centroid approximation
    }

    // Fallback: centroid of top TF-IDF hits' stored vectors
    if (!queryVec) {
      const searcher = new EmbedSearcher(db);
      const topIds = searcher.search(query, 10).map((r) => r.id);
      const topVecs = topIds
        .map((id) => db.getEmbedding(id))
        .filter(Boolean)
        .map((e) => decodeVector(e!.vector));

      if (topVecs.length > 0) {
        const dim = topVecs[0].length;
        queryVec = new Array<number>(dim).fill(0);
        for (const vec of topVecs) {
          for (let i = 0; i < dim; i++) queryVec[i] += vec[i] / topVecs.length;
        }
      }
    }

    // Score all stored embeddings against the query vector
    if (queryVec) {
      const qv = queryVec;
      const scored: Array<{ id: string; score: number }> = [];
      for (const emb of db.getAllEmbeddings()) {
        const vec = decodeVector(emb.vector);
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < Math.min(vec.length, qv.length); i++) {
          dot += vec[i] * qv[i];
          magA += vec[i] * vec[i];
          magB += qv[i] * qv[i];
        }
        const sim = magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
        if (sim > 0) scored.push({ id: emb.nodeId, score: sim });
      }
      scored.sort((a, b) => b.score - a.score);
      vectorRanked.push(...scored.slice(0, 50));
    }
  }

  // 3. Keyword LIKE fallback
  const likeResults = db.searchNodes(query).slice(0, 50);
  const likeRanked = likeResults.map((n) => ({ id: n.id }));

  // 4. RRF merge
  const merged = rrfMerge(
    [bm25.map((r) => ({ id: r.id })), vectorRanked, likeRanked],
    60,
  );

  // 5. Apply boosts and resolve nodes
  const results: EmbedResult[] = [];
  for (const { id, score } of merged) {
    const node = db.getNode(id);
    if (!node) continue;

    let boostedScore = score;

    // Query-aware kind boosting
    if (/^[A-Z]/.test(query) && node.kind === 'class') boostedScore *= 1.5;
    if (/_/.test(query) && (node.kind === 'function' || node.kind === 'method')) boostedScore *= 1.5;
    if (/\./.test(query) && node.kind === 'file') boostedScore *= 2.0;

    // Context-file boost
    if (contextSet.size > 0 && contextSet.has(node.filePath)) boostedScore *= 1.5;

    results.push({
      id: node.id,
      name: node.name,
      filePath: node.filePath,
      kind: node.kind,
      score: Math.round(boostedScore * 10000) / 10000,
      description: node.description,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── EmbedSearcher ────────────────────────────────────────────────────────────

export class EmbedSearcher {
  private corpus: Map<string, Map<string, number>> = new Map();
  private idf: Map<string, number> = new Map();
  private nodes: GraphNode[] = [];
  private built = false;

  constructor(private readonly db: GraphDb) {}

  /**
   * Search for nodes similar to the query string.
   * Results are ranked by TF-IDF cosine similarity.
   */
  search(query: string, limit = 20): EmbedResult[] {
    if (!this.built) this.buildIndex();

    const queryVec = this.tfidfVector(this.tokenize(query));
    const results: Array<{ node: GraphNode; score: number }> = [];

    for (const node of this.nodes) {
      const docVec = this.corpus.get(node.id);
      if (!docVec) continue;
      const score = this.cosineSimilarity(queryVec, docVec);
      if (score > 0) results.push({ node, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ node, score }) => ({
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        kind: node.kind,
        score: Math.round(score * 1000) / 1000,
        description: node.description,
      }));
  }

  /**
   * Find nodes similar to a given nodeId.
   */
  findSimilar(nodeId: string, limit = 10): EmbedResult[] {
    if (!this.built) this.buildIndex();

    const srcNode = this.db.getNode(nodeId);
    if (!srcNode) return [];

    const srcVec = this.corpus.get(nodeId);
    if (!srcVec) return [];

    const results: Array<{ node: GraphNode; score: number }> = [];
    for (const node of this.nodes) {
      if (node.id === nodeId) continue;
      const docVec = this.corpus.get(node.id);
      if (!docVec) continue;
      const score = this.cosineSimilarity(srcVec, docVec);
      if (score > 0) results.push({ node, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ node, score }) => ({
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        kind: node.kind,
        score: Math.round(score * 1000) / 1000,
        description: node.description,
      }));
  }

  // ─── Index building ──────────────────────────────────────────────────────

  private buildIndex(): void {
    this.nodes = this.db.getAllNodes().filter((n) => !n.isExternal);

    // Compute TF for each document
    const termDocFreq = new Map<string, number>(); // DF per term

    for (const node of this.nodes) {
      const tokens = this.nodeTokens(node);
      const tf = this.termFrequency(tokens);
      this.corpus.set(node.id, tf);
      for (const term of tf.keys()) {
        termDocFreq.set(term, (termDocFreq.get(term) ?? 0) + 1);
      }
    }

    // IDF
    const N = this.nodes.length;
    for (const [term, df] of termDocFreq) {
      this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    }

    // Apply IDF to TF vectors
    for (const [nodeId, tf] of this.corpus) {
      const tfidf = new Map<string, number>();
      for (const [term, freq] of tf) {
        tfidf.set(term, freq * (this.idf.get(term) ?? 1));
      }
      this.corpus.set(nodeId, tfidf);
    }

    this.built = true;
  }

  private nodeTokens(node: GraphNode): string[] {
    const text = [
      node.name,
      node.kind,
      node.filePath,
      node.description ?? '',
    ].join(' ');
    return this.tokenize(text);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      // Split on non-word chars, camelCase, underscores
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && t.length <= 40);
  }

  private termFrequency(tokens: string[]): Map<string, number> {
    const freq = new Map<string, number>();
    for (const token of tokens) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
    const total = tokens.length || 1;
    for (const [term, count] of freq) {
      freq.set(term, count / total);
    }
    return freq;
  }

  private tfidfVector(tokens: string[]): Map<string, number> {
    const tf = this.termFrequency(tokens);
    const vec = new Map<string, number>();
    for (const [term, freq] of tf) {
      vec.set(term, freq * (this.idf.get(term) ?? 1));
    }
    return vec;
  }

  private cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (const [term, val] of a) {
      magA += val * val;
      const bVal = b.get(term);
      if (bVal !== undefined) dot += val * bVal;
    }
    for (const [, val] of b) {
      magB += val * val;
    }

    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }
}
