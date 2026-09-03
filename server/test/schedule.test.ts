/**
 * Spaced repetition at concept level — §8.
 *
 * The tests that earn their place here are the ones about time. A scheduler
 * looks correct after one review and is only wrong three reviews later, so
 * every meaningful case below plays a sequence of answers against a clock it
 * controls: get it right twice and the interval must grow, get it wrong after
 * that and it must collapse. A single-review assertion would pass against a
 * scheduler that did nothing at all.
 *
 * The other thing checked deliberately is what FSRS cannot say. Every wrong
 * answer is Again whether you guessed or would have bet on it, so the
 * confident-and-wrong count is kept beside the schedule rather than folded
 * into it — and the test asserts the two wrong answers really do schedule
 * identically, because that is the fact the separate count exists to work
 * around.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-schedule-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { newId } = await import('../src/lib/ids.js');
const {
  dueConcepts,
  gradeFor,
  masteryFromStability,
  misconceptions,
  moduleMastery,
  recordReview,
  revisionSummary,
  Rating,
} = await import('../src/services/schedule.js');

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
const DAY = 86_400_000;

/** A module with a parent section and two children, for the rollup tests. */
async function makeModule(title: string) {
  const db = getDb();
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title } }),
  ).id;

  const tree = json<Array<{ id: string; children: Array<{ id: string }> }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: {
        tree: [
          {
            title: 'Bioenergetics',
            children: [{ title: 'Oxidative phosphorylation' }, { title: 'Glycolysis' }],
          },
        ],
      },
    }),
  );

  const parentId = tree[0]!.id;
  const childIds = tree[0]!.children.map((child) => child.id);

  const conceptIds: Record<string, string[]> = {};
  for (const sectionId of [parentId, ...childIds]) {
    conceptIds[sectionId] = [];
    for (let index = 0; index < 3; index++) {
      const id = newId();
      db.insert(schema.concepts)
        .values({
          id,
          sectionId,
          statement: `Concept ${index} in ${sectionId}`,
          type: 'fact',
          examinableFlag: true,
        })
        .run();
      conceptIds[sectionId]!.push(id);
    }
  }

  return { moduleId, parentId, childIds, conceptIds };
}

// ---------------------------------------------------------------------------
// The grade mapping
// ---------------------------------------------------------------------------

test('confidence separates a lucky guess from something known', () => {
  assert.equal(gradeFor(true, 1), Rating.Hard, 'right while guessing is not a strong pass');
  assert.equal(gradeFor(true, 2), Rating.Hard);
  assert.equal(gradeFor(true, 3), Rating.Good);
  assert.equal(gradeFor(true, 4), Rating.Good);
  assert.equal(gradeFor(true, 5), Rating.Easy);

  // No confidence recorded is treated as the honest middle rather than as
  // anything more flattering: assuming Easy would stretch intervals on no
  // evidence at all.
  assert.equal(gradeFor(true, null), Rating.Good);

  // Every wrong answer is Again. This is the limitation the separate
  // confident-and-wrong count exists to work around.
  assert.equal(gradeFor(false, 1), Rating.Again);
  assert.equal(gradeFor(false, 5), Rating.Again);
});

// ---------------------------------------------------------------------------
// The schedule over time
// ---------------------------------------------------------------------------

test('repeated correct answers push the interval out', async () => {
  const { moduleId, childIds, conceptIds } = await makeModule('Growing intervals');
  const conceptId = conceptIds[childIds[0]!]![0]!;

  const intervals: number[] = [];
  let clock = new Date('2026-01-01T09:00:00Z');

  for (let review = 0; review < 4; review++) {
    const [outcome] = recordReview({
      conceptIds: [conceptId],
      correct: true,
      confidence: 4,
      at: clock,
    });
    intervals.push(outcome!.intervalDays);
    // Answer it on the day it falls due, which is what the schedule assumes.
    clock = new Date(outcome!.dueDate * 1000);
  }

  // The exact numbers belong to FSRS and are not this system's to assert. What
  // is this system's business is that the sequence goes outwards: a scheduler
  // that returned the same interval every time would satisfy any single-review
  // test and be completely useless.
  for (let index = 1; index < intervals.length; index++) {
    assert.ok(
      intervals[index]! >= intervals[index - 1]!,
      `interval shrank on a correct answer: ${intervals.join(', ')}`,
    );
  }
  assert.ok(
    intervals[intervals.length - 1]! > intervals[0]!,
    `intervals never grew: ${intervals.join(', ')}`,
  );

  const stored = getDb()
    .select()
    .from(schema.conceptSchedule)
    .where(eqConcept(conceptId))
    .get()!;
  assert.equal(stored.reps, 4);
  assert.equal(stored.lapses, 0);
  assert.ok(stored.stability! > 0);
  // The card has to round-trip, or every reload silently restarts the schedule.
  assert.ok(stored.state > 0, 'state was not persisted, so this reads as a new card');
  assert.ok(stored.lastReview !== null);

  const summary = revisionSummary(moduleId, { at: clock });
  assert.ok(summary.mastery > 0);
});

test('getting it wrong after a run of correct answers collapses the interval', async () => {
  const { childIds, conceptIds } = await makeModule('Lapse');
  const conceptId = conceptIds[childIds[0]!]![0]!;

  let clock = new Date('2026-01-01T09:00:00Z');
  let last = 0;
  for (let review = 0; review < 3; review++) {
    const [outcome] = recordReview({
      conceptIds: [conceptId],
      correct: true,
      confidence: 5,
      at: clock,
    });
    last = outcome!.intervalDays;
    clock = new Date(outcome!.dueDate * 1000);
  }
  assert.ok(last > 1, `never got past a day: ${last}`);

  const [lapse] = recordReview({
    conceptIds: [conceptId],
    correct: false,
    confidence: 2,
    at: clock,
  });

  assert.equal(lapse!.lapsed, true);
  assert.ok(
    lapse!.intervalDays < last,
    `a wrong answer left the interval at ${lapse!.intervalDays} days, was ${last}`,
  );

  const stored = getDb()
    .select()
    .from(schema.conceptSchedule)
    .where(eqConcept(conceptId))
    .get()!;
  assert.equal(stored.lapses, 1);
});

test('a wrong answer schedules the same whether you were sure or guessing', async () => {
  const { childIds, conceptIds } = await makeModule('Confidence and wrongness');
  const [guessed, certain] = [conceptIds[childIds[0]!]![0]!, conceptIds[childIds[0]!]![1]!];
  const at = new Date('2026-03-01T09:00:00Z');

  const [afterGuess] = recordReview({ conceptIds: [guessed], correct: false, confidence: 1, at });
  const [afterCertain] = recordReview({ conceptIds: [certain], correct: false, confidence: 5, at });

  // This is the point. FSRS has one grade for both, so the schedule cannot
  // tell them apart — which is exactly why the count below is kept separately
  // rather than being folded into stability by hand.
  assert.equal(afterGuess!.grade, afterCertain!.grade);
  assert.equal(afterGuess!.dueDate, afterCertain!.dueDate);

  assert.equal(afterGuess!.confidentlyWrong, false);
  assert.equal(afterCertain!.confidentlyWrong, true);

  const db = getDb();
  assert.equal(db.select().from(schema.conceptSchedule).where(eqConcept(guessed)).get()!.confidentlyWrong, 0);
  assert.equal(db.select().from(schema.conceptSchedule).where(eqConcept(certain)).get()!.confidentlyWrong, 1);
});

test('a bridge question grades both concepts it tested', async () => {
  const { childIds, conceptIds } = await makeModule('Bridge');
  const first = conceptIds[childIds[0]!]![0]!;
  const second = conceptIds[childIds[1]!]![0]!;
  const at = new Date('2026-02-01T09:00:00Z');

  const outcomes = recordReview({ conceptIds: [first, second], correct: true, confidence: 4, at });

  // Applied to both, because a wrong bridge answer does not say which of the
  // two failed and picking one would invent evidence.
  assert.equal(outcomes.length, 2);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.conceptId).sort(),
    [first, second].sort(),
  );
});

test('a concept deleted since the question was written does not break the attempt', async () => {
  const { childIds, conceptIds } = await makeModule('Deleted concept');
  const alive = conceptIds[childIds[0]!]![0]!;
  const gone = 'a-concept-that-never-existed';

  const outcomes = recordReview({
    conceptIds: [gone, alive],
    correct: true,
    confidence: 3,
    at: new Date('2026-02-01T09:00:00Z'),
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.conceptId, alive);
});

// ---------------------------------------------------------------------------
// What is due
// ---------------------------------------------------------------------------

test('an untested concept is due, and an overdue one comes before it', async () => {
  const { moduleId, childIds, conceptIds } = await makeModule('Due order');
  const reviewed = conceptIds[childIds[0]!]![0]!;
  const start = new Date('2026-01-01T09:00:00Z');

  const [outcome] = recordReview({
    conceptIds: [reviewed],
    correct: true,
    confidence: 4,
    at: start,
  });

  // Everything except the reviewed one has never been tested, and never tested
  // is not the same as known — so it is due.
  const beforeDue = dueConcepts(moduleId, { at: start });
  assert.equal(beforeDue.length, 8, 'nine concepts, one just reviewed');
  assert.ok(beforeDue.every((concept) => concept.isNew));

  // Well past when it fell due.
  const later = new Date(outcome!.dueDate * 1000 + 30 * DAY);
  const afterDue = dueConcepts(moduleId, { at: later });
  assert.equal(afterDue.length, 9);
  assert.equal(afterDue[0]!.conceptId, reviewed, 'overdue material must come before new material');
  assert.equal(afterDue[0]!.isNew, false);
});

test('mastery rolls up the section tree and counts untested concepts as zero', async () => {
  const { moduleId, parentId, childIds, conceptIds } = await makeModule('Rollup');
  const at = new Date('2026-01-01T09:00:00Z');

  // Every concept in the first child, and nothing anywhere else.
  for (const conceptId of conceptIds[childIds[0]!]!) {
    recordReview({ conceptIds: [conceptId], correct: true, confidence: 5, at });
  }

  const sections = moduleMastery(moduleId, { at });
  const child = sections.find((section) => section.sectionId === childIds[0]!)!;
  const sibling = sections.find((section) => section.sectionId === childIds[1]!)!;
  const parent = sections.find((section) => section.sectionId === parentId)!;

  assert.equal(child.reviewed, 3);
  assert.ok(child.mastery > 0);
  assert.equal(sibling.reviewed, 0);
  assert.equal(sibling.mastery, 0);

  // The parent owns three concepts of its own, none reviewed. Its own number
  // must stay at zero while the subtree number reflects what is beneath it.
  assert.equal(parent.concepts, 3);
  assert.equal(parent.mastery, 0);
  assert.equal(parent.subtree.concepts, 9);
  assert.equal(parent.subtree.reviewed, 3);
  assert.ok(parent.subtree.mastery > 0);

  // The rollup must average over everything, not only over what was tested.
  // Otherwise a section reads as fully mastered on the strength of three of
  // its nine concepts, which is the most misleading number this could print.
  assert.ok(
    parent.subtree.mastery < child.mastery,
    `rollup ${parent.subtree.mastery} should be diluted below the tested child's ${child.mastery}`,
  );
});

test('mastery saturates rather than growing without limit', () => {
  assert.equal(masteryFromStability(null), 0);
  assert.equal(masteryFromStability(0), 0);

  const week = masteryFromStability(7);
  const month = masteryFromStability(30);
  const year = masteryFromStability(365);

  assert.ok(week < month && month < year);
  assert.ok(year < 1, 'nothing is ever fully mastered');

  // The curve has to bend where the revision decisions are, and the honest way
  // to state that is per day rather than per span: comparing the total gain
  // from a week to a month against the gain from a month to a year compares
  // twenty-three days with three hundred and thirty-five, which says nothing.
  const earlyPerDay = (masteryFromStability(7) - masteryFromStability(1)) / 6;
  const latePerDay = (masteryFromStability(365) - masteryFromStability(180)) / 185;
  assert.ok(
    earlyPerDay > latePerDay * 10,
    `each early day should be worth far more: ${earlyPerDay} vs ${latePerDay}`,
  );
});

test('misconceptions are listed separately from what is due', async () => {
  const { moduleId, childIds, conceptIds } = await makeModule('Misconceptions');
  const believed = conceptIds[childIds[0]!]![0]!;
  const guessed = conceptIds[childIds[0]!]![1]!;
  let clock = new Date('2026-01-01T09:00:00Z');

  for (let round = 0; round < 2; round++) {
    recordReview({ conceptIds: [believed], correct: false, confidence: 5, at: clock });
    recordReview({ conceptIds: [guessed], correct: false, confidence: 1, at: clock });
    clock = new Date(clock.getTime() + DAY);
  }

  const listed = misconceptions(moduleId);
  assert.equal(listed.length, 1, 'only the one answered wrongly while certain');
  assert.equal(listed[0]!.conceptId, believed);
  assert.equal(listed[0]!.confidentlyWrong, 2);
  assert.ok(listed[0]!.sectionPath.length > 0);
});

// ---------------------------------------------------------------------------
// Through the routes
// ---------------------------------------------------------------------------

test('answering a question schedules every concept it tested', async () => {
  const { moduleId, childIds, conceptIds } = await makeModule('Through the API');
  const tested = [conceptIds[childIds[0]!]![0]!, conceptIds[childIds[1]!]![0]!];

  const questionId = newId();
  getDb()
    .insert(schema.questions)
    .values({
      id: questionId,
      moduleId,
      format: 'mcq',
      stem: 'A bridge question across two sections.',
      conceptIds: tested,
      sectionIds: childIds,
      optionsJson: [
        { text: 'right', correct: true },
        { text: 'wrong', correct: false },
      ],
      workedAnswer: 'Because of the mechanism.',
      source: 'generated',
    })
    .run();

  const attempt = json<{ scheduled: Array<{ conceptId: string; intervalDays: number }> }>(
    await app.inject({
      method: 'POST',
      url: `/api/questions/${questionId}/attempt`,
      payload: { optionIndex: 0, confidence: 4 },
    }),
  );

  assert.equal(attempt.scheduled.length, 2);
  assert.ok(attempt.scheduled.every((entry) => entry.intervalDays > 0));

  const revision = json<{ reviewed: number; due: number; concepts: number }>(
    await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/revision` }),
  );
  assert.equal(revision.concepts, 9);
  assert.equal(revision.reviewed, 2);
  assert.equal(revision.due, 7, 'the seven never tested are due; the two just answered are not');
});

test('an unmarked written answer schedules nothing until it is marked', async () => {
  const { moduleId, childIds, conceptIds } = await makeModule('Written and unmarked');
  const tested = [conceptIds[childIds[0]!]![0]!];

  const questionId = newId();
  getDb()
    .insert(schema.questions)
    .values({
      id: questionId,
      moduleId,
      format: 'saq',
      stem: 'Explain the mechanism.',
      conceptIds: tested,
      sectionIds: [childIds[0]!],
      workedAnswer: 'The gradient rises.',
      source: 'generated',
    })
    .run();

  const attempt = json<{ attemptId: string; scheduled: unknown[] }>(
    await app.inject({
      method: 'POST',
      url: `/api/questions/${questionId}/attempt`,
      payload: { text: 'Something plausible', confidence: 4 },
    }),
  );

  // Nothing is known yet, and scheduling on a guess would put invented data
  // into the one part of the system that is meant to be measured.
  assert.equal(attempt.scheduled.length, 0);
  assert.equal(
    getDb().select().from(schema.conceptSchedule).where(eqConcept(tested[0]!)).all().length,
    0,
  );

  const marked = json<{ scheduled: Array<{ conceptId: string }> }>(
    await app.inject({
      method: 'POST',
      url: `/api/attempts/${attempt.attemptId}/mark`,
      payload: { correct: true },
    }),
  );
  assert.equal(marked.scheduled.length, 1);
  assert.equal(
    getDb().select().from(schema.conceptSchedule).where(eqConcept(tested[0]!)).all().length,
    1,
  );
});

test('practice serves questions on due concepts first', async () => {
  const { moduleId, childIds, conceptIds } = await makeModule('Due first');
  const db = getDb();

  // Two questions. The first tests a concept that has just been answered and
  // is therefore not due; the second tests one that has never been seen.
  const answered = conceptIds[childIds[0]!]![0]!;
  const untouched = conceptIds[childIds[1]!]![0]!;
  recordReview({ conceptIds: [answered], correct: true, confidence: 5 });

  for (const [index, conceptId] of [answered, untouched].entries()) {
    db.insert(schema.questions)
      .values({
        id: newId(),
        moduleId,
        format: 'mcq',
        stem: `Question ${index} about ${conceptId}`,
        conceptIds: [conceptId],
        sectionIds: [childIds[index]!],
        optionsJson: [
          { text: 'right', correct: true },
          { text: 'wrong', correct: false },
        ],
        source: 'generated',
      })
      .run();
  }

  const practice = json<{ questions: Array<{ stem: string }> }>(
    await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/practice?count=2` }),
  );

  // This ordering is what makes it spaced repetition rather than a shuffle.
  assert.equal(practice.questions.length, 2);
  assert.ok(
    practice.questions[0]!.stem.includes(untouched),
    'the question on the due concept must come first',
  );
});

/** Reads better than repeating the column path at every call site. */
function eqConcept(conceptId: string) {
  return eq(schema.conceptSchedule.conceptId, conceptId);
}
