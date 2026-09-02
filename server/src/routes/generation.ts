import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import { generateNotes } from '../services/generation.js';

/**
 * Generation is one section at a time and runs inside the request.
 *
 * Ingestion needed a background job because a textbook takes minutes and holds
 * everything else up. One section's notes are a handful of model calls, and
 * the page has nothing useful to do while it waits — so the simpler shape is
 * the right one here, and the spending limits stop it running away.
 */
export async function generationRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.post('/api/sections/:id/notes/generate', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ fresh: z.boolean().optional() }).parse(request.body ?? {});

    const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
    if (!section) return reply.code(404).send({ error: 'Section not found' });

    try {
      return await generateNotes({ sectionId: id, ...(body.fresh ? { fresh: true } : {}) });
    } catch (error) {
      const name = (error as Error).name;
      // A spending limit is not a server fault, and saying so plainly is the
      // difference between "try again" and "raise the cap or look at the loop".
      const capped =
        name === 'RunCeilingError' || name === 'MonthlyCapError' || name === 'IterationLimitError';
      return reply.code(capped ? 429 : 400).send({ error: (error as Error).message });
    }
  });
}
