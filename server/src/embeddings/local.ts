import type { Embedder } from './index.js';

/**
 * all-MiniLM-L6-v2 via transformers.js, running in-process on the CPU.
 *
 * The model is downloaded once (~90MB) into MODEL_CACHE_DIR and reused from
 * disk after that, so the only moment this needs the network is first run.
 */
export function localEmbedder(model: string, dim: number, cacheDir: string): Embedder {
  // Loading the pipeline is slow and may fail, so it is deferred to first use
  // and the in-flight promise is shared rather than re-entered per batch.
  let pipelinePromise: Promise<FeatureExtractor> | null = null;

  async function load(): Promise<FeatureExtractor> {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    // Everything runs from the local cache; nothing is read from ./models.
    env.allowLocalModels = false;
    const extractor = (await pipeline('feature-extraction', model)) as unknown as FeatureExtractor;
    return extractor;
  }

  return {
    name: model,
    dim,

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      if (!pipelinePromise) {
        pipelinePromise = load().catch((error: unknown) => {
          // Clear the memo so a later call can retry once the network is back.
          pipelinePromise = null;
          throw error;
        });
      }
      const extractor = await pipelinePromise;

      // Mean pooling plus normalisation is what this model expects, and it
      // gives unit vectors so downstream cosine is a dot product.
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const flat = output.data as Float32Array;
      const width = output.dims[output.dims.length - 1] ?? dim;

      if (width !== dim) {
        throw new Error(
          `Model ${model} produced ${width}-dim vectors but EMBEDDING_DIM is ${dim}. ` +
            'Update EMBEDDING_DIM and re-embed, or the vector index will reject them.',
        );
      }

      return texts.map((_, i) => Float32Array.from(flat.subarray(i * width, (i + 1) * width)));
    },
  };
}

interface FeatureExtractorOutput {
  data: Float32Array;
  dims: number[];
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<FeatureExtractorOutput>;
