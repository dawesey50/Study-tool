import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import {
  createBlock,
  deleteBlock,
  listBlocks,
  reorderBlocks,
  updateBlock,
} from '../services/notes.js';

const BLOCK_TYPES = [
  'heading',
  'prose',
  'list',
  'table',
  'diagram',
  'figure',
  'callout',
  'summary',
  'crossref',
] as const;

export async function noteRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/api/sections/:id/notes', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
    if (!section) return reply.code(404).send({ error: 'Section not found' });

    return listBlocks(id).map(publicBlock);
  });

  app.post('/api/sections/:id/notes', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        type: z.enum(BLOCK_TYPES).default('prose'),
        markdown: z.string().default(''),
        position: z.number().int().min(0).optional(),
        figureId: z.string().nullable().optional(),
        targetSectionId: z.string().nullable().optional(),
        conceptIds: z.array(z.string()).optional(),
        sourceRefs: z.array(z.string()).optional(),
      })
      .parse(request.body ?? {});

    const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
    if (!section) return reply.code(404).send({ error: 'Section not found' });

    reply.code(201);
    return publicBlock(await createBlock({ sectionId: id, ...body }));
  });

  app.patch('/api/notes/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        markdown: z.string().optional(),
        type: z.enum(BLOCK_TYPES).optional(),
        conceptIds: z.array(z.string()).optional(),
        sourceRefs: z.array(z.string()).optional(),
        locked: z.boolean().optional(),
        figureId: z.string().nullable().optional(),
        targetSectionId: z.string().nullable().optional(),
      })
      .parse(request.body);

    try {
      return publicBlock(await updateBlock(id, body));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.delete('/api/notes/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    deleteBlock(id);
    return reply.code(204).send();
  });

  app.put('/api/sections/:id/notes/order', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ orderedIds: z.array(z.string()) }).parse(request.body);

    const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
    if (!section) return reply.code(404).send({ error: 'Section not found' });

    return reorderBlocks(id, body.orderedIds).map(publicBlock);
  });
}

/** The embedding blob is internal; everything else about a block is public. */
function publicBlock(block: typeof schema.noteBlocks.$inferSelect) {
  const { embedding, ...rest } = block;
  return { ...rest, embedded: embedding !== null };
}
