import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import { dueConcepts, misconceptions, moduleMastery, revisionSummary } from '../services/schedule.js';

/**
 * What is due, and how well the module is known.
 *
 * All read-only: the schedule is written from the attempt route, because an
 * answer is the only thing that constitutes evidence. There is deliberately no
 * endpoint to set a concept's mastery by hand — a number you can set yourself
 * is a number that stops meaning anything.
 */
export async function revisionRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  const moduleOr404 = (id: string) =>
    db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();

  /** Everything the revision view needs, in one request it can poll. */
  app.get('/api/modules/:id/revision', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });
    return revisionSummary(id);
  });

  app.get('/api/modules/:id/due', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query ?? {});
    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });
    return { concepts: dueConcepts(id, { limit: query.limit }) };
  });

  app.get('/api/modules/:id/mastery', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });
    return { sections: moduleMastery(id) };
  });

  /**
   * The things you believe and have wrong. Separate from the due list on
   * purpose: the answer to one of these is to go back and read, not to be
   * asked again — drilling a belief only rehearses it.
   */
  app.get('/api/modules/:id/misconceptions', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });
    return { concepts: misconceptions(id) };
  });
}
