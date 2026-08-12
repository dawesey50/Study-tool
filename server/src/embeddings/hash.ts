import { createHash } from 'node:crypto';
import type { Embedder } from './index.js';
import { normalise } from '../lib/vector.js';

/**
 * Deterministic offline stand-in for a real embedding model.
 *
 * It hashes word trigrams and unigrams into a fixed-width vector, so identical
 * text always produces an identical vector and text sharing vocabulary lands
 * somewhat closer together. That is enough to exercise the ingestion, indexing
 * and search paths end to end without a model download — but it captures no
 * semantics, so similarity scores are not meaningful. Development and CI only.
 */
export function hashEmbedder(dim: number): Embedder {
  return {
    name: `hash-${dim}`,
    dim,

    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const vec = new Float32Array(dim);
        const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

        const add = (token: string, weight: number) => {
          const digest = createHash('sha1').update(token).digest();
          const bucket = digest.readUInt32BE(0) % dim;
          // Sign from a second byte, so unrelated tokens can cancel rather
          // than every feature pushing in the same direction.
          const sign = (digest[4]! & 1) === 0 ? 1 : -1;
          vec[bucket] = (vec[bucket] ?? 0) + weight * sign;
        };

        for (let i = 0; i < words.length; i++) {
          add(words[i]!, 1);
          if (i + 2 < words.length) {
            add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`, 1.5);
          }
        }
        return normalise(vec);
      });
    },
  };
}
