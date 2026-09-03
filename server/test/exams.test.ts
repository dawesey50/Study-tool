/**
 * Timed exams — §9.
 *
 * Three properties separate a mock from practice with a clock on it, and each
 * one is a thing that can silently stop being true:
 *
 *   - the paper is fixed when it is drawn, so it does not reshuffle between
 *     page loads;
 *   - no answer crosses the wire until the whole paper is submitted, because
 *     knowing you got question three right changes how you answer question
 *     four;
 *   - real past-paper questions are preferred, because a mock built only from
 *     this system's own questions measures how well you do on this system's
 *     questions.
 *
 * The fourth thing tested here is what the paper refuses to claim. Most
 * questions in a real paper are prose, prose cannot be marked without a model
 * and a mark scheme, and past papers ship neither — so a score is reported
 * over what could be marked and says how much it left out. A percentage that
 * quietly ignored two thirds of the paper would be worse than no percentage.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-exams-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { newId } = await import('../src/lib/ids.js');
const { createExam, getExam, submitExam } = await import('../src/services/exams.js');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

before(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** A module with generated MCQs, generated written questions, and real papers. */
async function makeBank(title: string, counts = { mcq: 10, written: 4, paper: 6 }) {
  const db = getDb();
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title } }),
  ).id;

  const tree = json<Array<{ id: string }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: { tree: [{ title: 'Oxidative phosphorylation' }] },
    }),
  );
  const sectionId = tree[0]!.id;

  const conceptId = newId();
  db.insert(schema.concepts)
    .values({
      id: conceptId,
      sectionId,
      statement: 'Oligomycin blocks ATP synthase.',
      type: 'mechanism',
      examinableFlag: true,
    })
    .run();

  const ids = { mcq: [] as string[], written: [] as string[], paper: [] as string[] };

  for (let index = 0; index < counts.mcq; index++) {
    const id = newId();
    ids.mcq.push(id);
    db.insert(schema.questions)
      .values({
        id,
        moduleId,
        format: 'mcq',
        stem: `Generated multiple choice ${index}: which step is blocked?`,
        conceptIds: [conceptId],
        sectionIds: [sectionId],
        // Deliberately not named "right" and "wrong": the leak test checks the
        // wire, and an option whose own text gives it away would make that
        // test pass or fail on the fixture rather than on the payload.
        optionsJson: [
          { text: `Alpha ${index}`, correct: true },
          { text: `Beta ${index}`, correct: false, whyWrong: 'the gradient runs the other way' },
        ],
        workedAnswer: `Because of mechanism ${index}.`,
        source: 'generated',
      })
      .run();
  }

  for (let index = 0; index < counts.written; index++) {
    const id = newId();
    ids.written.push(id);
    db.insert(schema.questions)
      .values({
        id,
        moduleId,
        format: 'saq',
        stem: `Generated written ${index}: explain the mechanism.`,
        conceptIds: [conceptId],
        sectionIds: [sectionId],
        workedAnswer: `The reasoning for ${index}.`,
        source: 'generated',
      })
      .run();
  }

  for (let index = 0; index < counts.paper; index++) {
    const id = newId();
    ids.paper.push(id);
    db.insert(schema.questions)
      .values({
        id,
        moduleId,
        format: 'saq',
        stem: `Real paper question ${index}: describe and explain.`,
        conceptIds: [conceptId],
        sectionIds: [sectionId],
        blueprintJson: { origin: 'past_paper', paper: 'BB20001 2025', number: `${index + 1}`, marks: 6 },
        // A real paper carries no answer, which is the whole reason a mock
        // cannot be fully marked.
        workedAnswer: null,
        source: 'past_paper',
      })
      .run();
  }

  return { moduleId, sectionId, conceptId, ids };
}

// ---------------------------------------------------------------------------
// Drawing the paper
// ---------------------------------------------------------------------------

test('a paper prefers real past-paper questions up to their share', async () => {
  const { moduleId } = await makeBank('Paper mix');

  const exam = createExam({
    moduleId,
    blueprint: { questionCount: 10, pastPaperShare: 0.4 },
    random: seeded(1),
  });

  assert.equal(exam.questions.length, 10);
  const papers = exam.questions.filter((question) => question.source === 'past_paper');

  // Four of ten. A mock built only from this system's own questions measures
  // how well you do on this system's questions.
  assert.equal(papers.length, 4, `got ${papers.length} past-paper questions`);
});

test('a short supply of real questions is made up rather than shortening the paper', async () => {
  // Two real questions but a 50% share of a twelve-question paper asked for.
  const { moduleId } = await makeBank('Few papers', { mcq: 20, written: 0, paper: 2 });

  const exam = createExam({
    moduleId,
    blueprint: { questionCount: 12, pastPaperShare: 0.5 },
    random: seeded(2),
  });

  // Coming up four questions short because the papers ran out would be a
  // worse paper than one topped up with generated questions.
  assert.equal(exam.questions.length, 12);
  assert.equal(exam.questions.filter((question) => question.source === 'past_paper').length, 2);
  assert.equal(new Set(exam.questions.map((question) => question.id)).size, 12, 'no duplicates');
});

test('a paper asking for more questions than exist returns what there is', async () => {
  const { moduleId } = await makeBank('Small bank', { mcq: 3, written: 0, paper: 0 });
  const exam = createExam({ moduleId, blueprint: { questionCount: 20 }, random: seeded(3) });
  assert.equal(exam.questions.length, 3);
  assert.equal(new Set(exam.questions.map((question) => question.id)).size, 3);
});

test('the paper is fixed when drawn and does not reshuffle on reload', async () => {
  const { moduleId } = await makeBank('Stable order');
  const created = createExam({ moduleId, blueprint: { questionCount: 8 }, random: seeded(4) });

  const first = getExam(created.id)!;
  const second = getExam(created.id)!;

  // You can look ahead, skip and come back in an exam. A paper that reorders
  // itself between loads makes that impossible and is a different paper each
  // time you open it.
  assert.deepEqual(
    first.questions.map((question) => question.id),
    created.questions.map((question) => question.id),
  );
  assert.deepEqual(
    second.questions.map((question) => question.id),
    first.questions.map((question) => question.id),
  );
});

test('creating a paper with an empty bank says which step is missing', async () => {
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title: 'Nothing' } }),
  ).id;

  assert.throws(
    () => createExam({ moduleId }),
    /generate|extract/i,
  );
});

// ---------------------------------------------------------------------------
// Sitting it
// ---------------------------------------------------------------------------

test('no answer reaches the page until the paper is submitted', async () => {
  const { moduleId } = await makeBank('Sealed paper');
  const created = createExam({ moduleId, blueprint: { questionCount: 8 }, random: seeded(5) });

  const response = await app.inject({ method: 'GET', url: `/api/exams/${created.id}` });
  const wire = response.body;

  // The rule that makes a mock measure anything. Knowing you got question
  // three right changes how you answer question four, so nothing about any
  // answer is on the wire — not the key, not the reasoning, not even for
  // questions you have already passed.
  assert.ok(!wire.includes('"correct"'), 'the paper leaked which option is correct');
  assert.ok(!wire.includes('workedAnswer'), 'the paper leaked the reasoning');
  assert.ok(!wire.includes('whyWrong'), 'the paper leaked why the distractors are wrong');
  assert.ok(!wire.includes('the gradient runs the other way'));

  const exam = json<{ questions: Array<{ options: string[] }> }>(response);
  assert.ok(exam.questions.some((question) => question.options.length > 0), 'options still shown');
});

test('the clock starts once and reloading does not reset it', async () => {
  const { moduleId } = await makeBank('Clock');
  const created = createExam({ moduleId, blueprint: { questionCount: 5 }, random: seeded(6) });

  const first = json<{ startedAt: number }>(
    await app.inject({ method: 'POST', url: `/api/exams/${created.id}/start` }),
  );
  assert.ok(first.startedAt > 0);

  const second = json<{ startedAt: number }>(
    await app.inject({ method: 'POST', url: `/api/exams/${created.id}/start` }),
  );
  // Otherwise refreshing the page would hand you the full time again.
  assert.equal(second.startedAt, first.startedAt);
});

// ---------------------------------------------------------------------------
// Marking it
// ---------------------------------------------------------------------------

test('a submitted paper scores what it can mark and says what it could not', async () => {
  const { moduleId, ids } = await makeBank('Marking');
  const created = createExam({
    moduleId,
    blueprint: { questionCount: 10, pastPaperShare: 0.4 },
    random: seeded(7),
  });
  await app.inject({ method: 'POST', url: `/api/exams/${created.id}/start` });

  const db = getDb();
  const answers = created.questions.map((question) => {
    if (question.options.length === 0) {
      return { questionId: question.id, text: 'A written answer.', confidence: 3 };
    }
    const stored = db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.id, question.id))
      .get()!;
    const correctIndex = (stored.optionsJson ?? []).findIndex((option) => option.correct);
    return { questionId: question.id, optionIndex: correctIndex, confidence: 4 };
  });

  const result = json<{
    score: number | null;
    marked: number;
    correct: number;
    unmarked: number;
    questions: Array<{ correct: boolean | null; workedAnswer: string | null }>;
  }>(
    await app.inject({
      method: 'POST',
      url: `/api/exams/${created.id}/submit`,
      payload: { answers },
    }),
  );

  const mcqCount = created.questions.filter((question) => question.options.length > 0).length;
  const writtenCount = created.questions.length - mcqCount;

  assert.equal(result.marked, mcqCount);
  assert.equal(result.correct, mcqCount);
  assert.equal(result.unmarked, writtenCount);
  assert.equal(result.score, mcqCount > 0 ? 1 : null);

  // The score is over what could be marked, and the count of what could not is
  // reported beside it. A percentage that silently ignored the written half
  // would read as a result and be a fiction.
  assert.ok(writtenCount > 0, 'the fixture should include written questions');
  assert.ok(result.questions.some((question) => question.correct === null));

  // Answers arrive only now.
  assert.ok(result.questions.some((question) => question.workedAnswer));
  assert.ok(ids.paper.length > 0);
});

test('an unanswered question is marked wrong, not skipped', async () => {
  const { moduleId } = await makeBank('Unanswered', { mcq: 6, written: 0, paper: 0 });
  const created = createExam({ moduleId, blueprint: { questionCount: 6 }, random: seeded(8) });

  const result = submitExam(created.id, []);

  // In a real paper an unanswered question scores zero. Leaving it out of the
  // denominator would turn a paper you did not finish into a perfect score.
  assert.equal(result!.marked, 6);
  assert.equal(result!.correct, 0);
  assert.equal(result!.unanswered, 6);
  assert.equal(result!.score, 0);
});

test('submitting an exam schedules every concept it tested', async () => {
  const { moduleId, conceptId } = await makeBank('Scheduling', { mcq: 4, written: 0, paper: 0 });
  const created = createExam({ moduleId, blueprint: { questionCount: 4 }, random: seeded(9) });

  const before = getDb()
    .select()
    .from(schema.conceptSchedule)
    .where(eq(schema.conceptSchedule.conceptId, conceptId))
    .all();
  assert.equal(before.length, 0);

  submitExam(
    created.id,
    created.questions.map((question) => ({
      questionId: question.id,
      optionIndex: 0,
      confidence: 4,
    })),
  );

  // A question answered under time pressure is at least as good evidence as
  // one answered at leisure, so an exam feeds the schedule exactly as practice
  // does.
  const after = getDb()
    .select()
    .from(schema.conceptSchedule)
    .where(eq(schema.conceptSchedule.conceptId, conceptId))
    .get();
  assert.ok(after, 'the exam did not reach the scheduler');
  assert.ok(after!.reps > 0);
});

test('a paper cannot be submitted twice', async () => {
  const { moduleId } = await makeBank('Double submit', { mcq: 3, written: 0, paper: 0 });
  const created = createExam({ moduleId, blueprint: { questionCount: 3 }, random: seeded(10) });

  const first = await app.inject({
    method: 'POST',
    url: `/api/exams/${created.id}/submit`,
    payload: { answers: [] },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'POST',
    url: `/api/exams/${created.id}/submit`,
    payload: { answers: [] },
  });
  // Re-marking would double-count every question against the schedule.
  assert.equal(second.statusCode, 409);
});

test('confident and wrong is picked up in an exam as it is in practice', async () => {
  const { moduleId } = await makeBank('Sure and wrong', { mcq: 4, written: 0, paper: 0 });
  const created = createExam({ moduleId, blueprint: { questionCount: 4 }, random: seeded(11) });

  const db = getDb();
  const answers = created.questions.map((question) => {
    const stored = db
      .select()
      .from(schema.questions)
      .where(eq(schema.questions.id, question.id))
      .get()!;
    const wrongIndex = (stored.optionsJson ?? []).findIndex((option) => !option.correct);
    return { questionId: question.id, optionIndex: wrongIndex, confidence: 5 };
  });

  const result = submitExam(created.id, answers)!;
  assert.equal(result.confidentlyWrong, 4);
  assert.equal(result.correct, 0);
});

test('the exam list shows scores and what is still unfinished', async () => {
  const { moduleId } = await makeBank('Listing', { mcq: 4, written: 0, paper: 0 });
  const finished = createExam({ moduleId, blueprint: { questionCount: 3 }, random: seeded(12) });
  createExam({ moduleId, blueprint: { questionCount: 3 }, random: seeded(13) });

  submitExam(finished.id, []);

  const list = json<{
    exams: Array<{ id: string; score: number | null; submittedAt: number | null }>;
  }>(await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/exams` }));

  assert.equal(list.exams.length, 2);
  assert.equal(list.exams.find((exam) => exam.id === finished.id)?.score, 0);
  assert.ok(list.exams.some((exam) => exam.submittedAt === null), 'an unfinished paper is listed');
});
