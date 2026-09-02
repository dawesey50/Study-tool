import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { flatten, getTree } from '../services/sections.js';
import {
  cancelGeneration,
  getQuestionJob,
  isGenerating,
  startGeneration,
} from '../services/questions/jobs.js';
import { keyDistribution, longestRun } from '../services/questions/balance.js';

/**
 * The question bank and practice.
 *
 * Two decisions worth stating. First, generation is a job rather than a
 * request, because a batch is minutes of model calls — the shape follows
 * ingestion and concept extraction rather than note generation.
 *
 * Second, practice never sends the answer with the question. It would be
 * simpler to hand over the whole record and let the client hide the key, and
 * it would also mean the answer sits in the page for anything to read. The
 * point of the exercise is to answer without seeing it, so the server keeps it
 * until an attempt has been recorded.
 */
export async function questionRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  const moduleOr404 = (id: string) =>
    db.select().from(schema.modules).where(eq(schema.modules.id, id)).get();

  // --- generation ----------------------------------------------------------

  app.post('/api/modules/:id/questions/generate', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        count: z.number().int().min(1).max(100).default(10),
        sectionIds: z.array(z.string()).optional(),
        skipExaminer: z.boolean().optional(),
      })
      .parse(request.body ?? {});

    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });
    if (isGenerating(id)) {
      return reply.code(409).send({ error: 'A generation run is already going for this module' });
    }

    const concepts = conceptCount(id, body.sectionIds);
    if (concepts === 0) {
      // Saying which step is missing beats a run that returns nothing. Questions
      // are sampled from the concept list, never from the notes.
      return reply.code(400).send({
        error:
          'No concepts to build questions from. Extract concepts for this module first — ' +
          'questions come from the concept list rather than from the notes.',
      });
    }

    return startGeneration({
      moduleId: id,
      count: body.count,
      ...(body.sectionIds?.length ? { sectionIds: body.sectionIds } : {}),
      ...(body.skipExaminer ? { skipExaminer: true } : {}),
    });
  });

  app.get('/api/modules/:id/questions/job', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const job = getQuestionJob(id);
    if (!job) return reply.code(404).send({ error: 'No generation run for this module' });
    return job;
  });

  app.post('/api/modules/:id/questions/cancel', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!cancelGeneration(id)) {
      return reply.code(409).send({ error: 'Nothing is running for this module' });
    }
    return { cancelling: true };
  });

  // --- the bank ------------------------------------------------------------

  /**
   * Everything generated for a module, with the two set-level properties that
   * cannot be judged from any single question: how the answers fall across the
   * positions, and the longest run of the same letter. Those are the numbers
   * that say whether the bank is scoreable without knowing the material.
   */
  app.get('/api/modules/:id/questions', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const query = z
      .object({
        sectionId: z.string().optional(),
        format: z.string().optional(),
        source: z.enum(['generated', 'past_paper']).optional(),
      })
      .parse(request.query ?? {});

    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });

    const rows = db
      .select()
      .from(schema.questions)
      .where(
        query.source
          ? and(eq(schema.questions.moduleId, id), eq(schema.questions.source, query.source))
          : eq(schema.questions.moduleId, id),
      )
      .orderBy(desc(schema.questions.createdAt))
      .all();

    const filtered = rows.filter((row) => {
      if (query.format && row.format !== query.format) return false;
      if (query.sectionId && !(row.sectionIds ?? []).includes(query.sectionId)) return false;
      return true;
    });

    const paths = sectionPaths(id);
    const mcqs = filtered.filter((row) => (row.optionsJson ?? []).length > 0);

    return {
      questions: filtered.map((row) => ({
        ...row,
        embedding: undefined,
        sectionPaths: (row.sectionIds ?? []).map((sectionId) => paths.get(sectionId) ?? ''),
        accuracy: row.timesServed > 0 ? row.timesCorrect / row.timesServed : null,
      })),
      answerKeys: {
        distribution: keyDistribution(mcqs.map((row) => ({ id: row.id, options: row.optionsJson ?? [] }))),
        longestRun: longestRun(mcqs.map((row) => ({ id: row.id, options: row.optionsJson ?? [] }))),
        counted: mcqs.length,
      },
    };
  });

  app.delete('/api/questions/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const question = db.select().from(schema.questions).where(eq(schema.questions.id, id)).get();
    if (!question) return reply.code(404).send({ error: 'Question not found' });
    db.delete(schema.questions).where(eq(schema.questions.id, id)).run();
    return { deleted: id };
  });

  // --- practice ------------------------------------------------------------

  /**
   * A set to work through, without the answers.
   *
   * Ordering puts the least-served questions first so a bank of fifty is not
   * experienced as the same five, and ties break on the weakest accuracy.
   */
  app.get('/api/modules/:id/practice', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const query = z
      .object({
        count: z.coerce.number().int().min(1).max(50).default(10),
        sectionId: z.string().optional(),
      })
      .parse(request.query ?? {});

    if (!moduleOr404(id)) return reply.code(404).send({ error: 'Module not found' });

    const rows = db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.moduleId, id))
      .all()
      .filter((row) => !query.sectionId || (row.sectionIds ?? []).includes(query.sectionId))
      .sort((a, b) => {
        if (a.timesServed !== b.timesServed) return a.timesServed - b.timesServed;
        const accuracyA = a.timesServed ? a.timesCorrect / a.timesServed : 1;
        const accuracyB = b.timesServed ? b.timesCorrect / b.timesServed : 1;
        return accuracyA - accuracyB;
      })
      .slice(0, query.count);

    const paths = sectionPaths(id);

    return {
      questions: rows.map((row) => ({
        id: row.id,
        format: row.format,
        stem: row.stem,
        bloomLevel: row.bloomLevel,
        figureId: row.figureId,
        sectionPaths: (row.sectionIds ?? []).map((sectionId) => paths.get(sectionId) ?? ''),
        // Option text only. Which one is correct, the worked answer and the
        // mark scheme are all withheld until an attempt is recorded.
        options: (row.optionsJson ?? []).map((option) => option.text),
      })),
    };
  });

  /**
   * Record an attempt and return the marking.
   *
   * The confidence rating is asked for every time and is not optional in
   * spirit, because confident-and-wrong is the signal the whole scheduler
   * cares about: a concept you got wrong while sure of yourself is worth more
   * revision than one you guessed at and missed.
   */
  app.post('/api/questions/:id/attempt', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        /** The option index for an MCQ, or written text for everything else. */
        optionIndex: z.number().int().min(0).optional(),
        text: z.string().optional(),
        confidence: z.number().int().min(1).max(5).optional(),
        secondsTaken: z.number().min(0).optional(),
      })
      .parse(request.body ?? {});

    const question = db.select().from(schema.questions).where(eq(schema.questions.id, id)).get();
    if (!question) return reply.code(404).send({ error: 'Question not found' });

    const options = question.optionsJson ?? [];
    const isMcq = options.length > 0;

    // Only an MCQ can be marked here. A written answer is recorded with its
    // correctness left null rather than guessed at — marking free text needs a
    // model, and pretending otherwise would put wrong data into the scheduler.
    const correct = isMcq
      ? body.optionIndex !== undefined && options[body.optionIndex]?.correct === true
      : null;

    const attemptId = newId();
    db.insert(schema.attempts)
      .values({
        id: attemptId,
        questionId: id,
        answerGiven: isMcq ? String(body.optionIndex ?? '') : (body.text ?? null),
        correct,
        confidenceRating: body.confidence ?? null,
        secondsTaken: body.secondsTaken ?? null,
      })
      .run();

    db.update(schema.questions)
      .set({
        timesServed: question.timesServed + 1,
        timesCorrect: question.timesCorrect + (correct === true ? 1 : 0),
      })
      .where(eq(schema.questions.id, id))
      .run();

    return {
      attemptId,
      correct,
      marked: isMcq,
      correctIndex: isMcq ? options.findIndex((option) => option.correct) : null,
      options: isMcq ? options : null,
      correctAnswer: question.correctAnswer,
      workedAnswer: question.workedAnswer,
      markScheme: question.markScheme,
      /**
       * Answered wrongly while sure of it. Surfaced here because this is the
       * moment it means something to the person answering, not only to the
       * scheduler later.
       */
      confidentlyWrong: correct === false && (body.confidence ?? 0) >= 4,
      conceptIds: question.conceptIds ?? [],
    };
  });

  /** Marks a written answer by hand, since the server cannot mark free text. */
  app.post('/api/attempts/:id/mark', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ correct: z.boolean() }).parse(request.body ?? {});

    const attempt = db.select().from(schema.attempts).where(eq(schema.attempts.id, id)).get();
    if (!attempt) return reply.code(404).send({ error: 'Attempt not found' });
    if (attempt.correct !== null) {
      return reply.code(409).send({ error: 'That attempt has already been marked' });
    }

    db.update(schema.attempts)
      .set({ correct: body.correct })
      .where(eq(schema.attempts.id, id))
      .run();

    const question = db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.id, attempt.questionId))
      .get();
    if (question && body.correct) {
      db.update(schema.questions)
        .set({ timesCorrect: question.timesCorrect + 1 })
        .where(eq(schema.questions.id, question.id))
        .run();
    }

    return { attemptId: id, correct: body.correct, conceptIds: question?.conceptIds ?? [] };
  });

  // --- helpers -------------------------------------------------------------

  function sectionPaths(moduleId: string): Map<string, string> {
    return new Map(
      flatten(getTree(moduleId)).map((node) => [node.id, `${node.number} ${node.title}`]),
    );
  }

  function conceptCount(moduleId: string, sectionIds?: string[]): number {
    const tree = flatten(getTree(moduleId));
    const wanted = sectionIds?.length
      ? tree.filter((node) => sectionIds.includes(node.id))
      : tree;
    if (wanted.length === 0) return 0;
    return db
      .select()
      .from(schema.concepts)
      .where(
        inArray(
          schema.concepts.sectionId,
          wanted.map((node) => node.id),
        ),
      )
      .all().length;
  }
}
