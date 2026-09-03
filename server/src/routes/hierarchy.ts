import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import {
  applyHierarchy,
  notesAtRisk,
  proposeHierarchy,
  type ProposedSection,
} from '../services/hierarchy.js';

/**
 * Proposing a hierarchy — §4's default flow.
 *
 * Proposing and applying are two calls on purpose. Applying deletes any
 * section the proposal omits, along with the notes inside it, so a hierarchy
 * that arrived and rearranged your work by itself would be the most
 * destructive thing in the system. What comes back from the proposal is data
 * to look at; applying it is a separate, deliberate act.
 */

const sectionSchema: z.ZodType<ProposedSection> = z.lazy(() =>
  z.object({
    title: z.string().min(1),
    rationale: z.string().optional(),
    existing: z.boolean().optional(),
    children: z.array(sectionSchema).optional(),
  }),
);

export async function hierarchyRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  const moduleOr404 = (id: string) =>
    db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();

  app.post('/api/modules/:id/hierarchy/propose', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });

    try {
      return await proposeHierarchy({ moduleId: id });
    } catch (error) {
      const name = (error as Error).name;
      const capped =
        name === 'RunCeilingError' || name === 'MonthlyCapError' || name === 'IterationLimitError';
      return reply.code(capped ? 429 : 400).send({ error: (error as Error).message });
    }
  });

  /**
   * What applying would cost, before it is applied.
   *
   * Asked separately so the confirmation can name the sections whose notes
   * would go, rather than warning in the abstract.
   */
  app.post('/api/modules/:id/hierarchy/preview', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ sections: z.array(sectionSchema) }).parse(request.body ?? {});
    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });
    return { atRisk: notesAtRisk(id, body.sections) };
  });

  app.post('/api/modules/:id/hierarchy/apply', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ sections: z.array(sectionSchema).min(1) }).parse(request.body ?? {});
    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });
    return applyHierarchy(id, body.sections);
  });
}
