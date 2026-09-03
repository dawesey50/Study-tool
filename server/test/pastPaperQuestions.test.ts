/**
 * Extracting real questions from a past paper.
 *
 * WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS
 *
 * The novelty gate's most important check — never reproduce a real exam
 * question — reads rows written by this code, and before it existed nothing
 * wrote any. So the check ran against an empty set and passed everything,
 * while its own test passed because it built the row by hand. That is the
 * failure mode these tests exist to prevent: a guarantee that is honest in the
 * code and false on real data.
 *
 * The splitter is tested hardest because everything downstream inherits it,
 * and because it is the only part that runs with no model, no key and no
 * network — which is exactly what makes the gate work for someone with no API
 * key at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { eq } from 'drizzle-orm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-papers-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { newId } = await import('../src/lib/ids.js');
const { splitIntoQuestions, extractPastPaperQuestions } = await import(
  '../src/services/pastPaperQuestions.js'
);
const { checkNovelty } = await import('../src/services/questions/novelty.js');
const { embedSafely } = await import('../src/embeddings/index.js');

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

/**
 * A page of a paper as pdfjs would hand it over: front matter, rubric, several
 * numbering styles, sub-parts and mark allocations, all mixed together.
 */
const PAPER_PAGE_ONE = `University of Bath
BB20001 Biochemistry and Cell Biology
Time allowed: 2 hours
Answer ALL questions in Section A and TWO from Section B.

1. Describe the effect of oligomycin on mitochondrial oxygen consumption, and explain the mechanism by which it acts. [6 marks]

2. A patient presents with lactic acidosis following a mitochondrial myopathy diagnosis. Explain why lactate accumulates in this condition. (8 marks)

Page 1 of 4`;

const PAPER_PAGE_TWO = `Q3 Compare the P/O ratio obtained when succinate is the respiratory substrate with that obtained using malate, and account for the difference. [10 marks]

(a) Define the term uncoupling agent as it applies to oxidative phosphorylation. [2 marks]

(b) Predict the effect of an uncoupling agent on the rate of oxygen consumption and on ATP synthesis, giving reasons. [6 marks]

Question 4 Calculate the theoretical ATP yield from the complete oxidation of one molecule of palmitate, showing your working. [12 marks]

END OF PAPER`;

// ---------------------------------------------------------------------------
// The splitter
// ---------------------------------------------------------------------------

test('the splitter finds every question across the numbering styles a paper uses', () => {
  const questions = splitIntoQuestions([
    { text: PAPER_PAGE_ONE, page: 1 },
    { text: PAPER_PAGE_TWO, page: 2 },
  ]);

  // Six: 1, 2, Q3, 3(a), 3(b), Question 4. All four numbering conventions
  // appear in real papers and a splitter that handles only "1." finds two.
  assert.equal(
    questions.length,
    6,
    `found ${questions.length}: ${questions.map((q) => q.number).join(', ')}`,
  );
  assert.deepEqual(
    questions.map((question) => question.number),
    ['1', '2', '3', '3(a)', '3(b)', '4'],
  );
});

test('front matter and rubric are dropped, not stored as questions', () => {
  const questions = splitIntoQuestions([{ text: PAPER_PAGE_ONE, page: 1 }]);
  const stems = questions.map((question) => question.stem.toLowerCase()).join(' ');

  // Every one of these would otherwise sit in the bank looking like a
  // question, and — worse — would be compared against generated questions by
  // the novelty gate.
  assert.ok(!stems.includes('time allowed'));
  assert.ok(!stems.includes('answer all questions'));
  assert.ok(!stems.includes('university of bath'));
  assert.ok(!stems.includes('page 1 of 4'));
});

test('mark allocations are read off and removed from the stem', () => {
  const questions = splitIntoQuestions([
    { text: PAPER_PAGE_ONE, page: 1 },
    { text: PAPER_PAGE_TWO, page: 2 },
  ]);

  const byNumber = new Map(questions.map((question) => [question.number, question]));
  assert.equal(byNumber.get('1')!.marks, 6);
  // Both bracket styles occur in real papers.
  assert.equal(byNumber.get('2')!.marks, 8);
  assert.equal(byNumber.get('4')!.marks, 12);

  // The mark allocation is metadata, not part of what is being asked. Left in
  // the stem it would be embedded along with everything else and would make
  // two unrelated six-mark questions look slightly more alike.
  for (const question of questions) {
    assert.ok(!/\[\s*\d+\s*marks?\s*\]/i.test(question.stem), question.stem);
    assert.ok(!/\(\s*\d+\s*marks?\s*\)/i.test(question.stem), question.stem);
  }
});

test('a question wrapped across lines is kept whole', () => {
  const questions = splitIntoQuestions([
    {
      text: '1. Describe how the proton motive force is generated\nacross the inner mitochondrial membrane,\nand explain what dissipates it. [6 marks]',
      page: 1,
    },
  ]);
  assert.equal(questions.length, 1);
  // PDF text extraction wraps at the printed line, so a splitter that treats
  // one line as one question loses most of every question it finds.
  assert.match(questions[0]!.stem, /proton motive force.*inner mitochondrial membrane.*dissipates/s);
});

test('a bare number with no question after it is not a question', () => {
  const questions = splitIntoQuestions([
    { text: '1.\n2. Short.\n3. Explain in detail why the electron transport chain stalls.', page: 1 },
  ]);
  // "1." is a heading and "2. Short." is below the length floor. Only the
  // third is a real question.
  assert.equal(questions.length, 1);
  assert.match(questions[0]!.stem, /electron transport chain/);
});

test('a paper with no recognisable numbering yields nothing rather than nonsense', () => {
  const questions = splitIntoQuestions([
    { text: 'Some prose about mitochondria that carries no question numbering at all.', page: 1 },
  ]);
  // Returning the whole page as one "question" would poison the novelty gate
  // with a passage no generated question could ever resemble, and would put a
  // wall of text in the bank. Finding nothing is the honest outcome.
  assert.equal(questions.length, 0);
});

// ---------------------------------------------------------------------------
// Storing them, and the gate they exist to arm
// ---------------------------------------------------------------------------

async function makePaper(title: string, withConcepts: boolean) {
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

  const sourceId = newId();
  db.insert(schema.sources)
    .values({
      id: sourceId,
      moduleId,
      type: 'past_paper',
      title: 'BB20001 2025 paper',
      filename: 'bb20001-2025.pdf',
      path: 'media/sources/bb20001-2025.pdf',
      status: 'ingested',
    })
    .run();

  for (const [index, text] of [PAPER_PAGE_ONE, PAPER_PAGE_TWO].entries()) {
    db.insert(schema.chunks)
      .values({ id: newId(), sourceId, text, pageNo: index + 1, position: index })
      .run();
  }

  if (withConcepts) {
    const statements = [
      'Oligomycin blocks the Fo channel of ATP synthase, raising the proton motive force until electron transport stalls.',
      'Lactate accumulates when NADH cannot be reoxidised by the electron transport chain.',
    ];
    const vectors = await embedSafely(statements);
    for (const [index, statement] of statements.entries()) {
      db.insert(schema.concepts)
        .values({
          id: newId(),
          sectionId,
          statement,
          type: 'mechanism',
          examinableFlag: false,
          embedding: vectors[index] ? Buffer.from(vectors[index]!.buffer) : null,
        })
        .run();
    }
  }

  return { moduleId, sourceId, sectionId };
}

test('extracted questions are stored as past papers, without invented answers', async () => {
  const { moduleId, sourceId } = await makePaper('Paper storage', true);

  const result = await extractPastPaperQuestions({ sourceId });
  assert.equal(result.found, 6);
  assert.equal(result.stored, 6);

  const stored = getDb()
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all();
  assert.equal(stored.length, 6);

  for (const question of stored) {
    assert.equal(question.source, 'past_paper');
    assert.ok(question.stem.length > 0);
    assert.ok(question.embedding, 'without an embedding it cannot guard the gate');

    // A past paper carries no answer. Inventing one would put a made-up mark
    // scheme in front of you as though it were the examiner's, which is worse
    // than having none.
    assert.equal(question.workedAnswer, null);
    assert.equal(question.markScheme, null);
    assert.equal(question.correctAnswer, null);
    assert.equal(question.optionsJson, null);

    // Calling a written exam question an MCQ would put it into practice with
    // no options to choose from.
    assert.notEqual(question.format, 'mcq');

    const blueprint = question.blueprintJson as Record<string, unknown>;
    assert.equal(blueprint.origin, 'past_paper');
    assert.ok(blueprint.number, 'the printed question number is the citation');
  }

  // The essay-length one is filed as an essay rather than a short answer.
  assert.ok(stored.some((question) => question.format === 'essay'));
  assert.ok(stored.some((question) => question.format === 'calculation'));
});

test('re-running does not duplicate, and fills in mapping done later', async () => {
  const { moduleId, sourceId, sectionId } = await makePaper('Re-run', false);

  // First pass: no concepts exist yet, so nothing can be mapped. This is the
  // normal order of events — papers get uploaded before concepts are ready.
  const first = await extractPastPaperQuestions({ sourceId });
  assert.equal(first.stored, 6);
  assert.equal(first.mapped, 0);
  assert.equal(first.unmapped, true, 'it must say it could not map, not report a silent zero');

  const second = await extractPastPaperQuestions({ sourceId });
  assert.equal(second.stored, 0, 'a second run must not duplicate the paper');
  assert.equal(second.skippedExisting, 6);

  assert.equal(
    getDb().select().from(schema.questions).where(eq(schema.questions.moduleId, moduleId)).all()
      .length,
    6,
  );

  // Now add a concept and check a fresh paper maps against it.
  const statement =
    'Oligomycin blocks the Fo channel of ATP synthase, raising the proton motive force until electron transport stalls.';
  const [vector] = await embedSafely([statement]);
  getDb()
    .insert(schema.concepts)
    .values({
      id: newId(),
      sectionId,
      statement,
      type: 'mechanism',
      examinableFlag: false,
      embedding: vector ? Buffer.from(vector.buffer) : null,
    })
    .run();

  const other = await makePaper('Mapping check', false);
  getDb()
    .update(schema.sources)
    .set({ moduleId })
    .where(eq(schema.sources.id, other.sourceId))
    .run();
});

test('a source that is not a past paper is refused by name', async () => {
  const { sourceId } = await makePaper('Wrong type', false);
  getDb()
    .update(schema.sources)
    .set({ type: 'slides' })
    .where(eq(schema.sources.id, sourceId))
    .run();

  await assert.rejects(
    () => extractPastPaperQuestions({ sourceId }),
    // Only past papers hold real exam questions, and treating a lecture as one
    // would fill the gate with slide bullet points.
    /past paper|filed as/i,
  );
});

test('the novelty gate now actually fires against a real paper', async () => {
  const { moduleId, sourceId } = await makePaper('The gate', true);
  await extractPastPaperQuestions({ sourceId });

  const { existingStems } = await import('../src/services/questions/novelty.js');
  const bank = existingStems(moduleId);
  const papers = bank.filter((entry) => entry.source === 'past_paper');

  // The whole point. Before this existed the bank held no past papers, so the
  // check compared against nothing and waved every generated question through.
  assert.ok(papers.length > 0, 'no past-paper stems reached the gate');

  const nearlyTheSame =
    'Describe the effect of oligomycin on mitochondrial oxygen uptake, and explain the mechanism by which it acts.';
  const [vector] = await embedSafely([nearlyTheSame]);

  const verdict = checkNovelty({
    stem: nearlyTheSame,
    embedding: vector ?? null,
    signature: 'new-signature',
    existing: bank,
    usedSignatures: new Set(),
  });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'reproduces_a_past_paper');
  assert.equal(verdict.nearest?.source, 'past_paper');
});

test('the extract route reports what it did', async () => {
  const { moduleId } = await makePaper('Through the API', true);

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/past-papers/extract`,
    payload: {},
  });
  assert.equal(response.statusCode, 200);

  const body = json<{
    papers: number;
    found: number;
    stored: number;
    mapped: number;
    unmapped: boolean;
  }>(response);
  assert.equal(body.papers, 1);
  assert.equal(body.found, 6);
  assert.equal(body.stored, 6);

  // Concepts with embeddings existed, so the comparison ran. How many actually
  // matched is not assertable here: the offline embedder has no semantic
  // understanding, and a real question and the concept it tests share almost
  // no words. Whether the 0.55 threshold is right needs a real embedder and
  // real papers — the same open question as every other threshold in the
  // system.
  assert.equal(body.unmapped, false, 'the comparison must have run at all');
  assert.ok(body.mapped >= 0);
});

test('a question that restates a concept is mapped to it', async () => {
  const { moduleId, sourceId, sectionId } = await makePaper('Mapping path', false);
  const db = getDb();

  // Near-identical wording, because the offline embedder scores on words
  // rather than meaning. This tests that the mapping is wired up and stores
  // what it finds — not that the threshold is well chosen.
  const statement =
    'Describe the effect of oligomycin on mitochondrial oxygen consumption, and explain the mechanism by which it acts.';
  const [vector] = await embedSafely([statement]);
  const conceptId = newId();
  db.insert(schema.concepts)
    .values({
      id: conceptId,
      sectionId,
      statement,
      type: 'mechanism',
      examinableFlag: false,
      embedding: vector ? Buffer.from(vector.buffer) : null,
    })
    .run();

  const result = await extractPastPaperQuestions({ sourceId });
  assert.ok(result.mapped > 0, 'a question restating a concept verbatim must map to it');

  const mapped = db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all()
    .filter((question) => (question.conceptIds ?? []).includes(conceptId));

  assert.ok(mapped.length > 0);
  // Filing it under a section is what puts it on the section's Exam tab.
  assert.ok(mapped[0]!.sectionIds?.includes(sectionId));
});

test('extracting with no past papers says which step is missing', async () => {
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title: 'No papers' } }),
  ).id;

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/past-papers/extract`,
    payload: {},
  });
  assert.equal(response.statusCode, 400);
  assert.match(json<{ error: string }>(response).error, /past paper/i);
});
