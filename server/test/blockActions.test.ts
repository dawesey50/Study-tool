/**
 * Acting on one block of notes — §6.6.
 *
 * The tests that earn their place are about restraint rather than capability.
 *
 * A block action must not write over your notes: the reason you pressed it is
 * that one paragraph did not land, and replacing it with something you have
 * not read is not an improvement. So the result is a proposal, and the block
 * on disk is untouched until you accept.
 *
 * It must not reach outside the section's own sources. "Go deeper" is exactly
 * the request most likely to be answered with something plausible that is not
 * in the material, and a note is the worst place for that — it gets revised
 * from and examined on.
 *
 * And it must respect the lock, which is the one promise the note editor makes
 * about your own writing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-actions-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';
process.env.LLM_MODEL_REWRITE = 'claude-sonnet-5';
process.env.LLM_MONTHLY_CAP_GBP = '1000';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { setStub, resetStub, stubCalls } = await import('../src/llm/providers/stub.js');
const { newId } = await import('../src/lib/ids.js');
const { runBlockAction } = await import('../src/services/blockActions.js');
const { createBlock, listBlocks, updateBlock } = await import('../src/services/notes.js');

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

const ORIGINAL = 'Oligomycin blocks ATP synthase, so respiration slows.';
const REWRITTEN =
  'Oligomycin binds the Fo channel of ATP synthase, blocking the only route protons have back into the matrix. The proton motive force therefore rises until the chain can no longer pump against it, and oxygen consumption falls.';

const RESPONSE = JSON.stringify({
  markdown: REWRITTEN,
  note: 'Filled in the step between the block and the slowing.',
});

async function makeSection(title: string, options: { withSources?: boolean } = {}) {
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

  if (options.withSources !== false) {
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

    const chunkId = newId();
    db.insert(schema.chunks)
      .values({
        id: chunkId,
        sourceId,
        text: 'Oligomycin binds the Fo channel. The proton motive force rises until electron transport stalls against it.',
        slideNo: 12,
        position: 0,
      })
      .run();
    db.insert(schema.sourceSections)
      .values({ sourceId, sectionId, chunkRange: { chunkIds: [chunkId] }, score: 0.9, confirmed: true })
      .run();

    db.insert(schema.concepts)
      .values({
        id: newId(),
        sectionId,
        statement: 'Oligomycin blocks the Fo channel of ATP synthase.',
        type: 'mechanism',
        examinableFlag: true,
        sourceChunkIds: [chunkId],
      })
      .run();
  }

  return { moduleId, sectionId };
}

// ---------------------------------------------------------------------------

test('an action proposes a rewrite and leaves the block alone', async () => {
  const { sectionId } = await makeSection('Proposal only');
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'ai_generated',
  });

  setStub({ respond: () => RESPONSE });
  const result = await runBlockAction({ blockId: block.id, action: 'explain_further' });

  assert.equal(result.original, ORIGINAL);
  assert.equal(result.proposed, REWRITTEN);
  assert.ok(result.note, 'a proposal you cannot judge is not a proposal');

  // The reason you pressed the button is that this paragraph did not land.
  // Replacing it with something you have not read is not an improvement.
  assert.equal(listBlocks(sectionId)[0]!.markdown, ORIGINAL);
});

test('accepting goes through the ordinary edit path and marks it edited', async () => {
  const { sectionId } = await makeSection('Accepting');
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'ai_generated',
  });

  setStub({ respond: () => RESPONSE });
  const result = await runBlockAction({ blockId: block.id, action: 'explain_further' });

  const updated = await updateBlock(block.id, { markdown: result.proposed });

  assert.equal(updated.markdown, REWRITTEN);
  // Exactly as if you had rewritten it by hand — which is what happened, with
  // help. Generation must then leave it alone like any other edited block.
  assert.equal(updated.origin, 'user_edited');
});

test('a locked block is refused rather than proposed at', async () => {
  const { sectionId } = await makeSection('Locked');
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: 'Something I wrote and locked.',
    origin: 'user_written',
  });
  await updateBlock(block.id, { locked: true });

  setStub({ respond: () => RESPONSE });

  // The lock is the one promise the editor makes about your own writing.
  // Producing a proposal that could not be applied would only cost a call and
  // muddy what the lock means.
  await assert.rejects(
    () => runBlockAction({ blockId: block.id, action: 'rewrite' }),
    /locked/i,
  );
  assert.equal(stubCalls().length, 0, 'a locked block should not reach the model at all');
});

test('a section with no mapped sources is refused, not answered from memory', async () => {
  const { sectionId } = await makeSection('No sources', { withSources: false });
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'user_written',
  });

  setStub({ respond: () => RESPONSE });

  // With no material there is nothing to revise against, and a model asked to
  // go deeper on nothing will happily oblige from its own knowledge — which is
  // the one thing these notes must never contain.
  await assert.rejects(
    () => runBlockAction({ blockId: block.id, action: 'go_deeper' }),
    /source material|map a source/i,
  );
  assert.equal(stubCalls().length, 0);
});

test('the model is given the section sources and the surrounding blocks', async () => {
  const { sectionId } = await makeSection('Context');
  const before = await createBlock({
    sectionId,
    type: 'prose',
    markdown: 'The chain pumps protons across the inner membrane.',
    origin: 'ai_generated',
  });
  const target = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'ai_generated',
  });
  await createBlock({
    sectionId,
    type: 'prose',
    markdown: 'Uncouplers dissipate the gradient instead.',
    origin: 'ai_generated',
  });

  setStub({ respond: () => RESPONSE });
  await runBlockAction({ blockId: target.id, action: 'go_deeper' });

  const prompt = stubCalls()[0]!.prompt;
  assert.ok(prompt.includes(ORIGINAL), 'the block itself was not sent');
  assert.ok(prompt.includes('Oligomycin binds the Fo channel'), 'the source chunk was not sent');
  // Context stops a rewrite repeating or contradicting what is either side of
  // it, which is the commonest way a per-block rewrite spoils a section.
  assert.ok(prompt.includes('The chain pumps protons'), 'the preceding block was not sent');
  assert.ok(prompt.includes('Uncouplers dissipate'), 'the following block was not sent');
  assert.ok(before.id !== target.id);
});

test('a model that says the sources do not go that far is believed', async () => {
  const { sectionId } = await makeSection('Limited');
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'ai_generated',
  });

  setStub({
    respond: () =>
      JSON.stringify({
        markdown: ORIGINAL,
        note: 'The slides do not cover the structural basis of the block.',
        limitedBySources: true,
      }),
  });

  const result = await runBlockAction({ blockId: block.id, action: 'go_deeper' });

  // An honest "the material does not go that far" is a better answer than a
  // confident invention, and it has to reach the interface to be one.
  assert.equal(result.limitedBySources, true);
  assert.ok(result.note?.includes('do not cover'));
});

test('an empty rewrite is refused rather than shown as a proposal', async () => {
  const { sectionId } = await makeSection('Empty');
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'ai_generated',
  });

  setStub({ respond: () => JSON.stringify({ markdown: '   ' }) });

  await assert.rejects(
    () => runBlockAction({ blockId: block.id, action: 'simplify' }),
    /empty/i,
  );
  assert.equal(listBlocks(sectionId)[0]!.markdown, ORIGINAL);
});

test('a free-text instruction overrides the preset wording', async () => {
  const { sectionId } = await makeSection('Custom');
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'ai_generated',
  });

  setStub({ respond: () => RESPONSE });
  await runBlockAction({
    blockId: block.id,
    action: 'rewrite',
    instruction: 'Rewrite this as a numbered sequence of steps.',
  });

  const prompt = stubCalls()[0]!.prompt;
  assert.ok(prompt.includes('numbered sequence of steps'));
});

test('the route reports a spending cap as a cap', async () => {
  const { sectionId } = await makeSection('Capped');
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'ai_generated',
  });

  setStub({
    respond: () => Object.assign(new Error('Monthly cap reached'), { name: 'MonthlyCapError' }),
  });

  const response = await app.inject({
    method: 'POST',
    url: `/api/notes/${block.id}/action`,
    payload: { action: 'simplify' },
  });

  // 429 rather than 400: the difference between "try again" and "raise the cap".
  assert.equal(response.statusCode, 429);
});

test('the route round-trips an action end to end', async () => {
  const { sectionId } = await makeSection('Route');
  const block = await createBlock({
    sectionId,
    type: 'prose',
    markdown: ORIGINAL,
    origin: 'ai_generated',
  });

  setStub({ respond: () => RESPONSE });

  const result = json<{ original: string; proposed: string; blockId: string }>(
    await app.inject({
      method: 'POST',
      url: `/api/notes/${block.id}/action`,
      payload: { action: 'explain_further' },
    }),
  );

  assert.equal(result.blockId, block.id);
  assert.equal(result.original, ORIGINAL);
  assert.equal(result.proposed, REWRITTEN);

  const stored = getDb()
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.id, block.id))
    .get()!;
  assert.equal(stored.markdown, ORIGINAL, 'the route must not write the proposal');
});
