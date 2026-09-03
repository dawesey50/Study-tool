import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import {
  createExam,
  deleteExam,
  getExam,
  listExams,
  startExam,
  submitExam,
} from '../services/exams.js';

/**
 * Timed exams — §9.
 *
 * The one rule these routes enforce that practice does not: nothing about any
 * answer crosses the wire until the whole paper is submitted. In practice the
 * answer is withheld per question; here it is withheld per paper, because
 * knowing you got question three right changes how you answer question four,
 * and a mock that leaks that measures nothing.
 */
export async function examRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  const moduleOr404 = (id: string) =>
    db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();

  app.get('/api/modules/:id/exams', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });
    return { exams: listExams(id) };
  });

  app.post('/api/modules/:id/exams', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        title: z.string().optional(),
        sectionIds: z.array(z.string()).optional(),
        questionCount: z.number().int().min(1).max(100).optional(),
        minutes: z.number().int().min(5).max(300).optional(),
        pastPaperShare: z.number().min(0).max(1).optional(),
      })
      .parse(request.body ?? {});

    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });

    try {
      return createExam({
        moduleId: id,
        ...(body.title ? { title: body.title } : {}),
        blueprint: {
          ...(body.sectionIds ? { sectionIds: body.sectionIds } : {}),
          ...(body.questionCount ? { questionCount: body.questionCount } : {}),
          ...(body.minutes ? { minutes: body.minutes } : {}),
          ...(body.pastPaperShare !== undefined
            ? { pastPaperShare: body.pastPaperShare }
            : {}),
        },
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get('/api/exams/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const exam = getExam(id);
    if (!exam) return reply.code(404).send({ error: 'Exam not found' });
    return exam;
  });

  /** Starts the clock. Idempotent — reloading the page does not reset it. */
  app.post('/api/exams/:id/start', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const exam = startExam(id);
    if (!exam) return reply.code(404).send({ error: 'Exam not found' });
    return exam;
  });

  app.post('/api/exams/:id/submit', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        answers: z
          .array(
            z.object({
              questionId: z.string(),
              optionIndex: z.number().int().min(0).optional(),
              text: z.string().optional(),
              confidence: z.number().int().min(1).max(5).optional(),
            }),
          )
          .default([]),
      })
      .parse(request.body ?? {});

    try {
      const result = submitExam(id, body.answers);
      if (!result) return reply.code(404).send({ error: 'Exam not found' });
      return result;
    } catch (error) {
      // Submitting twice would double-count every question against the
      // schedule, so it is refused rather than silently re-marked.
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  app.delete('/api/exams/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!deleteExam(id)) return reply.code(404).send({ error: 'Exam not found' });
    return { deleted: id };
  });
}
