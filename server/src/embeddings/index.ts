/**
 * Text embeddings, behind one interface so the model is a config choice.
 *
 * The default provider runs all-MiniLM-L6-v2 locally through transformers.js:
 * free, no API key, and fully offline once the ~90MB model has been cached. The
 * catch is that first use needs to reach huggingface.co. If that download is
 * blocked — restricted network, offline machine, locked-down proxy — ingestion
 * must still work, so a failure here is recorded rather than thrown: chunks are
 * stored without vectors and can be embedded later via POST /api/embeddings/backfill.
 */
import { config } from '../config.js';
import { hashEmbedder } from './hash.js';
import { localEmbedder } from './local.js';

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  /** Returns unit-length vectors, so cosine similarity is a plain dot product. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type EmbedderStatus =
  | { state: 'ready'; provider: string; dim: number }
  | { state: 'unavailable'; provider: string; dim: number; reason: string };

let embedder: Embedder | null = null;
let failure: string | null = null;

function select(): Embedder {
  switch (config.embeddings.provider) {
    case 'hash':
      return hashEmbedder(config.embeddings.dim);
    case 'local':
      return localEmbedder(config.embeddings.model, config.embeddings.dim, config.embeddings.cacheDir);
    default:
      throw new Error(`Unknown EMBEDDINGS_PROVIDER: ${config.embeddings.provider}`);
  }
}

export function getEmbedder(): Embedder {
  if (!embedder) embedder = select();
  return embedder;
}

export function embedderStatus(): EmbedderStatus {
  const provider = config.embeddings.provider;
  const dim = config.embeddings.dim;
  return failure
    ? { state: 'unavailable', provider, dim, reason: failure }
    : { state: 'ready', provider, dim };
}

/**
 * How many texts go to the model at once.
 *
 * Everything is embedded in slices of this size rather than in one call. A
 * textbook produces thousands of chunks, and handing them all over at once
 * means the model tokenises and holds the lot simultaneously — hundreds of
 * megabytes to gigabytes of tensors for a single await.
 */
const BATCH_SIZE = 32;

/**
 * Embed a batch, returning null entries instead of throwing when the model is
 * unreachable. Callers persist what they can and leave the rest for a backfill.
 */
export async function embedSafely(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  try {
    const embedder = getEmbedder();
    const vectors: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      signal?.throwIfAborted();
      const slice = texts.slice(i, i + BATCH_SIZE);
      vectors.push(...(await embedder.embed(slice)));
      onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
      // Let the server answer other requests between batches.
      await new Promise((resolve) => setImmediate(resolve));
    }

    failure = null;
    return vectors;
  } catch (error) {
    // A cancellation is not a provider failure. Without this it would be
    // swallowed here and reported as "the model is unavailable", and the
    // ingest would carry on storing everything without vectors.
    if ((error as Error)?.name === 'AbortError') throw error;

    const message = (error as Error).message;
    if (failure !== message) {
      console.warn(
        `[embeddings] provider "${config.embeddings.provider}" unavailable: ${message}\n` +
          '           Content is being stored without vectors. Once the model can be ' +
          'reached, run POST /api/embeddings/backfill to fill them in.',
      );
    }
    failure = message;
    return texts.map(() => null);
  }
}

/** Strict variant for endpoints where a missing vector is a real error. */
export async function embedOne(text: string): Promise<Float32Array> {
  const [vector] = await getEmbedder().embed([text]);
  if (!vector) throw new Error('Embedding provider returned no vector');
  return vector;
}

/** Test seam. */
export function resetEmbedder(): void {
  embedder = null;
  failure = null;
}
