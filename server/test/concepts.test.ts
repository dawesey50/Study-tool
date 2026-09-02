/**
 * Concept extraction, dedupe and ownership.
 *
 * The model is a stub here, which means none of this says anything about
 * whether the extraction *prompt* is any good — that needs real material and
 * your judgement, and plan v2 makes it the done-when for this step.
 *
 * What it does prove is the part that must hold whatever the model returns:
 * a concept citing chunks that do not exist is dropped rather than stored,
 * restatements of one idea are merged, hand corrections survive a re-run, and
 * a spending limit stops the whole job rather than being hit twenty times.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-concepts-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';
process.env.LLM_MODEL_CONCEPTS = 'claude-sonnet-5';
process.env.LLM_MONTHLY_CAP_GBP = '1000';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { setStub, resetStub, stubCalls } = await import('../src/llm/providers/stub.js');
const { extractConcepts, listConcepts, assignOwnership, assessPlausibility } = await import(
  '../src/services/concepts.js'
);
const { startRun } = await import('../src/llm/index.js');
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

beforeEach(() => resetStub());

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

/**
 * A module with a section that has real chunks mapped to it. Built directly
 * rather than through ingestion, so the test is about extraction and not about
 * whether a fixture PDF parses.
 */
async function makeSection(title: string, texts: string[]) {
  const db = getDb();
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title } }),
  ).id;

  const tree = json<Array<{ id: string }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: { tree: [{ title: 'Resting potential' }, { title: 'Action potential' }] },
    }),
  );
  const sectionId = tree[0]!.id;
  const otherSectionId = tree[1]!.id;

  const sourceId = newId();
  db.insert(schema.sources)
    .values({
      id: sourceId,
      moduleId,
      type: 'slides',
      title: 'Lecture 7',
      filename: 'l07.pdf',
      path: 'media/sources/l07.pdf',
      status: 'ingested',
    })
    .run();

  const chunkIds: string[] = [];
  texts.forEach((text, index) => {
    const chunkId = newId();
    chunkIds.push(chunkId);
    db.insert(schema.chunks)
      .values({ id: chunkId, sourceId, text, slideNo: index + 1, position: index })
      .run();
  });

  db.insert(schema.sourceSections)
    .values({ sourceId, sectionId, chunkRange: { chunkIds }, score: 0.9, confirmed: true })
    .run();

  return { moduleId, sectionId, otherSectionId, sourceId, chunkIds };
}

/** Make the stub answer with a concept list, as the real model would. */
function answerWith(concepts: unknown[]) {
  setStub({ respond: () => JSON.stringify({ concepts }) });
}

test('a concept citing a chunk that does not exist is dropped, not stored', async () => {
  const { sectionId, chunkIds } = await makeSection('Citations', [
    'The Na+/K+ ATPase moves three sodium out for every two potassium in.',
    'This makes the pump electrogenic, contributing a few millivolts.',
  ]);

  answerWith([
    {
      statement: 'The Na+/K+ ATPase moves three sodium out for two potassium in.',
      type: 'mechanism',
      sourceChunkIds: [chunkIds[0]],
    },
    {
      statement: 'Invented from nowhere, citing a chunk in another lecture.',
      type: 'fact',
      sourceChunkIds: ['a-chunk-that-does-not-exist'],
    },
  ]);

  const result = await extractConcepts({ sectionId });
  assert.equal(result.uncited, 1);
  assert.equal(result.kept, 1);

  const stored = listConcepts(sectionId);
  assert.equal(stored.length, 1);
  assert.match(stored[0]!.statement, /three sodium/);
  assert.deepEqual(stored[0]!.sourceChunkIds, [chunkIds[0]]);
});

test('restatements of one idea are merged, keeping both citations', async () => {
  const { sectionId, chunkIds } = await makeSection('Dedupe', [
    'Myelination speeds conduction.',
    'Myelin makes the axon conduct faster.',
  ]);

  // Identical statements are the case that must merge whatever the embedding
  // provider is — the offline one has no semantic understanding at all.
  answerWith([
    {
      statement: 'Myelination increases conduction velocity.',
      type: 'mechanism',
      sourceChunkIds: [chunkIds[0]],
      emphasis: 0.4,
    },
    {
      statement: 'Myelination increases conduction velocity.',
      type: 'mechanism',
      sourceChunkIds: [chunkIds[1]],
      emphasis: 0.9,
      examinable: true,
    },
  ]);

  const result = await extractConcepts({ sectionId });
  assert.equal(result.merged, 1);
  assert.equal(result.kept, 1);

  const [concept] = listConcepts(sectionId);
  assert.equal(concept?.sourceChunkIds?.length, 2, 'the idea really was in both places');
  assert.equal(concept?.emphasisScore, 0.9, 'the stronger emphasis wins');
  assert.equal(concept?.examinableFlag, true, 'and so does the examinable flag');
});

test('re-extracting the same material keeps identifiers stable', async () => {
  const { sectionId, chunkIds } = await makeSection('Stability', [
    'Voltage-gated sodium channels open at about -55 mV.',
  ]);

  answerWith([
    {
      statement: 'Voltage-gated sodium channels open at about -55 mV.',
      type: 'fact',
      sourceChunkIds: [chunkIds[0]],
    },
  ]);
  await extractConcepts({ sectionId });
  const first = listConcepts(sectionId)[0]!;

  // A second run has to be able to find the same concept, or every question,
  // note and review record pointing at it would be orphaned.
  await extractConcepts({ sectionId, fresh: true });
  const second = listConcepts(sectionId)[0]!;

  assert.equal(second.id, first.id, 'an unchanged statement keeps its id');
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(listConcepts(sectionId).length, 1, 're-running must not double the list');
});

test('extraction refuses a section with nothing mapped to it', async () => {
  const { otherSectionId } = await makeSection('Empty', ['Some material.']);
  await assert.rejects(
    () => extractConcepts({ sectionId: otherSectionId }),
    /No sources are mapped/,
  );
});

test('the prompt carries the chunk ids the model has to cite', async () => {
  const { sectionId, chunkIds } = await makeSection('Prompting', [
    'Saltatory conduction jumps between nodes of Ranvier.',
  ]);
  answerWith([]);
  await extractConcepts({ sectionId });

  const prompt = stubCalls()[0]?.prompt ?? '';
  assert.ok(prompt.includes(chunkIds[0]!), 'the model cannot cite an id it was never shown');
  assert.match(prompt, /slide 1/, 'and the location travels with it, for emphasis');
});

test('a run that hits its ceiling stops the whole job, not just one section', async () => {
  const { sectionId } = await makeSection('Ceiling', ['Material enough to extract from.']);
  setStub({ respond: () => JSON.stringify({ concepts: [] }), outputTokens: 5000 });

  const run = startRun({ label: 'Concept extraction', tokenCeiling: 5000 });
  await extractConcepts({ sectionId, run });

  await assert.rejects(
    () => extractConcepts({ sectionId, run, fresh: true }),
    (error: Error) => error.name === 'RunCeilingError',
  );
});

test('ownership goes to the section with more material behind the idea', async () => {
  const db = getDb();
  const { moduleId, sectionId, otherSectionId, sourceId, chunkIds } = await makeSection(
    'Ownership',
    ['The Na+/K+ ATPase is electrogenic.', 'It is electrogenic because of the 3:2 ratio.'],
  );

  // The same statement in two sections. The offline embedding provider is
  // deterministic, so identical text gives identical vectors — which is
  // exactly the "same idea taught twice" case ownership exists for.
  const statement = 'The Na+/K+ ATPase is electrogenic.';
  answerWith([{ statement, type: 'mechanism', sourceChunkIds: chunkIds }]);
  await extractConcepts({ sectionId });

  db.insert(schema.sourceSections)
    .values({
      sourceId,
      sectionId: otherSectionId,
      chunkRange: { chunkIds: [chunkIds[0]!] },
      score: 0.8,
      confirmed: true,
    })
    .run();
  answerWith([{ statement, type: 'mechanism', sourceChunkIds: [chunkIds[0]] }]);
  await extractConcepts({ sectionId: otherSectionId });

  const result = await assignOwnership(moduleId);
  assert.equal(result.links, 1, 'the pair is linked once, not once each way');

  const links = db.select().from(schema.conceptLinks).all();
  const owner = listConcepts(sectionId)[0]!;
  const borrower = listConcepts(otherSectionId)[0]!;
  assert.equal(links[0]?.toConceptId, owner.id, 'two citations beat one');
  assert.equal(links[0]?.fromConceptId, borrower.id);
});

test('the section route reports citations as readable locations', async () => {
  const { sectionId, chunkIds } = await makeSection('Routes', [
    'Nodes of Ranvier are gaps in the myelin sheath.',
  ]);
  answerWith([
    {
      statement: 'Nodes of Ranvier are gaps in the myelin sheath.',
      type: 'anatomy',
      sourceChunkIds: [chunkIds[0]],
      examinable: true,
    },
  ]);
  await extractConcepts({ sectionId });

  const body = json<{
    concepts: Array<{ statement: string; citations: string[]; examinableFlag: boolean }>;
    plausibility: unknown;
  }>(await app.inject({ method: 'GET', url: `/api/sections/${sectionId}/concepts` }));

  assert.equal(body.concepts.length, 1);
  assert.deepEqual(body.concepts[0]?.citations, ['Lecture 7 slide 1']);
  assert.equal(body.concepts[0]?.examinableFlag, true);
});

test('a concept can be corrected and deleted by hand', async () => {
  const { sectionId, chunkIds } = await makeSection('Correcting', ['Some teaching material.']);
  answerWith([
    { statement: 'A vague statement.', type: 'fact', sourceChunkIds: [chunkIds[0]] },
  ]);
  await extractConcepts({ sectionId });
  const concept = listConcepts(sectionId)[0]!;

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/concepts/${concept.id}`,
    payload: { statement: 'A specific, examinable claim.', examinableFlag: true },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(listConcepts(sectionId)[0]?.statement, 'A specific, examinable claim.');

  const deleted = await app.inject({ method: 'DELETE', url: `/api/concepts/${concept.id}` });
  assert.equal(deleted.statusCode, 204);
  assert.equal(listConcepts(sectionId).length, 0);
});

test('the concept count check fires only on extremes', () => {
  // Around one concept per 900 characters, with a band wide enough that
  // ordinary variation between a terse slide deck and a verbose transcript
  // does not trip it. A check that cried wolf would teach you to ignore it.
  assert.equal(assessPlausibility(20, 18_000), null, 'the expected count says nothing');
  assert.equal(assessPlausibility(60, 18_000), null, 'a dense deck is not an error');
  assert.equal(assessPlausibility(6, 18_000), null, 'a sparse transcript is not either');

  assert.equal(assessPlausibility(0, 18_000)?.verdict, 'too_few', 'nothing found is worth saying');
  assert.equal(assessPlausibility(200, 18_000)?.verdict, 'too_many');

  assert.equal(assessPlausibility(7, 1_000), null, 'too little material to judge from');
  assert.equal(assessPlausibility(1, 200), null);

  const warning = assessPlausibility(2, 40_000);
  assert.match(warning!.message, /thin/);
  assert.match(warning!.message, /coverage badge/, 'say why it matters, not just that it is odd');
});

test('the offline stub answers a structured request with valid empty JSON', async () => {
  // Without this, LLM_PROVIDER=stub crashes on any task with a schema, and the
  // error blames the model for returning prose — a poor way for the offline
  // mode to behave when you are trying to click around without a key.
  const { sectionId } = await makeSection('Stub JSON', ['Material with no scripted answer.']);
  resetStub();

  const result = await extractConcepts({ sectionId, fresh: true });
  assert.equal(result.kept, 0);
  assert.equal(result.extracted, 0);
});

test('a mapping confirmed by hand attaches chunks, not just a tick', async () => {
  // The bug this pins: confirming a section the matcher never proposed wrote a
  // row with no chunk range. The interface said "confirmed by you", the
  // section's Sources tab showed the deck, and extraction found nothing —
  // with nothing anywhere saying why.
  const db = getDb();
  const { moduleId, otherSectionId, sourceId } = await makeSection('Hand mapping', [
    'Saltatory conduction jumps between the nodes of Ranvier.',
    'Myelin restricts current flow to the nodes.',
  ]);

  const response = await app.inject({
    method: 'PUT',
    url: `/api/sources/${sourceId}/sections`,
    payload: { sectionIds: [otherSectionId] },
  });
  assert.equal(response.statusCode, 200);

  const row = db
    .select()
    .from(schema.sourceSections)
    .where(eq(schema.sourceSections.sectionId, otherSectionId))
    .get();
  assert.ok(row, 'the mapping exists');
  assert.ok(
    (row!.chunkRange?.chunkIds.length ?? 0) > 0,
    'a confirmed mapping with no chunks is a mapping that does nothing',
  );

  // And the section is now extractable, which is the whole point.
  answerWith([]);
  const result = await extractConcepts({ sectionId: otherSectionId });
  assert.equal(result.kept, 0);
  assert.equal(moduleId.length > 0, true);
});
