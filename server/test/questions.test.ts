/**
 * The question engine — blueprint sampling, the novelty gate, the examiner and
 * answer-key balancing.
 *
 * These tests are unusually load-bearing, because almost nothing in the engine
 * can be checked by looking at one output. A single generated question always
 * looks fine; the failures this design exists to prevent are properties of the
 * whole set — that fifty questions are fifty different questions, that the
 * answer is not C two thirds of the time, that a blueprint which keeps
 * producing duplicates gives up rather than burning tokens. Every one of those
 * is only visible across a batch, so every test here works on a batch.
 *
 * What they cannot check is quality. The stub returns whatever this file tells
 * it to, so "the examiner rejected it" here means the plumbing routed a low
 * score to a rejection — not that a real examiner would have caught anything.
 * That question needs a key and real material, and `npm run spike` is where it
 * gets asked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-questions-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';
process.env.LLM_MODEL_QUESTIONS = 'claude-sonnet-5';
process.env.LLM_MODEL_EXAMINER = 'claude-haiku-4-5';
process.env.LLM_MONTHLY_CAP_GBP = '1000';
process.env.QUESTION_STRIKES = '3';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { setStub, resetStub, stubCalls } = await import('../src/llm/providers/stub.js');
const { newId } = await import('../src/lib/ids.js');
const {
  blueprintSignature,
  conceptWeight,
  ensureScenarioSeeds,
  sampleBlueprint,
} = await import('../src/services/questions/blueprint.js');
const { checkNovelty, trigramOverlap } = await import('../src/services/questions/novelty.js');
const { balanceAnswerKeys, keyDistribution, longestRun } = await import(
  '../src/services/questions/balance.js'
);
const { generateQuestions } = await import('../src/services/questions/generate.js');

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

beforeEach(() => resetStub());

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

/** A deterministic sequence, so a sampling test means the same thing twice. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const STATEMENTS = [
  'Oligomycin blocks the Fo channel of ATP synthase, preventing proton flow back into the matrix.',
  'Blocking ATP synthase raises the proton motive force until electron transport stalls against it.',
  'Uncouplers dissipate the proton gradient, so oxygen consumption rises while ATP synthesis falls.',
  'Rotenone inhibits complex I, so NADH-linked substrates no longer support respiration.',
  'Succinate donates electrons at complex II, bypassing a rotenone block.',
  'The P/O ratio for succinate is lower than for NADH because fewer protons are pumped.',
];

async function makeModule(title: string) {
  const db = getDb();
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title } }),
  ).id;

  const tree = json<Array<{ id: string; children?: Array<{ id: string }> }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: { tree: [{ title: 'Oxidative phosphorylation' }, { title: 'Electron transport' }] },
    }),
  );
  const sectionIds = tree.map((node) => node.id);

  const sourceId = newId();
  db.insert(schema.sources)
    .values({
      id: sourceId,
      moduleId,
      type: 'slides',
      title: 'Lecture 4',
      filename: 'l04.pdf',
      path: 'media/sources/l04.pdf',
      status: 'ingested',
    })
    .run();

  const conceptIds: string[] = [];
  for (const [index, sectionId] of sectionIds.entries()) {
    const chunkId = newId();
    const mine = STATEMENTS.slice(index * 3, index * 3 + 3);
    db.insert(schema.chunks)
      .values({ id: chunkId, sourceId, text: mine.join(' '), slideNo: index + 1, position: index })
      .run();
    db.insert(schema.sourceSections)
      .values({
        sourceId,
        sectionId,
        chunkRange: { chunkIds: [chunkId] },
        score: 0.9,
        confirmed: true,
      })
      .run();

    for (const statement of mine) {
      const id = newId();
      db.insert(schema.concepts)
        .values({
          id,
          sectionId,
          statement,
          type: 'mechanism',
          examinableFlag: true,
          emphasisScore: 0.7,
          sourceChunkIds: [chunkId],
        })
        .run();
      conceptIds.push(id);
    }
  }

  return { moduleId, sectionIds, conceptIds };
}

/**
 * Genuinely different stems, for the tests that need generation to succeed.
 *
 * They have to be written out by hand. The first attempt at these tests used
 * `Question ${index}` and every one after the first was rejected — correctly,
 * because under a bag-of-words embedder two stems differing by a digit are the
 * same stem, and they read that way to a person too. There is no shortcut here
 * that the gate will not see through, which is a small piece of evidence that
 * the gate does something.
 */
const DISTINCT_STEMS = [
  'Isolated mitochondria respiring on succinate are given oligomycin. Predict the change in oxygen uptake and justify it.',
  'A patient on a beta blocker cannot raise cardiac output during exercise. Which step of the pathway is limiting?',
  'Two Lineweaver-Burk lines intersect on the y-axis. What does that reveal about where the inhibitor binds?',
  'During prolonged starvation, hepatocytes export ketone bodies. Why can erythrocytes not use them?',
  'An uncoupling agent raises oxygen consumption while ATP falls. Where has the energy gone?',
  'Rotenone is added, then succinate. Respiration recovers. Explain the entry point that makes this possible.',
  'A neonate six hours after birth becomes hypoglycaemic. Which store has been exhausted, and in what order?',
  'The P/O ratio measured for a substrate is 1.5 rather than 2.5. What does that imply about proton pumping?',
  'A gene knockout removes the adenine nucleotide translocase. What accumulates, and on which side of the membrane?',
  'In diabetic ketoacidosis, why does the ratio of NADH to NAD+ in the liver shift the way it does?',
];

/** A well-formed MCQ, with the answer always first so balancing has work to do. */
function mcq(stem: string): string {
  return JSON.stringify({
    stem,
    options: [
      { text: 'Oxygen consumption falls', correct: true },
      { text: 'Oxygen consumption rises', correct: false, whyWrong: 'that is an uncoupler' },
      { text: 'No change', correct: false, whyWrong: 'the gradient is not maintained for free' },
      { text: 'The gradient collapses', correct: false, whyWrong: 'it does the opposite' },
    ],
    workedAnswer: 'Blocking Fo raises the pmf until the chain cannot pump against it.',
    difficulty: 3,
  });
}

const GOOD_EXAMINER = JSON.stringify({
  answerability: 5,
  singleAnswer: 5,
  distractorQuality: 4,
  noGiveaways: 4,
  bloomFidelity: 4,
  fairness: 5,
  verdict: 'Fine as it stands.',
});

// ---------------------------------------------------------------------------
// Blueprint sampling (§7.1)
// ---------------------------------------------------------------------------

test('sampling produces varied blueprints rather than one shape repeated', async () => {
  const { moduleId } = await makeModule('Sampling variety');
  const random = seeded(42);

  const blueprints = Array.from({ length: 60 }, () => sampleBlueprint({ moduleId, random })!);
  assert.equal(blueprints.filter(Boolean).length, 60);

  const archetypes = new Set(blueprints.map((sample) => sample.blueprint.archetype));
  const formats = new Set(blueprints.map((sample) => sample.blueprint.format));
  const blooms = new Set(blueprints.map((sample) => sample.blueprint.bloom));

  // The point of sampling in code is structural variety. If this ever collapses
  // to two or three archetypes, the engine is back to asking a model for ten
  // questions and hoping.
  assert.ok(archetypes.size >= 6, `only ${archetypes.size} archetypes across 60 samples`);
  assert.ok(formats.size >= 3, `only ${formats.size} formats`);
  assert.ok(blooms.size >= 4, `only ${blooms.size} Bloom levels`);

  // §7.2 asks for roughly 40% bridges. Sampling is random, so this is a band.
  const bridges = blueprints.filter((sample) => sample.blueprint.sectionIds.length > 1).length;
  assert.ok(bridges >= 12 && bridges <= 40, `${bridges}/60 bridged two sections`);
});

test('sampling is reproducible from a seed', async () => {
  const { moduleId } = await makeModule('Reproducible sampling');
  const first = Array.from({ length: 10 }, () =>
    blueprintSignature(sampleBlueprint({ moduleId, random: seeded(7) })!.blueprint),
  );
  const second = Array.from({ length: 10 }, () =>
    blueprintSignature(sampleBlueprint({ moduleId, random: seeded(7) })!.blueprint),
  );
  assert.deepEqual(first, second);
});

test('a concept never answered outranks one always answered correctly', () => {
  const base = {
    id: 'c',
    sectionId: 's',
    statement: '',
    emphasis: 0.5,
    examinable: true,
    ageDays: 10,
  };
  // 0.5 is "unknown", not "known". Treating an untested concept as mastered
  // would starve new material of questions, which is the opposite of the point.
  assert.ok(conceptWeight({ ...base, weakness: 0.5 }) > conceptWeight({ ...base, weakness: 0 }));
  assert.ok(conceptWeight({ ...base, weakness: 1 }) > conceptWeight({ ...base, weakness: 0.5 }));
});

test('scenario seeds are created once and not duplicated', () => {
  const first = ensureScenarioSeeds();
  const second = ensureScenarioSeeds();
  assert.equal(first, second);
  assert.ok(first > 20);
});

// ---------------------------------------------------------------------------
// The novelty gate (§7.3)
// ---------------------------------------------------------------------------

test('the gate rejects a near-verbatim stem and admits a different one', () => {
  const original = 'Oligomycin is added to isolated mitochondria respiring on succinate. What happens to oxygen consumption?';
  const bank = [{ id: 'q1', stem: original, embedding: null, source: 'generated' as const }];

  const copy = checkNovelty({
    stem: 'Oligomycin is added to isolated mitochondria respiring on succinate. What happens to the proton motive force?',
    embedding: null,
    signature: 'sig-2',
    existing: bank,
    usedSignatures: new Set(),
  });
  assert.equal(copy.accepted, false);
  assert.equal(copy.reason, 'too_similar_by_wording');

  const different = checkNovelty({
    stem: 'A Lineweaver-Burk plot shows two lines meeting on the y-axis. Which parameter is unchanged?',
    embedding: null,
    signature: 'sig-3',
    existing: bank,
    usedSignatures: new Set(),
  });
  assert.equal(different.accepted, true);
});

test('a verdict reached without embeddings says so', () => {
  const bank = [{ id: 'q1', stem: 'Why does oligomycin stall the chain?', embedding: null, source: 'generated' as const }];
  const verdict = checkNovelty({
    stem: 'Explain the effect of an uncoupler on the P/O ratio.',
    embedding: null,
    signature: 'sig',
    existing: bank,
    usedSignatures: new Set(),
  });

  // The spike measured what trigrams actually catch: copy-paste, and very
  // little else. So an acceptance reached on wording alone is a much weaker
  // statement than one backed by an embedding, and the caller has to be able
  // to tell the two apart — otherwise a broken embedder silently turns the
  // gate off while every run still reports success.
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.embeddingsUsed, false);

  const first = checkNovelty({
    stem: 'Anything at all',
    embedding: null,
    signature: 'sig',
    existing: [],
    usedSignatures: new Set(),
  });
  // Nothing to compare against means nothing was missed.
  assert.equal(first.embeddingsUsed, true);
});

test('a blueprint tuple already used is rejected before anything else', () => {
  const verdict = checkNovelty({
    stem: 'A completely novel question about something else entirely',
    embedding: null,
    signature: 'used',
    existing: [],
    usedSignatures: new Set(['used']),
  });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'blueprint_already_used');
});

test('reproducing a past paper is rejected at a lower bar than a generated duplicate', () => {
  const paper =
    'Describe the effect of oligomycin on mitochondrial oxygen consumption and explain the mechanism involved.';
  const near =
    'Describe the effect of oligomycin on oxygen uptake in isolated liver mitochondria, and account for it.';

  // Between the two bars on purpose: this would survive against another
  // generated question, and is caught only because the other side is a real
  // exam question. Reproducing one of those is the worst outcome the engine
  // has — it teaches the paper instead of the concept, and it looks like a
  // success while doing it.
  const overlap = trigramOverlap(paper, near);
  assert.ok(overlap >= 0.3 && overlap < 0.4, `overlap of ${overlap.toFixed(2)} is not in the gap`);

  const verdict = checkNovelty({
    stem: near,
    embedding: null,
    signature: 'sig',
    existing: [{ id: 'p1', stem: paper, embedding: null, source: 'past_paper' }],
    usedSignatures: new Set(),
  });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'reproduces_a_past_paper');
});

// ---------------------------------------------------------------------------
// Answer-key balancing (§7.5)
// ---------------------------------------------------------------------------

test('answer keys are spread across positions and never run more than twice', () => {
  // Every question starts with the answer first, which is what a generator
  // left to itself produces and what makes a bank scoreable without knowing
  // anything.
  const questions = Array.from({ length: 40 }, (_, index) => ({
    id: `q${index}`,
    options: [
      { text: 'right', correct: true },
      { text: 'wrong 1', correct: false },
      { text: 'wrong 2', correct: false },
      { text: 'wrong 3', correct: false },
    ],
  }));

  balanceAnswerKeys(questions, seeded(99));

  const distribution = keyDistribution(questions);
  assert.equal(
    distribution.reduce((sum, count) => sum + count, 0),
    40,
  );
  for (const count of distribution) {
    assert.ok(count >= 8 && count <= 12, `uneven distribution: ${distribution.join(', ')}`);
  }
  assert.ok(longestRun(questions) <= 2, `a run of ${longestRun(questions)} same-letter answers`);

  // Balancing must move the answer, not lose it or duplicate it.
  for (const question of questions) {
    assert.equal(question.options.filter((option) => option.correct).length, 1);
    assert.equal(question.options.length, 4);
  }
});

test('balancing copes with a set too small to divide evenly', () => {
  const questions = Array.from({ length: 3 }, (_, index) => ({
    id: `q${index}`,
    options: [
      { text: 'right', correct: true },
      { text: 'wrong', correct: false },
      { text: 'also wrong', correct: false },
      { text: 'wrong too', correct: false },
    ],
  }));
  balanceAnswerKeys(questions, seeded(3));
  assert.ok(longestRun(questions) <= 2);
  for (const question of questions) {
    assert.equal(question.options.filter((option) => option.correct).length, 1);
  }
});

// ---------------------------------------------------------------------------
// Generation end to end (§7.2, §7.4)
// ---------------------------------------------------------------------------

test('generation stores questions with their blueprint, concepts and citations', async () => {
  const { moduleId, conceptIds } = await makeModule('Generation');
  let index = 0;
  setStub({
    respond: (request) =>
      request.system?.startsWith('You are a second examiner')
        ? GOOD_EXAMINER
        : mcq(DISTINCT_STEMS[index++ % DISTINCT_STEMS.length]!),
  });

  const result = await generateQuestions({ moduleId, count: 5, random: seeded(11) });
  assert.equal(result.accepted, 5);
  assert.equal(result.questionIds.length, 5);

  const stored = getDb()
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all();
  assert.equal(stored.length, 5);

  for (const question of stored) {
    assert.ok(question.stem.length > 0);
    assert.ok(question.blueprintJson, 'the blueprint must be stored, or a bad run is undiagnosable');
    assert.ok(question.conceptIds?.length, 'every question is tied to the concepts it tests');
    for (const conceptId of question.conceptIds ?? []) {
      assert.ok(conceptIds.includes(conceptId));
    }
    assert.equal(question.source, 'generated');
    assert.ok(question.criticScore && question.criticScore >= 4);
  }
});

test('the examiner floor rejects a weak question and the blueprint is retried', async () => {
  const { moduleId } = await makeModule('Examiner floor');
  let questionCalls = 0;
  let examinerCalls = 0;

  setStub({
    respond: (request) => {
      if (request.system?.startsWith('You are a second examiner')) {
        examinerCalls += 1;
        // Below the floor of 4: answerable, but two options are defensible and
        // the stem gives the answer away.
        return JSON.stringify({
          answerability: 4,
          singleAnswer: 2,
          distractorQuality: 2,
          noGiveaways: 2,
          bloomFidelity: 3,
          fairness: 3,
          verdict: 'Two options are defensible and the stem signals the key.',
        });
      }
      questionCalls += 1;
      return mcq(`Unique stem ${questionCalls} on an unrelated mechanism`);
    },
  });

  const result = await generateQuestions({ moduleId, count: 2, random: seeded(5) });

  assert.equal(result.accepted, 0, 'nothing below the floor may reach the bank');
  assert.ok(result.rejected.length > 0);
  assert.ok(result.rejected.every((rejection) => rejection.reason === 'examiner'));
  assert.ok(result.rejected[0]!.detail?.includes('defensible'));
  assert.equal(examinerCalls, questionCalls, 'every generated question was examined');

  // Three strikes per blueprint, then resample. Without that cap a blueprint
  // the model cannot satisfy loops until the token ceiling stops it.
  assert.ok(result.blueprintsResampled > 0);
  assert.equal(
    getDb().select().from(schema.questions).where(eq(schema.questions.moduleId, moduleId)).all()
      .length,
    0,
  );
});

test('three strikes on one blueprint resamples rather than looping', async () => {
  const { moduleId } = await makeModule('Three strikes');
  // The same stem every time, so every attempt after the first is a duplicate.
  setStub({
    respond: (request) =>
      request.system?.startsWith('You are a second examiner')
        ? GOOD_EXAMINER
        : mcq('The one and only stem this model will ever produce, verbatim each time'),
  });

  const result = await generateQuestions({ moduleId, count: 6, random: seeded(21) });

  // One gets in — it is novel when the bank is empty — and every later attempt
  // is caught. The value of this test is that it terminates at all.
  assert.equal(result.accepted, 1);
  // Either duplicate reason is a pass: which of the two checks fires first on
  // an identical stem depends on the embedder, and pinning it would make this
  // test about the hash provider rather than about termination.
  assert.ok(
    result.rejected.some(
      (rejection) =>
        rejection.reason === 'too_similar_by_wording' ||
        rejection.reason === 'too_similar_by_meaning',
    ),
    `reasons seen: ${[...new Set(result.rejected.map((r) => r.reason))].join(', ')}`,
  );
  // Giving up is the correct outcome here, and the run has to say so. Coming
  // back with one question and no explanation is indistinguishable from a
  // module that only had one question in it.
  assert.equal(result.stoppedBecause, 'ran_out_of_blueprints');
  assert.equal(result.blueprintsResampled, 6 * 8);

  // The real failure this guards against is unbounded spending, so the bound
  // is asserted directly rather than inferred from the run having finished.
  const generationCalls = stubCalls().filter(
    (call) => !call.system?.startsWith('You are a second examiner'),
  ).length;
  // count * (failed blueprints allowed each + the successful one) * strikes.
  const worstCase = 6 * (8 + 1) * 3;
  assert.ok(
    generationCalls <= worstCase,
    `${generationCalls} model calls, above the documented ceiling of ${worstCase}`,
  );
});

test('generation refuses when a module has no concepts', async () => {
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title: 'Empty' } }),
  ).id;

  await assert.rejects(
    () => generateQuestions({ moduleId, count: 3 }),
    // Questions come from the concept list, never from the notes. Saying so is
    // the difference between "extract concepts first" and a silent empty run.
    /concepts/i,
  );
});

test('a run reports questions admitted without an embedding', async () => {
  const { moduleId } = await makeModule('Weak gate');
  let index = 0;
  setStub({
    respond: (request) =>
      request.system?.startsWith('You are a second examiner')
        ? GOOD_EXAMINER
        : mcq(DISTINCT_STEMS[index++ % DISTINCT_STEMS.length]!),
  });

  const result = await generateQuestions({ moduleId, count: 4, random: seeded(77) });

  // The hash embedder returns real vectors, so this run is properly gated. The
  // assertion that matters is that the field is populated at all: it is the
  // only thing that would tell you a run on a broken embedder was not gated.
  assert.equal(typeof result.admittedWithoutEmbeddings, 'number');
  assert.ok(result.admittedWithoutEmbeddings <= result.accepted);
});

// ---------------------------------------------------------------------------
// The routes: the bank and practice
// ---------------------------------------------------------------------------

/** Generates a small bank through the job route and waits for it to finish. */
async function bankOf(moduleId: string, count: number): Promise<void> {
  let index = 0;
  setStub({
    respond: (request) =>
      request.system?.startsWith('You are a second examiner')
        ? GOOD_EXAMINER
        : mcq(DISTINCT_STEMS[index++ % DISTINCT_STEMS.length]!),
  });

  const started = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/questions/generate`,
    payload: { count },
  });
  assert.equal(started.statusCode, 200);

  for (let wait = 0; wait < 100; wait++) {
    const job = json<{ phase: string }>(
      await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/questions/job` }),
    );
    if (['done', 'failed', 'cancelled'].includes(job.phase)) {
      assert.equal(job.phase, 'done', JSON.stringify(job));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('generation job never finished');
}

test('practice serves questions without the answer in them', async () => {
  const { moduleId } = await makeModule('Practice');
  await bankOf(moduleId, 4);

  const practice = json<{
    questions: Array<{ id: string; stem: string; options: string[] }>;
  }>(await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/practice?count=4` }));

  assert.ok(practice.questions.length > 0);

  // The whole exercise is answering without seeing the answer. Sending the
  // full record and hiding the key in the client would put it one devtools
  // pane away, so the check is on the wire format rather than on the UI.
  const wire = JSON.stringify(practice);
  assert.ok(!wire.includes('correct'), 'the practice payload names correctness');
  assert.ok(!wire.includes('workedAnswer'), 'the practice payload carries the worked answer');
  assert.ok(!wire.includes('whyWrong'), 'the practice payload explains the distractors');

  for (const question of practice.questions) {
    assert.ok(question.stem.length > 0);
    for (const option of question.options) assert.equal(typeof option, 'string');
  }
});

test('an attempt is marked, counted, and returns the worked answer', async () => {
  const { moduleId } = await makeModule('Attempts');
  await bankOf(moduleId, 3);

  const stored = getDb()
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all();
  const question = stored[0]!;
  const correctIndex = (question.optionsJson ?? []).findIndex((option) => option.correct);
  const wrongIndex = (question.optionsJson ?? []).findIndex((option) => !option.correct);

  const wrong = json<{ correct: boolean; confidentlyWrong: boolean; workedAnswer: string }>(
    await app.inject({
      method: 'POST',
      url: `/api/questions/${question.id}/attempt`,
      payload: { optionIndex: wrongIndex, confidence: 5, secondsTaken: 12 },
    }),
  );
  assert.equal(wrong.correct, false);
  // Wrong while sure of it. This is the signal the scheduler exists to act on,
  // so it is surfaced at the moment it happens rather than only in a rollup.
  assert.equal(wrong.confidentlyWrong, true);
  assert.ok(wrong.workedAnswer.length > 0, 'the worked answer arrives after the attempt');

  const right = json<{ correct: boolean; confidentlyWrong: boolean }>(
    await app.inject({
      method: 'POST',
      url: `/api/questions/${question.id}/attempt`,
      payload: { optionIndex: correctIndex, confidence: 2 },
    }),
  );
  assert.equal(right.correct, true);
  assert.equal(right.confidentlyWrong, false);

  const after = getDb()
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.id, question.id))
    .get()!;
  assert.equal(after.timesServed, 2);
  assert.equal(after.timesCorrect, 1);
});

test('a written answer is recorded unmarked rather than guessed at', async () => {
  const { moduleId, sectionIds } = await makeModule('Written');
  const db = getDb();
  const id = newId();
  db.insert(schema.questions)
    .values({
      id,
      moduleId,
      format: 'saq',
      stem: 'Explain why blocking ATP synthase stalls electron transport.',
      sectionIds: [sectionIds[0]!],
      workedAnswer: 'The proton motive force rises until the chain cannot pump against it.',
      source: 'generated',
    })
    .run();

  const attempt = json<{ attemptId: string; correct: null; marked: boolean }>(
    await app.inject({
      method: 'POST',
      url: `/api/questions/${id}/attempt`,
      payload: { text: 'The gradient builds up', confidence: 3 },
    }),
  );
  // Marking free text needs a model. Guessing here would put invented data
  // into the scheduler, which is worse than leaving it unmarked.
  assert.equal(attempt.correct, null);
  assert.equal(attempt.marked, false);

  const marked = await app.inject({
    method: 'POST',
    url: `/api/attempts/${attempt.attemptId}/mark`,
    payload: { correct: true },
  });
  assert.equal(marked.statusCode, 200);

  const again = await app.inject({
    method: 'POST',
    url: `/api/attempts/${attempt.attemptId}/mark`,
    payload: { correct: false },
  });
  assert.equal(again.statusCode, 409, 'marking twice would double-count the question');
});

test('the bank reports how the answer keys fall across the set', async () => {
  const { moduleId } = await makeModule('Bank view');
  await bankOf(moduleId, 6);

  const bank = json<{
    questions: Array<{ sectionPaths: string[]; accuracy: number | null }>;
    answerKeys: { distribution: number[]; longestRun: number; counted: number };
  }>(await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/questions` }));

  assert.ok(bank.questions.length >= 1);
  assert.ok(bank.questions[0]!.sectionPaths[0]!.length > 0, 'a question says where it came from');
  assert.equal(bank.questions[0]!.accuracy, null, 'an unattempted question has no accuracy yet');

  // The set-level property no single question can show.
  assert.equal(bank.answerKeys.counted, bank.questions.filter((q) => 'accuracy' in q).length);
  assert.ok(bank.answerKeys.longestRun <= 2, `a run of ${bank.answerKeys.longestRun}`);
});

test('generating without concepts is refused with the step that is missing', async () => {
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title: 'No concepts' } }),
  ).id;

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/questions/generate`,
    payload: { count: 5 },
  });
  assert.equal(response.statusCode, 400);
  assert.match(json<{ error: string }>(response).error, /concept/i);
});

test('a second generation run is refused while one is going', async () => {
  const { moduleId } = await makeModule('Concurrent');
  let index = 0;
  setStub({
    respond: (request) =>
      request.system?.startsWith('You are a second examiner')
        ? GOOD_EXAMINER
        : mcq(DISTINCT_STEMS[index++ % DISTINCT_STEMS.length]!),
  });

  const first = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/questions/generate`,
    payload: { count: 8 },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/questions/generate`,
    payload: { count: 8 },
  });
  // Two runs at once would spend two ceilings and race each other's novelty
  // checks, so each would think the other's questions did not exist.
  assert.equal(second.statusCode, 409);

  for (let wait = 0; wait < 100; wait++) {
    const job = json<{ phase: string }>(
      await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/questions/job` }),
    );
    if (['done', 'failed', 'cancelled'].includes(job.phase)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test('the whole batch shares one spending run', async () => {
  const { moduleId } = await makeModule('One run');
  let index = 0;
  setStub({
    respond: (request) =>
      request.system?.startsWith('You are a second examiner')
        ? GOOD_EXAMINER
        : mcq(DISTINCT_STEMS[index++ % DISTINCT_STEMS.length]!),
    outputTokens: 400,
  });

  const result = await generateQuestions({ moduleId, count: 3, random: seeded(31) });
  assert.equal(result.accepted, 3);

  // The token ceiling has to apply to the batch. Per-question runs would let a
  // fifty-question job spend fifty ceilings, which is not a ceiling.
  //
  // Scoped to this module: the ledger is shared with every other test in this
  // file, and an unscoped count measures the file rather than the batch.
  const calls = getDb()
    .select()
    .from(schema.llmCalls)
    .where(eq(schema.llmCalls.moduleId, moduleId))
    .all();
  assert.ok(calls.length >= 3, 'the batch should have reached the ledger at all');
  const runIds = new Set(calls.map((call) => call.runId));
  assert.equal(runIds.size, 1, `${runIds.size} separate runs for one batch`);
});
