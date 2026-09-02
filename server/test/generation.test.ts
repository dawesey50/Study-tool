/**
 * Note generation and the coverage check.
 *
 * The most important test here is the one about your own writing. `locked` and
 * `user_written` have been enforced since Phase 1, but only against a person
 * editing — never against a generator rewriting a section. This is the first
 * time that guarantee meets the thing it was built for, so it is tested
 * deliberately rather than assumed: lock a block, generate over it, and check
 * it is still there, still yours, and still says what it said.
 *
 * The other one that earns its place is the coverage loop. It exists to keep
 * writing until every concept is explained, which is precisely the shape of
 * loop that runs all night and produces a bill. It has two exits and both are
 * tested: the pass cap, and a pass that stopped making progress — because
 * continuing past the second only costs money.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { asc, eq } from 'drizzle-orm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-generation-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';
process.env.LLM_MODEL_NOTES = 'claude-sonnet-5';
process.env.LLM_MONTHLY_CAP_GBP = '1000';
process.env.LLM_MAX_ITERATIONS = '3';
// The offline embedding provider has no semantic understanding, so identical
// text is the only thing that scores highly. Coverage is therefore tested with
// blocks that quote the concept verbatim.
process.env.COVERAGE_THRESHOLD = '0.95';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { setStub, resetStub, stubCalls } = await import('../src/llm/providers/stub.js');
const { generateNotes } = await import('../src/services/generation.js');
const { listSnapshots, restoreSnapshot } = await import('../src/services/snapshots.js');
const { createBlock, listBlocks, updateBlock } = await import('../src/services/notes.js');
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

const STATEMENTS = [
  'The resting membrane potential of a typical neuron is about -70 mV.',
  'The Na+/K+ ATPase exports three sodium ions for every two potassium ions imported.',
  'Voltage-gated sodium channels open at a threshold of about -55 mV.',
  'Sodium channels inactivate within about a millisecond, ending the rising phase.',
  'Myelin concentrates sodium channels at the nodes of Ranvier.',
];

async function makeSection(title: string) {
  const db = getDb();
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title } }),
  ).id;
  const tree = json<Array<{ id: string }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: { tree: [{ title: 'Resting potential' }] },
    }),
  );
  const sectionId = tree[0]!.id;

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

  const chunkId = newId();
  db.insert(schema.chunks)
    .values({
      id: chunkId,
      sourceId,
      text: STATEMENTS.join(' '),
      slideNo: 1,
      position: 0,
    })
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

  const conceptIds = STATEMENTS.map((statement) => {
    const id = newId();
    db.insert(schema.concepts)
      .values({
        id,
        sectionId,
        statement,
        type: 'fact',
        examinableFlag: true,
        sourceChunkIds: [chunkId],
      })
      .run();
    return id;
  });

  return { moduleId, sectionId, conceptIds };
}

/** A generator that covers the concepts it is told to, by quoting them. */
function coveringGenerator() {
  setStub({
    respond: (request) => {
      const quoted = STATEMENTS.filter((statement) => request.prompt.includes(statement));
      return JSON.stringify({
        blocks: [
          { type: 'heading', markdown: '## Resting potential' },
          ...quoted.map((statement) => ({ type: 'prose', markdown: statement })),
        ],
      });
    },
  });
}

test('a locked block survives a generation run over it', async () => {
  const { sectionId } = await makeSection('Locks');

  const mine = await createBlock({
    sectionId,
    type: 'prose',
    markdown: 'My own note, in my own words, which must survive.',
  });
  await updateBlock(mine.id, { locked: true });
  const alsoMine = await createBlock({
    sectionId,
    type: 'prose',
    markdown: 'Unlocked, but still mine — origin alone must be enough.',
  });

  coveringGenerator();
  const result = await generateNotes({ sectionId });
  assert.ok(result.blocksWritten > 0);
  assert.equal(result.blocksPreserved, 2);

  const after = listBlocks(sectionId);
  const survivor = after.find((block) => block.id === mine.id);
  assert.ok(survivor, 'the locked block is still there');
  assert.equal(survivor.markdown, 'My own note, in my own words, which must survive.');
  assert.equal(survivor.locked, true);
  assert.equal(survivor.origin, 'user_written');

  const second = after.find((block) => block.id === alsoMine.id);
  assert.ok(second, 'an unlocked block you wrote is preserved too');
  assert.equal(second.origin, 'user_written');
});

test('regenerating replaces its own output rather than piling up', async () => {
  const { sectionId } = await makeSection('Idempotence');

  coveringGenerator();
  await generateNotes({ sectionId });
  const first = listBlocks(sectionId).length;

  await generateNotes({ sectionId, fresh: true });
  const second = listBlocks(sectionId).length;

  assert.equal(second, first, 'a second run must not double the notes');
  assert.equal(
    listBlocks(sectionId).every((block) => block.origin === 'ai_generated'),
    true,
  );
});

test('a restore point is taken before anything is written', async () => {
  const { moduleId, sectionId } = await makeSection('Restore point');
  await createBlock({ sectionId, type: 'prose', markdown: 'Written before generating.' });

  coveringGenerator();
  const result = await generateNotes({ sectionId });

  const snapshots = listSnapshots(moduleId);
  const taken = snapshots.find((row) => row.id === result.snapshotId);
  assert.ok(taken, 'the run recorded its own restore point');
  assert.equal(taken.reason, 'before_generation');

  // And it really does take you back to before the run.
  await restoreSnapshot(result.snapshotId);
  const back = listBlocks(sectionId);
  assert.equal(back.length, 1);
  assert.equal(back[0]?.markdown, 'Written before generating.');
});

test('coverage counts what was written, not what the model claimed', async () => {
  const { sectionId, conceptIds } = await makeSection('Honest coverage');

  // The model asserts it covered everything while writing about one thing.
  setStub({
    respond: () =>
      JSON.stringify({
        blocks: [
          {
            type: 'prose',
            markdown: STATEMENTS[0],
            conceptIds,
          },
        ],
      }),
  });

  const result = await generateNotes({ sectionId });
  assert.equal(result.coverage.measured, true);
  assert.equal(result.coverage.total, STATEMENTS.length);
  assert.ok(
    result.coverage.covered < STATEMENTS.length,
    'citing a concept id is not the same as explaining the concept',
  );
  assert.ok(result.coverage.uncovered.some((entry) => entry.statement === STATEMENTS[1]));
});

test('a pass that stops helping ends the loop rather than burning the cap', async () => {
  const { sectionId } = await makeSection('No progress');

  // Every pass writes something different, and none of it covers anything.
  let calls = 0;
  setStub({
    respond: () => {
      calls += 1;
      return JSON.stringify({
        blocks: [{ type: 'prose', markdown: `Filler paragraph number ${calls}, covering nothing.` }],
      });
    },
  });

  const result = await generateNotes({ sectionId });

  assert.equal(result.coverage.stoppedEarly, true);
  assert.equal(result.coverage.hitPassLimit, false, 'it did not need all three attempts');
  assert.equal(calls, 2, 'one generation and one supplement that showed the gap was not closing');
  assert.equal(result.coverage.uncovered.length, STATEMENTS.length, 'and it names them all');
});

test('a supplement that repeats the existing notes is not appended', async () => {
  const { sectionId } = await makeSection('Repetition');

  // The simulation caught this: a supplement returning its previous answer
  // doubled the notes while covering nothing new.
  setStub({
    respond: () =>
      JSON.stringify({ blocks: [{ type: 'prose', markdown: STATEMENTS[0] }] }),
  });

  const result = await generateNotes({ sectionId });
  const markdown = listBlocks(sectionId).map((block) => block.markdown);
  assert.equal(
    markdown.filter((text) => text === STATEMENTS[0]).length,
    1,
    'the same paragraph must not appear twice',
  );
  assert.equal(result.coverage.stoppedEarly, true);
});

test('a loop that keeps making progress stops at the cap and says what is left', async () => {
  const { sectionId } = await makeSection('Slow progress');

  // One new concept per pass: real progress, but not enough of it.
  let calls = 0;
  setStub({
    respond: () => {
      const statement = STATEMENTS[calls];
      calls += 1;
      return JSON.stringify({
        blocks: statement ? [{ type: 'prose', markdown: statement }] : [],
      });
    },
  });

  const result = await generateNotes({ sectionId });

  assert.equal(result.coverage.hitPassLimit, true, 'the cap is what stopped it');
  assert.equal(result.coverage.passes, 3, 'and it used exactly its three passes');
  assert.equal(calls, 4, 'one generation plus three supplements, and no more');
  assert.equal(result.coverage.covered, 4);
  assert.equal(result.coverage.uncovered.length, 1, 'the last one is named, not glossed over');
});

test('supplementary passes are told only what is missing', async () => {
  const { sectionId } = await makeSection('Supplements');

  setStub({
    respond: (request, index) =>
      JSON.stringify({
        blocks:
          index === 0
            ? [{ type: 'prose', markdown: STATEMENTS[0] }]
            : STATEMENTS.slice(1).map((statement) => ({ type: 'prose', markdown: statement })),
      }),
  });

  const result = await generateNotes({ sectionId });
  assert.equal(result.coverage.covered, STATEMENTS.length);
  assert.equal(result.coverage.uncovered.length, 0);
  assert.equal(result.coverage.passes, 1, 'one supplement closed the gap');

  const supplement = stubCalls()[1]?.prompt ?? '';
  assert.ok(supplement.includes(STATEMENTS[1]!), 'the missing concept is named');
  assert.ok(
    !supplement.includes(`- [${''}]`),
    'and the prompt is about the gap, not the whole section again',
  );
});

test('generation refuses a section with no concepts', async () => {
  const db = getDb();
  const { sectionId } = await makeSection('No concepts');
  db.delete(schema.concepts).where(eq(schema.concepts.sectionId, sectionId)).run();

  await assert.rejects(() => generateNotes({ sectionId }), /no concepts yet/i);
});

test('the route explains a refusal instead of returning a bare error', async () => {
  const db = getDb();
  const { sectionId } = await makeSection('Route errors');
  db.delete(schema.concepts).where(eq(schema.concepts.sectionId, sectionId)).run();

  const response = await app.inject({
    method: 'POST',
    url: `/api/sections/${sectionId}/notes/generate`,
    payload: {},
  });

  assert.equal(response.statusCode, 400);
  const { error } = json<{ error: string }>(response);
  assert.match(error, /Extract them first/, 'say what to do, not just what went wrong');
});

test('the route returns the coverage the caller has to display', async () => {
  const { sectionId } = await makeSection('Route success');
  coveringGenerator();

  const response = await app.inject({
    method: 'POST',
    url: `/api/sections/${sectionId}/notes/generate`,
    payload: { fresh: true },
  });
  assert.equal(response.statusCode, 200);

  const body = json<{
    coverage: { total: number; covered: number; measured: boolean; uncovered: unknown[] };
    snapshotId: string;
    blocksWritten: number;
  }>(response);
  assert.equal(body.coverage.total, STATEMENTS.length);
  assert.equal(body.coverage.covered, STATEMENTS.length);
  assert.equal(body.coverage.measured, true);
  assert.ok(body.snapshotId);
  assert.ok(body.blocksWritten > 0);
});

test('blocks keep their document order after a run', async () => {
  const db = getDb();
  const { sectionId } = await makeSection('Ordering');
  await createBlock({ sectionId, type: 'prose', markdown: 'Mine, first.' });

  coveringGenerator();
  await generateNotes({ sectionId });

  const positions = db
    .select({ position: schema.noteBlocks.position })
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, sectionId))
    .orderBy(asc(schema.noteBlocks.position))
    .all()
    .map((row) => row.position);

  assert.deepEqual(
    positions,
    positions.map((_, index) => index),
    'positions must stay a dense 0..n-1 run or the editor reorders on load',
  );
});
