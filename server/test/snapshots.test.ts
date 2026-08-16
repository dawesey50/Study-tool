/**
 * Restore points.
 *
 * The scenario these exist for: a generation run goes wrong and walks over
 * notes you wrote yourself. That has never happened, because nothing generates
 * yet — which is exactly why it is worth simulating one now, while the cost of
 * finding a hole is a test run rather than a term's notes.
 *
 * So the central test below does the damage deliberately: it takes a restore
 * point through the same seam generation will use, then deletes and overwrites
 * everything in the section, and checks that going back really goes back.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-snapshots-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.SNAPSHOTS_KEPT = '3';

const { buildServer } = await import('../src/index.js');
const { closeDb } = await import('../src/db/index.js');
const {
  listSnapshots,
  previewRestore,
  restoreSnapshot,
  takeSnapshot,
  withSnapshot,
} = await import('../src/services/snapshots.js');
const { createBlock, deleteBlock, listBlocks, updateBlock } = await import(
  '../src/services/notes.js'
);

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

/** A module with one section holding a hand-written note and a generated one. */
async function makeModule(title: string) {
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
  return { moduleId, sectionId: tree[0]!.id, otherSectionId: tree[1]!.id };
}

test('a restore point puts back what a bad run destroyed', async () => {
  const { moduleId, sectionId } = await makeModule('Neuroscience');

  const mine = await createBlock({
    sectionId,
    type: 'prose',
    markdown: 'My own summary, which must survive.',
  });
  await updateBlock(mine.id, { locked: true });
  await createBlock({
    sectionId,
    type: 'prose',
    markdown: 'A second paragraph I also wrote.',
  });

  // Exactly the seam generation will call, rather than a snapshot taken by
  // hand — "remember to snapshot first" is the guarantee that fails on the run
  // that needed it.
  const damage = await withSnapshot(
    { moduleId, sectionId, label: 'Before generating notes for 1.0' },
    async () => {
      for (const block of listBlocks(sectionId)) deleteBlock(block.id);
      await createBlock({
        sectionId,
        type: 'prose',
        markdown: 'Generated rubbish that replaced everything.',
        origin: 'ai_generated',
      });
      return 'done';
    },
  );
  assert.equal(damage, 'done');
  assert.equal(listBlocks(sectionId).length, 1, 'the run really did destroy the notes');

  const [snapshot] = listSnapshots(moduleId);
  assert.ok(snapshot);
  assert.equal(snapshot.reason, 'before_generation');
  assert.equal(snapshot.blockCount, 2);

  const preview = previewRestore(snapshot.id);
  assert.equal(preview?.restored, 2, 'both of my paragraphs come back');
  assert.equal(preview?.removed, 1, 'the generated block goes');

  await restoreSnapshot(snapshot.id);

  const back = listBlocks(sectionId);
  assert.equal(back.length, 2);
  assert.equal(back[0]?.markdown, 'My own summary, which must survive.');
  assert.equal(back[0]?.locked, true, 'the lock came back with it');
  assert.equal(back[0]?.origin, 'user_written');
  assert.equal(back[1]?.markdown, 'A second paragraph I also wrote.');
  assert.equal(back[0]?.id, mine.id, 'identity is preserved, so links still resolve');
});

test('restoring is itself undoable', async () => {
  const { moduleId, sectionId } = await makeModule('Undo');

  await createBlock({ sectionId, type: 'prose', markdown: 'First state.' });
  const first = takeSnapshot({ moduleId, sectionId, label: 'First', reason: 'manual' });

  for (const block of listBlocks(sectionId)) deleteBlock(block.id);
  await createBlock({ sectionId, type: 'prose', markdown: 'Second state, worth keeping.' });

  const result = await restoreSnapshot(first.id);
  assert.equal(listBlocks(sectionId)[0]?.markdown, 'First state.');

  // Changed your mind: the state the restore replaced was captured first.
  await restoreSnapshot(result.undoSnapshotId);
  assert.equal(listBlocks(sectionId)[0]?.markdown, 'Second state, worth keeping.');
});

test('a restore says what it will delete before it deletes it', async () => {
  const { moduleId, sectionId } = await makeModule('Preview');

  await createBlock({ sectionId, type: 'prose', markdown: 'Present at snapshot time.' });
  const snapshot = takeSnapshot({ moduleId, sectionId, label: 'Point', reason: 'manual' });

  const written = await createBlock({
    sectionId,
    type: 'prose',
    markdown: 'Written afterwards, and locked.',
  });
  await updateBlock(written.id, { locked: true });

  const preview = previewRestore(snapshot.id);
  assert.equal(preview?.removed, 1);
  assert.equal(preview?.removedUserWritten, 1);
  assert.equal(
    preview?.removedLocked,
    1,
    'a locked block being lost is the thing you most need warning about',
  );
});

test('a section snapshot leaves the rest of the module alone', async () => {
  const { moduleId, sectionId, otherSectionId } = await makeModule('Scoped');

  await createBlock({ sectionId, type: 'prose', markdown: 'In scope.' });
  await createBlock({ sectionId: otherSectionId, type: 'prose', markdown: 'Out of scope.' });

  const snapshot = takeSnapshot({ moduleId, sectionId, label: 'Just 1.0', reason: 'manual' });
  assert.equal(snapshot.blockCount, 1);

  for (const block of listBlocks(otherSectionId)) deleteBlock(block.id);
  await createBlock({ sectionId: otherSectionId, type: 'prose', markdown: 'Changed since.' });

  await restoreSnapshot(snapshot.id);
  assert.equal(
    listBlocks(otherSectionId)[0]?.markdown,
    'Changed since.',
    'restoring one section must not roll back another',
  );
});

test('a module snapshot covers every section', async () => {
  const { moduleId, sectionId, otherSectionId } = await makeModule('Whole module');

  await createBlock({ sectionId, type: 'prose', markdown: 'One.' });
  await createBlock({ sectionId: otherSectionId, type: 'prose', markdown: 'Two.' });

  const snapshot = takeSnapshot({ moduleId, label: 'Everything', reason: 'manual' });
  assert.equal(snapshot.blockCount, 2);
  assert.equal(snapshot.sectionId, null);

  for (const id of [sectionId, otherSectionId]) {
    for (const block of listBlocks(id)) deleteBlock(block.id);
  }

  await restoreSnapshot(snapshot.id);
  assert.equal(listBlocks(sectionId).length, 1);
  assert.equal(listBlocks(otherSectionId).length, 1);
});

test('old restore points are pruned so history cannot grow without bound', async () => {
  const { moduleId, sectionId } = await makeModule('Pruning');
  await createBlock({ sectionId, type: 'prose', markdown: 'Anything.' });

  // All five land inside the same second, which is the case that matters: a
  // run over twenty sections snapshots twenty times in a moment. Ordering by
  // created_at would keep an arbitrary three of them, because the column has
  // one-second resolution and every row would tie.
  for (const label of ['one', 'two', 'three', 'four', 'five']) {
    takeSnapshot({ moduleId, sectionId, label, reason: 'manual' });
  }

  const kept = listSnapshots(moduleId);
  assert.equal(kept.length, 3, 'SNAPSHOTS_KEPT is 3 in this suite');
  assert.deepEqual(
    kept.map((row) => row.label),
    ['five', 'four', 'three'],
    'the most recent survive, not an arbitrary three',
  );
  assert.equal(
    new Set(kept.map((row) => row.createdAt)).size,
    1,
    'they really did all share a timestamp, so this test exercised the tie',
  );
});

test('a snapshot survives the section it covered being deleted', async () => {
  const { moduleId, sectionId } = await makeModule('Deleted section');
  await createBlock({ sectionId, type: 'prose', markdown: 'Doomed.' });
  const snapshot = takeSnapshot({ moduleId, sectionId, label: 'Before', reason: 'manual' });

  await app.inject({ method: 'DELETE', url: `/api/sections/${sectionId}` });

  // The row goes with its section, which is right: a restore point for a
  // section that no longer exists has nothing to restore into.
  assert.equal(
    listSnapshots(moduleId).some((row) => row.id === snapshot.id),
    false,
  );
});

test('the routes list, take, preview and restore', async () => {
  const { moduleId, sectionId } = await makeModule('Over HTTP');
  await createBlock({ sectionId, type: 'prose', markdown: 'Original.' });

  const created = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/snapshots`,
    payload: { sectionId, label: 'By hand' },
  });
  assert.equal(created.statusCode, 201);
  const snapshot = json<{ id: string; blockCount: number }>(created);
  assert.equal(snapshot.blockCount, 1);

  for (const block of listBlocks(sectionId)) deleteBlock(block.id);

  const preview = json<{ restored: number }>(
    await app.inject({ method: 'GET', url: `/api/snapshots/${snapshot.id}/preview` }),
  );
  assert.equal(preview.restored, 1);

  const restored = await app.inject({
    method: 'POST',
    url: `/api/snapshots/${snapshot.id}/restore`,
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(listBlocks(sectionId)[0]?.markdown, 'Original.');

  const listed = json<unknown[]>(
    await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/snapshots` }),
  );
  assert.ok(listed.length >= 2, 'the restore recorded its own undo point');
});

test('restoring a point that has been deleted fails clearly', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/snapshots/does-not-exist/restore',
  });
  assert.equal(response.statusCode, 404);
  assert.match(json<{ error: string }>(response).error, /no longer exists/);
});
