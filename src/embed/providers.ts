/**
 * Embedding provider abstraction.
 *
 * Supported providers:
 *  - local    : @xenova/transformers (all-MiniLM-L6-v2, 384-dim) — lazy load, optional dep
 *  - google   : Gemini embeddings REST API (requires GOOGLE_API_KEY)
 *  - minimax  : MiniMax embo-01 REST API (requires MINIMAX_API_KEY)
 */

// ─── Interface ────────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  readonly dimension: number;
  readonly name: string;
}

// ─── Local provider (@xenova/transformers) ────────────────────────────────────

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly dimension = 384;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipeline: any = null;

  private async load(): Promise<void> {
    if (this.pipeline) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { pipeline } = require('@xenova/transformers') as {
        pipeline: (task: string, model: string) => Promise<unknown>;
      };
      this.pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    } catch {
      throw new Error(
        '@xenova/transformers is not installed. Run: npm install @xenova/transformers',
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.load();
    const results: number[][] = [];
    for (const text of texts) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      results.push(Array.from(output.data as Float32Array));
    }
    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }
}

// ─── Google Gemini provider ───────────────────────────────────────────────────

const GOOGLE_EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents';

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'google';
  readonly dimension = 768;

  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['GOOGLE_API_KEY'] ?? '';
    if (!this.apiKey) throw new Error('GOOGLE_API_KEY not set');
  }

  async embed(texts: string[]): Promise<number[][]> {
    const BATCH = 100;
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const body = {
        requests: batch.map((t) => ({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: t }] },
        })),
      };
      const res = (await this.fetchWithRetry(`${GOOGLE_EMBED_URL}?key=${this.apiKey}`, body)) as {
        embeddings: Array<{ values: number[] }>;
      };
      for (const item of res.embeddings) {
        all.push(item.values);
      }
    }
    return all;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }

  private async fetchWithRetry(url: string, body: unknown, retries = 3): Promise<unknown> {
    for (let attempt = 0; attempt < retries; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      if (res.status === 429 && attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Google Embed API error ${res.status}: ${await res.text()}`);
    }
    throw new Error('Google Embed API: max retries exceeded');
  }
}

// ─── MiniMax provider ─────────────────────────────────────────────────────────

const MINIMAX_EMBED_URL = 'https://api.minimax.chat/v1/embeddings';

export class MiniMaxEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'minimax';
  readonly dimension = 1536;

  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['MINIMAX_API_KEY'] ?? '';
    if (!this.apiKey) throw new Error('MINIMAX_API_KEY not set');
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(MINIMAX_EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: 'embo-01', input: texts }),
    });
    if (!res.ok) {
      throw new Error(`MiniMax Embed API error ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function getProvider(providerName?: string): EmbeddingProvider {
  switch (providerName ?? 'local') {
    case 'google':
      return new GoogleEmbeddingProvider();
    case 'minimax':
      return new MiniMaxEmbeddingProvider();
    case 'local':
    default:
      return new LocalEmbeddingProvider();
  }
}
