import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { exportModule, importModule } from '../services/archive.js';
import {
  createSection,
  deleteSection,
  flatten,
  getTree,
  moveSection,
  replaceTree,
  type TreeInput,
} from '../services/sections.js';

const treeNodeSchema: z.ZodType<TreeInput> = z.lazy(() =>
  z.object({
    id: z.string().uuid().optional(),
    title: z.string().min(1),
    learningOutcomes: z.array(z.string()).optional(),
    children: z.array(treeNodeSchema).optional(),
  }),
);

export async function moduleRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/api/modules', async () => {
    const modules = db.select().from(schema.modules).orderBy(asc(schema.modules.title)).all();
    return modules.map((module) => ({
      ...module,
      sectionCount: db
        .select({ n: sql<number>`count(*)` })
        .from(schema.sections)
        .where(eq(schema.sections.moduleId, module.id))
        .get()?.n ?? 0,
      sourceCount: db
        .select({ n: sql<number>`count(*)` })
        .from(schema.sources)
        .where(eq(schema.sources.moduleId, module.id))
        .get()?.n ?? 0,
    }));
  });

  app.post('/api/modules', async (request, reply) => {
    const body = z
      .object({
        title: z.string().min(1),
        code: z.string().optional(),
        year: z.number().int().optional(),
        notes: z.string().optional(),
      })
      .parse(request.body);

    const id = newId();
    db.insert(schema.modules)
      .values({
        id,
        title: body.title,
        code: body.code ?? null,
        year: body.year ?? null,
        notes: body.notes ?? null,
      })
      .run();

    reply.code(201);
    return db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
  });

  app.get('/api/modules/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const module = db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
    if (!module) return reply.code(404).send({ error: 'Module not found' });
    return { ...module, sections: getTree(id) };
  });

  app.patch('/api/modules/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        title: z.string().min(1).optional(),
        code: z.string().nullable().optional(),
        year: z.number().int().nullable().optional(),
        notes: z.string().nullable().optional(),
      })
      .parse(request.body);

    const module = db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
    if (!module) return reply.code(404).send({ error: 'Module not found' });

    db.update(schema.modules).set(body).where(eq(schema.modules.id, id)).run();
    return db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
  });

  app.delete('/api/modules/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    db.delete(schema.modules).where(eq(schema.modules.id, id)).run();
    return reply.code(204).send();
  });

  /**
   * Download the module as a single .zip: its rows, its embeddings and every
   * file they point at. This is the backup.
   */
  app.get('/api/modules/:id/export', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      const { filename, zip } = exportModule(id);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(zip);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  /** Restore a module from an export. */
  app.post('/api/modules/import', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'Expected a .zip export' });

    const buffer = await file.toBuffer();
    try {
      return importModule(buffer);
    } catch (error) {
      return reply.code(422).send({ error: (error as Error).message });
    }
  });

  // --- Sections -------------------------------------------------------------

  app.get('/api/modules/:id/sections', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return getTree(id);
  });

  /** Commit a whole tree at once — the "proposed hierarchy, then edited" flow. */
  app.put('/api/modules/:id/sections', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ tree: z.array(treeNodeSchema) }).parse(request.body);

    const module = db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
    if (!module) return reply.code(404).send({ error: 'Module not found' });

    return replaceTree(id, body.tree);
  });

  app.post('/api/sections', async (request, reply) => {
    const body = z
      .object({
        moduleId: z.string(),
        title: z.string().min(1),
        parentId: z.string().nullable().optional(),
        position: z.number().int().min(0).optional(),
        learningOutcomes: z.array(z.string()).optional(),
      })
      .parse(request.body);

    try {
      const section = createSection(body);
      reply.code(201);
      return section;
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get('/api/sections/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
    if (!section) return reply.code(404).send({ error: 'Section not found' });

    const node = flatten(getTree(section.moduleId)).find((n) => n.id === id);
    return { ...section, number: node?.number ?? '', path: node?.path ?? [] };
  });

  app.patch('/api/sections/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        title: z.string().min(1).optional(),
        learningOutcomes: z.array(z.string()).nullable().optional(),
        status: z.enum(['empty', 'drafted', 'edited', 'complete']).optional(),
      })
      .parse(request.body);

    const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
    if (!section) return reply.code(404).send({ error: 'Section not found' });

    db.update(schema.sections).set(body).where(eq(schema.sections.id, id)).run();
    return db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
  });

  /** Drag-and-drop. Returns the whole tree so the client renumbers in one hop. */
  app.post('/api/sections/:id/move', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        parentId: z.string().nullable(),
        position: z.number().int().min(0),
      })
      .parse(request.body);

    try {
      return moveSection(id, body.parentId, body.position);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.delete('/api/sections/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    deleteSection(id);
    return reply.code(204).send();
  });
}
