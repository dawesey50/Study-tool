import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import {
  assessPlausibility,
  chunksForSection,
  conceptLinks,
  listConcepts,
  setOwner,
} from '../services/concepts.js';
import {
  cancelExtraction,
  getConceptJob,
  isExtracting,
  startExtraction,
} from '../services/conceptJobs.js';
import { markExaminableFromPastPapers } from '../services/pastPapers.js';
import { describeLocation } from '../services/search.js';
import { flatten, getTree } from '../services/sections.js';

const CONCEPT_TYPES = [
  'fact',
  'mechanism',
  'pathway',
  'relationship',
  'calculation',
  'clinical',
  'experimental',
  'anatomy',
] as const;

export async function conceptRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  /**
   * The concept list for a section, with everything needed to judge it: where
   * each one came from, and whether another section says the same thing.
   */
  app.get('/api/sections/:id/concepts', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
    if (!section) return reply.code(404).send({ error: 'Section not found' });

    const concepts = listConcepts(id);
    const chunks = chunksForSection(id);
    const sourceChars = chunks.reduce((total, chunk) => total + chunk.text.length, 0);

    // Citations are resolved to something readable here rather than in the
    // client, because "slide 14" is derived from the chunk and the client
    // should not have to fetch every chunk to render a list.
    const locations = new Map(chunks.map((chunk) => [chunk.id, chunk.location]));

    const links = concepts.length
      ? db
          .select()
          .from(schema.conceptLinks)
          .where(
            inArray(
              schema.conceptLinks.fromConceptId,
              concepts.map((concept) => concept.id),
            ),
          )
          .all()
      : [];

    const ownerIds = links.map((link) => link.toConceptId);
    const owners = ownerIds.length
      ? db.select().from(schema.concepts).where(inArray(schema.concepts.id, ownerIds)).all()
      : [];
    const ownerSections = owners.length
      ? flatten(getTree(section.moduleId)).filter((node) =>
          owners.some((owner) => owner.sectionId === node.id),
        )
      : [];

    return {
      sectionId: id,
      sourceChars,
      sourceChunks: chunks.length,
      plausibility: assessPlausibility(concepts.length, sourceChars),
      concepts: concepts.map((concept) => {
        const link = links.find((row) => row.fromConceptId === concept.id);
        const owner = link ? owners.find((row) => row.id === link.toConceptId) : undefined;
        const ownerSection = owner
          ? ownerSections.find((node) => node.id === owner.sectionId)
          : undefined;
        const { embedding, ...rest } = concept;
        return {
          ...rest,
          embedded: embedding !== null,
          citations: (concept.sourceChunkIds ?? [])
            .map((chunkId) => locations.get(chunkId))
            .filter(Boolean),
          /** Set when another section owns this idea and this one repeats it. */
          ownedElsewhere: owner
            ? {
                conceptId: owner.id,
                sectionId: owner.sectionId,
                sectionNumber: ownerSection?.number ?? '',
                sectionTitle: ownerSection?.title ?? '',
                note: link?.note ?? null,
              }
            : null,
        };
      }),
    };
  });

  /** Start extraction for a module, or a named subset of its sections. */
  app.post('/api/modules/:id/concepts/extract', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ sectionIds: z.array(z.string()).optional(), fresh: z.boolean().optional() })
      .parse(request.body ?? {});

    const module = db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
    if (!module) return reply.code(404).send({ error: 'Module not found' });

    reply.code(202);
    return startExtraction({
      moduleId: id,
      ...(body.sectionIds ? { sectionIds: body.sectionIds } : {}),
      ...(body.fresh ? { fresh: true } : {}),
    });
  });

  app.get('/api/modules/:id/concepts/job', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const job = getConceptJob(id);
    if (!job) return reply.code(404).send({ error: 'No extraction has run for this module' });
    return { ...job, running: isExtracting(id) };
  });

  app.post('/api/modules/:id/concepts/cancel', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return { cancelled: cancelExtraction(id) };
  });

  /**
   * Correct a concept by hand. Extraction proposes and you decide, the same as
   * section mapping — if the list is not correctable it is not reviewable, and
   * a list you cannot trust is worse than none.
   */
  app.patch('/api/concepts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        statement: z.string().min(1).optional(),
        type: z.enum(CONCEPT_TYPES).optional(),
        examinableFlag: z.boolean().optional(),
        emphasisScore: z.number().min(0).max(1).nullable().optional(),
        difficulty: z.number().int().min(1).max(5).nullable().optional(),
        bloomCeiling: z.string().nullable().optional(),
      })
      .parse(request.body);

    const existing = db.select().from(schema.concepts).where(eq(schema.concepts.id, id)).get();
    if (!existing) return reply.code(404).send({ error: 'Concept not found' });

    db.update(schema.concepts).set(body).where(eq(schema.concepts.id, id)).run();
    const { embedding, ...rest } = db
      .select()
      .from(schema.concepts)
      .where(eq(schema.concepts.id, id))
      .get()!;
    return { ...rest, embedded: embedding !== null };
  });

  app.delete('/api/concepts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    db.delete(schema.concepts).where(eq(schema.concepts.id, id)).run();
    return reply.code(204).send();
  });

  /** Move ownership of a duplicated idea to the section that should hold it. */
  app.post('/api/concepts/:id/owner', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { ownerId } = z.object({ ownerId: z.string() }).parse(request.body);

    const rows = db
      .select()
      .from(schema.concepts)
      .where(inArray(schema.concepts.id, [id, ownerId]))
      .all();
    if (rows.length !== 2) return reply.code(404).send({ error: 'Concept not found' });

    setOwner(id, ownerId);
    return conceptLinks(id);
  });

  /**
   * Let the past papers say what is examinable. No model involved: every
   * question in a past paper was, by definition, examined.
   */
  app.post('/api/modules/:id/concepts/examinable', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ sourceIds: z.array(z.string()).optional() }).parse(request.body ?? {});

    const module = db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();
    if (!module) return reply.code(404).send({ error: 'Module not found' });

    return markExaminableFromPastPapers({
      moduleId: id,
      ...(body.sourceIds ? { sourceIds: body.sourceIds } : {}),
    });
  });

  /** The chunks a concept cites, so a claim can be checked against its source. */
  app.get('/api/concepts/:id/sources', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const concept = db.select().from(schema.concepts).where(eq(schema.concepts.id, id)).get();
    if (!concept) return reply.code(404).send({ error: 'Concept not found' });

    const ids = concept.sourceChunkIds ?? [];
    if (ids.length === 0) return [];

    return db
      .select({
        id: schema.chunks.id,
        text: schema.chunks.text,
        pageNo: schema.chunks.pageNo,
        slideNo: schema.chunks.slideNo,
        timestamp: schema.chunks.timestamp,
        sourceTitle: schema.sources.title,
        sourceType: schema.sources.type,
      })
      .from(schema.chunks)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.chunks.sourceId))
      .where(inArray(schema.chunks.id, ids))
      .all()
      .map((row) => ({ id: row.id, text: row.text, location: describeLocation(row) }));
  });
}
