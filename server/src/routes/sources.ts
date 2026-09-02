import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { cancelIngest, getJob, startIngest } from '../ingest/jobs.js';
import { newId } from '../lib/ids.js';
import { fromStoredPath, storedPath, toMediaUrl } from '../lib/paths.js';
import { listMappings, proposeSectionsForSource } from '../services/mapping.js';
import { describeLocation } from '../services/search.js';

const SOURCE_TYPES = ['slides', 'transcript', 'textbook', 'notes', 'past_paper'] as const;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md', '.vtt', '.srt']);

class FileTooLargeError extends Error {
  readonly code = 'FST_REQ_FILE_TOO_LARGE';
}

/**
 * An oversized upload aborts the multipart stream itself, so the error arrives
 * from the parts iterator rather than from writing the file — which is why
 * checking `part.file.truncated` afterwards never fired, and the limit came
 * back as a bare "request file too large" with no mention of the limit or how
 * to change it.
 */
function isTooLarge(error: unknown): boolean {
  const { code, statusCode, message } = (error ?? {}) as {
    code?: string;
    statusCode?: number;
    message?: string;
  };
  return (
    code === 'FST_REQ_FILE_TOO_LARGE' ||
    statusCode === 413 ||
    /file too large/i.test(message ?? '')
  );
}

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get('/api/modules/:id/sources', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sources = db
      .select()
      .from(schema.sources)
      .where(eq(schema.sources.moduleId, id))
      .orderBy(asc(schema.sources.createdAt))
      .all();

    return sources.map((source) => ({ ...source, sections: listMappings(source.id) }));
  });

  /**
   * Upload a file. Storing it is deliberately separate from parsing it: the
   * original is on disk and safe before any parser gets a chance to fail.
   *
   * All parts are iterated rather than reaching for request.file(), because a
   * multipart body is a stream and the convenience helper only exposes the
   * fields that happened to arrive before the file. Iterating means the form
   * can put title and type on either side of the file and still be read.
   */
  app.post('/api/modules/:id/sources', async (request, reply) => {
    const { id: moduleId } = z.object({ id: z.string() }).parse(request.params);
    const module = db.select().from(schema.modules).where(eq(schema.modules.id, moduleId)).get();
    if (!module) return reply.code(404).send({ error: 'Module not found' });

    const sourceId = newId();
    const fields = new Map<string, string>();
    let stored: { filename: string; extension: string; relativePath: string } | null = null;
    let rejection: { code: number; error: string } | null = null;
    let writtenPath: string | null = null;
    let currentFilename = 'That file';

    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          fields.set(part.fieldname, String(part.value));
          continue;
        }

        // A second file in one request is ignored, but its stream still has to be
        // drained or the request will not complete.
        if (stored || rejection) {
          await part.toBuffer().catch(() => undefined);
          continue;
        }

        currentFilename = part.filename;
        const extension = path.extname(part.filename).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(extension)) {
          rejection = {
            code: 400,
            error: `Unsupported file type "${extension}". Supported: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
          };
          await part.toBuffer().catch(() => undefined);
          continue;
        }

        const relativePath = storedPath('media', 'sources', moduleId, `${sourceId}${extension}`);
        const absolutePath = fromStoredPath(relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        writtenPath = absolutePath;

        await pipeline(part.file, fs.createWriteStream(absolutePath));

        // Belt and braces: multipart normally throws on an oversized file
        // before this is reached, but it can be configured not to.
        if (part.file.truncated) throw new FileTooLargeError();

        stored = { filename: part.filename, extension, relativePath };
        writtenPath = null;
      }
    } catch (error) {
      // Half a file on disk is worse than none: ingestion would read it and
      // report a corrupt PDF rather than the real problem.
      if (writtenPath) fs.rmSync(writtenPath, { force: true });

      if (isTooLarge(error)) {
        return reply.code(413).send({
          error:
            `"${currentFilename}" is bigger than the ${config.maxUploadMb} MB upload limit. ` +
            'Raise MAX_UPLOAD_MB in the .env file in the project folder and restart — ' +
            'scanned textbooks are often several hundred megabytes.',
        });
      }

      request.log.error(error);
      return reply.code(500).send({
        error: `Could not store "${currentFilename}": ${(error as Error).message}`,
      });
    }

    if (rejection) return reply.code(rejection.code).send({ error: rejection.error });
    if (!stored) return reply.code(400).send({ error: 'Expected a multipart file upload' });

    const rawType = fields.get('type');
    const type = (SOURCE_TYPES as readonly string[]).includes(rawType ?? '')
      ? (rawType as schema.SourceType)
      : inferType(stored.extension);

    db.insert(schema.sources)
      .values({
        id: sourceId,
        moduleId,
        type,
        title: fields.get('title')?.trim() || path.basename(stored.filename, stored.extension),
        filename: stored.filename,
        path: stored.relativePath,
        lectureDate: fields.get('lectureDate')?.trim() || null,
        status: 'uploaded',
      })
      .run();

    reply.code(201);
    return db.select().from(schema.sources).where(eq(schema.sources.id, sourceId)).get();
  });

  app.get('/api/sources/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const source = db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
    if (!source) return reply.code(404).send({ error: 'Source not found' });

    const figures = db
      .select()
      .from(schema.figures)
      .where(eq(schema.figures.sourceId, id))
      .orderBy(asc(schema.figures.pageNo))
      .all();

    return {
      ...source,
      sections: listMappings(id),
      figures: figures.map(publicFigure),
      chunkCount: db
        .select()
        .from(schema.chunks)
        .where(eq(schema.chunks.sourceId, id))
        .all().length,
    };
  });

  app.patch('/api/sources/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        title: z.string().min(1).optional(),
        type: z.enum(SOURCE_TYPES).optional(),
        lectureDate: z.string().nullable().optional(),
      })
      .parse(request.body);

    const source = db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
    if (!source) return reply.code(404).send({ error: 'Source not found' });

    db.update(schema.sources).set(body).where(eq(schema.sources.id, id)).run();
    return db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
  });

  /**
   * Start parsing, chunking, embedding and mapping. Safe to re-run; it
   * replaces rather than appends.
   *
   * Returns immediately with a job to follow rather than holding the request
   * open. A textbook takes minutes, and waiting inside the handler blocked
   * every other call behind it — which is what made writing notes impossible
   * while a large document was being read.
   */
  app.post('/api/sources/:id/ingest', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const source = db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
    if (!source) return reply.code(404).send({ error: 'Source not found' });

    reply.code(202);
    return startIngest(id);
  });

  /** Stop an ingestion that is running. */
  app.delete('/api/sources/:id/ingest', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const stopped = cancelIngest(id);
    if (!stopped) return reply.code(409).send({ error: 'Nothing is being ingested for this source' });
    return { cancelling: true };
  });

  /** Follow an ingestion in progress. */
  app.get('/api/sources/:id/ingest', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const job = getJob(id);
    if (!job) {
      const source = db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
      if (!source) return reply.code(404).send({ error: 'Source not found' });
      // No job in memory: either it was never started this run, or the server
      // restarted. The stored status is the truth in that case.
      return {
        sourceId: id,
        phase: source.status === 'ingested' ? 'done' : source.status === 'failed' ? 'failed' : 'queued',
        done: 0,
        total: 0,
        message: source.error ?? '',
        startedAt: 0,
        ...(source.error ? { error: source.error } : {}),
      };
    }
    return job;
  });

  app.get('/api/sources/:id/chunks', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const rows = db
      .select({
        id: schema.chunks.id,
        text: schema.chunks.text,
        pageNo: schema.chunks.pageNo,
        slideNo: schema.chunks.slideNo,
        timestamp: schema.chunks.timestamp,
        position: schema.chunks.position,
        hasEmbedding: schema.chunks.embedding,
        sourceTitle: schema.sources.title,
        sourceType: schema.sources.type,
      })
      .from(schema.chunks)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.chunks.sourceId))
      .where(eq(schema.chunks.sourceId, id))
      .orderBy(asc(schema.chunks.position))
      .all();

    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      pageNo: row.pageNo,
      slideNo: row.slideNo,
      timestamp: row.timestamp,
      position: row.position,
      embedded: row.hasEmbedding !== null,
      location: describeLocation(row),
    }));
  });

  /** Re-run section matching without re-parsing the file. */
  app.post('/api/sources/:id/propose-sections', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const source = db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
    if (!source) return reply.code(404).send({ error: 'Source not found' });
    return proposeSectionsForSource(id);
  });

  /** Confirm or correct which sections a source belongs to. */
  app.put('/api/sources/:id/sections', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ sectionIds: z.array(z.string()) }).parse(request.body);

    const source = db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
    if (!source) return reply.code(404).send({ error: 'Source not found' });

    const valid = body.sectionIds.length
      ? db
          .select({ id: schema.sections.id })
          .from(schema.sections)
          .where(
            and(
              eq(schema.sections.moduleId, source.moduleId),
              inArray(schema.sections.id, body.sectionIds),
            ),
          )
          .all()
          .map((row) => row.id)
      : [];

    const existing = db
      .select()
      .from(schema.sourceSections)
      .where(eq(schema.sourceSections.sourceId, id))
      .all();
    const previous = new Map(existing.map((row) => [row.sectionId, row]));

    db.transaction((tx) => {
      tx.delete(schema.sourceSections).where(eq(schema.sourceSections.sourceId, id)).run();
      for (const sectionId of valid) {
        tx.insert(schema.sourceSections)
          .values({
            sourceId: id,
            sectionId,
            // Keep the chunk range the matcher worked out, if it had one.
            chunkRange: previous.get(sectionId)?.chunkRange ?? null,
            score: previous.get(sectionId)?.score ?? null,
            confirmed: true,
          })
          .run();
      }
    });

    return listMappings(id);
  });

  app.delete('/api/sources/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const source = db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
    if (!source) return reply.code(204).send();

    // Chunks and figures cascade in SQL; the files they point at do not.
    db.delete(schema.sources).where(eq(schema.sources.id, id)).run();
    fs.rmSync(fromStoredPath(source.path), { force: true });
    fs.rmSync(path.join(config.mediaDir, 'figures', id), { recursive: true, force: true });

    return reply.code(204).send();
  });

  // --- Figures --------------------------------------------------------------

  app.get('/api/sections/:id/figures', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    // Figures reachable from a section are those in the sources mapped to it.
    const sourceIds = db
      .select({ sourceId: schema.sourceSections.sourceId })
      .from(schema.sourceSections)
      .where(eq(schema.sourceSections.sectionId, id))
      .all()
      .map((row) => row.sourceId);

    if (sourceIds.length === 0) return [];

    return db
      .select()
      .from(schema.figures)
      .where(inArray(schema.figures.sourceId, sourceIds))
      .orderBy(asc(schema.figures.pageNo))
      .all()
      .map(publicFigure);
  });
}

/** Never leak the embedding blob or an absolute filesystem path to the client. */
function publicFigure(figure: typeof schema.figures.$inferSelect) {
  return {
    id: figure.id,
    sourceId: figure.sourceId,
    url: toMediaUrl(figure.path),
    pageNo: figure.pageNo,
    width: figure.width,
    height: figure.height,
    captionExtracted: figure.captionExtracted,
    captionAi: figure.captionAi,
    altText: figure.altText,
    type: figure.type,
  };
}

function inferType(extension: string): schema.SourceType {
  if (extension === '.vtt' || extension === '.srt') return 'transcript';
  if (extension === '.txt' || extension === '.md') return 'notes';
  return 'slides';
}

/** Exported for the upload form so both sides agree on what is accepted. */
export const acceptedExtensions = [...ALLOWED_EXTENSIONS];
