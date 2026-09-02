import { eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, isVecAvailable, schema } from '../db/index.js';
import { indexVector, reindexKind } from '../db/vectorIndex.js';
import { config } from '../config.js';
import { embedderStatus, embedSafely } from '../embeddings/index.js';
import { toBlob } from '../lib/vector.js';
import { search, type SearchKind } from '../services/search.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/api/search', async (request) => {
    const query = z
      .object({
        q: z.string().default(''),
        moduleId: z.string().optional(),
        kinds: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(request.query);

    const kinds = query.kinds?.split(',').filter(Boolean) as SearchKind[] | undefined;
    return search(query.q, {
      ...(query.moduleId ? { moduleId: query.moduleId } : {}),
      ...(kinds?.length ? { kinds } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
  });

  app.get('/api/health', async () => ({
    ok: true,
    embeddings: embedderStatus(),
    vectorIndex: isVecAvailable() ? 'sqlite-vec' : 'brute-force',
    vectorBackendRequested: config.vectorBackend,
    dataDir: config.dataDir,
    maxUploadMb: config.maxUploadMb,
  }));

  /**
   * Fill in vectors for anything stored without them.
   *
   * Ingestion never fails just because the embedding model could not be
   * reached, so this is the way back to a fully searchable database once it
   * can be: run it after the first successful model download, or after
   * switching provider.
   */
  app.post('/api/embeddings/backfill', async (request) => {
    const body = z
      .object({ batchSize: z.number().int().min(1).max(256).default(32) })
      .parse(request.body ?? {});

    const pendingChunks = db
      .select({ id: schema.chunks.id, text: schema.chunks.text })
      .from(schema.chunks)
      .where(isNull(schema.chunks.embedding))
      .all();

    const pendingBlocks = db
      .select({ id: schema.noteBlocks.id, text: schema.noteBlocks.markdown })
      .from(schema.noteBlocks)
      .where(isNull(schema.noteBlocks.embedding))
      .all()
      .filter((row) => row.text.trim().length > 0);

    const chunksDone = await backfill(pendingChunks, body.batchSize, (id, vector) => {
      db.update(schema.chunks)
        .set({ embedding: toBlob(vector) })
        .where(eq(schema.chunks.id, id))
        .run();
      indexVector('chunk', id, vector);
    });

    const blocksDone = await backfill(pendingBlocks, body.batchSize, (id, vector) => {
      db.update(schema.noteBlocks)
        .set({ embedding: toBlob(vector) })
        .where(eq(schema.noteBlocks.id, id))
        .run();
      indexVector('note_block', id, vector);
    });

    return {
      chunks: { pending: pendingChunks.length, embedded: chunksDone },
      noteBlocks: { pending: pendingBlocks.length, embedded: blocksDone },
      embeddings: embedderStatus(),
    };
  });

  /** Rebuild the KNN index from the vectors already on the entity rows. */
  app.post('/api/embeddings/reindex', async () => {
    if (!isVecAvailable()) {
      return { reindexed: false, reason: 'sqlite-vec is not loaded; search uses brute force' };
    }
    return {
      reindexed: true,
      counts: {
        chunk: reindexKind('chunk'),
        figure: reindexKind('figure'),
        note_block: reindexKind('note_block'),
        concept: reindexKind('concept'),
        question: reindexKind('question'),
      },
    };
  });
}

async function backfill(
  rows: Array<{ id: string; text: string }>,
  batchSize: number,
  store: (id: string, vector: Float32Array) => void,
): Promise<number> {
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const vectors = await embedSafely(batch.map((row) => row.text));
    // A whole batch of nulls means the provider is still unreachable; stop
    // rather than grinding through every remaining row to no effect.
    if (vectors.every((vector) => vector === null)) break;

    for (const [j, vector] of vectors.entries()) {
      if (!vector) continue;
      store(batch[j]!.id, vector);
      done++;
    }
  }
  return done;
}
