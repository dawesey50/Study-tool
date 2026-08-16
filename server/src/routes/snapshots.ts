import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import {
  deleteSnapshot,
  listSnapshots,
  previewRestore,
  restoreSnapshot,
  takeSnapshot,
} from '../services/snapshots.js';

export async function snapshotRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/api/modules/:id/snapshots', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const module = db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
    if (!module) return reply.code(404).send({ error: 'Module not found' });
    return listSnapshots(id);
  });

  /** Take one by hand, before doing something you are not sure about. */
  app.post('/api/modules/:id/snapshots', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ sectionId: z.string().optional(), label: z.string().max(200).optional() })
      .parse(request.body ?? {});

    const module = db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
    if (!module) return reply.code(404).send({ error: 'Module not found' });

    if (body.sectionId) {
      const section = db
        .select()
        .from(schema.sections)
        .where(eq(schema.sections.id, body.sectionId))
        .get();
      if (!section || section.moduleId !== id) {
        return reply.code(404).send({ error: 'Section not found in this module' });
      }
    }

    reply.code(201);
    return takeSnapshot({
      moduleId: id,
      ...(body.sectionId ? { sectionId: body.sectionId } : {}),
      label: body.label?.trim() || 'Restore point',
      reason: 'manual',
    });
  });

  /** What restoring would remove, so the confirmation can say it plainly. */
  app.get('/api/snapshots/:id/preview', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const preview = previewRestore(id);
    if (!preview) return reply.code(404).send({ error: 'Restore point not found' });
    return preview;
  });

  app.post('/api/snapshots/:id/restore', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return await restoreSnapshot(id);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.delete('/api/snapshots/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    deleteSnapshot(id);
    return reply.code(204).send();
  });
}
