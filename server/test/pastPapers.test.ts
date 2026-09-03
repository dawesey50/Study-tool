/**
 * Past papers deciding what is examinable.
 *
 * The cheapest useful thing in the whole system: it needs no model at all,
 * because every question in a past paper was, by definition, examined. What it
 * has to get right is not being confidently wrong — the flag it sets goes on to
 * weight note generation and question sampling, so a bad one propagates
 * quietly. Hence: evidence attached to every flag, and nothing concluded at all
 * when there is nothing to compare.
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

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { markExaminableFromPastPapers } = await import('../src/services/pastPapers.js');
const { embedSafely } = await import('../src/embeddings/index.js');
const { toBlob } = await import('../src/lib/vector.js');
const { newId } = await import('../src/lib/ids.js');

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

const EXAMINED = 'Explain how the Na+/K+ ATPase maintains the resting membrane potential.';
const NOT_EXAMINED = 'Describe the anatomy of the cerebellar peduncles.';

/**
 * The offline embedder is deterministic and has no semantic understanding, so
 * identical text is the only reliable match. The concept statements below are
 * therefore the question text verbatim — which is the shape of the real case
 * (a question about a concept) reduced to what this provider can score.
 */
async function makeModule() {
  const db = getDb();
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title: 'Papers' } }),
  ).id;

  const tree = json<Array<{ id: string }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: { tree: [{ title: 'Resting potential' }] },
    }),
  );
  const sectionId = tree[0]!.id;

  const paperId = newId();
  db.insert(schema.sources)
    .values({
      id: paperId,
      moduleId,
      type: 'past_paper',
      title: 'PA20345 2023 paper',
      filename: '2023.pdf',
      path: 'media/sources/2023.pdf',
      status: 'ingested',
    })
    .run();

  const [questionVector] = await embedSafely([EXAMINED]);
  const chunkId = newId();
  db.insert(schema.chunks)
    .values({
      id: chunkId,
      sourceId: paperId,
      text: EXAMINED,
      pageNo: 2,
      position: 0,
      embedding: questionVector ? toBlob(questionVector) : null,
    })
    .run();

  const vectors = await embedSafely([EXAMINED, NOT_EXAMINED]);
  const conceptIds = [EXAMINED, NOT_EXAMINED].map((statement, index) => {
    const id = newId();
    const vector = vectors[index];
    db.insert(schema.concepts)
      .values({
        id,
        sectionId,
        statement,
        type: 'mechanism',
        sourceChunkIds: [],
        embedding: vector ? toBlob(vector) : null,
      })
      .run();
    return id;
  });

  return { moduleId, sectionId, paperId, chunkId, examinedId: conceptIds[0]!, otherId: conceptIds[1]! };
}

test('a concept a past paper asked about is flagged, with the paper as evidence', async () => {
  const db = getDb();
  const { moduleId, examinedId, chunkId } = await makeModule();

  const result = markExaminableFromPastPapers({ moduleId });
  assert.equal(result.papers, 1);
  // Passages of paper text, not questions. This was called `questions` and
  // reported a chunk count, so the interface said "checked against 12
  // questions" when it had compared twelve 1400-character passages. Real
  // question extraction is a separate pass — see pastPaperQuestions.ts.
  assert.equal(result.passages, 1);
  assert.equal(result.flagged, 1);
  assert.equal(result.unmeasured, false);

  const concept = db.select().from(schema.concepts).where(eq(schema.concepts.id, examinedId)).get();
  assert.equal(concept?.examinableFlag, true);

  const evidence = concept?.examinableEvidence ?? [];
  assert.equal(evidence.length, 1, 'the flag carries its reason');
  assert.equal(evidence[0]?.chunkId, chunkId);
  assert.match(
    evidence[0]?.location ?? '',
    /PA20345 2023 paper p\.2/,
    'which paper and which page, so it can be checked in ten seconds',
  );
  assert.match(evidence[0]?.excerpt ?? '', /Na\+\/K\+ ATPase/);
  assert.ok((evidence[0]?.score ?? 0) > 0.9);
});

test('a concept the papers never asked about is left alone', async () => {
  const db = getDb();
  const { moduleId, otherId } = await makeModule();

  markExaminableFromPastPapers({ moduleId });

  const concept = db.select().from(schema.concepts).where(eq(schema.concepts.id, otherId)).get();
  assert.equal(concept?.examinableFlag, false);
  assert.equal(concept?.examinableEvidence, null);
});

test('a flag you set by hand is never cleared by a run', async () => {
  const db = getDb();
  const { moduleId, otherId } = await makeModule();

  // You know this comes up even though it is not in the paper you have.
  db.update(schema.concepts)
    .set({ examinableFlag: true })
    .where(eq(schema.concepts.id, otherId))
    .run();

  const result = markExaminableFromPastPapers({ moduleId });
  assert.equal(result.alreadyFlagged, 1);

  const concept = db.select().from(schema.concepts).where(eq(schema.concepts.id, otherId)).get();
  assert.equal(concept?.examinableFlag, true, 'this proposes; it does not overrule you');
});

test('nothing is concluded when there is nothing to compare', async () => {
  const db = getDb();
  const { moduleId, chunkId } = await makeModule();

  // A paper ingested while the embedding model could not be reached.
  db.update(schema.chunks)
    .set({ embedding: null })
    .where(eq(schema.chunks.id, chunkId))
    .run();

  const result = markExaminableFromPastPapers({ moduleId });
  assert.equal(result.unmeasured, true);
  assert.equal(result.flagged, 0, 'guessing would put an unearned flag on everything downstream');
});

test('a module with no past papers says so rather than failing', async () => {
  const db = getDb();
  const { moduleId, paperId } = await makeModule();
  db.delete(schema.sources).where(eq(schema.sources.id, paperId)).run();

  const result = markExaminableFromPastPapers({ moduleId });
  assert.equal(result.papers, 0);
  assert.equal(result.flagged, 0);
  assert.equal(result.unmeasured, false);
});

test('the route runs it for a module', async () => {
  const { moduleId } = await makeModule();
  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/concepts/examinable`,
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  assert.equal(json<{ flagged: number }>(response).flagged, 1);
});
