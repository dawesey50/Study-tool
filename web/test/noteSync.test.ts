/**
 * Regression coverage for the two decisions behind a stuck-save bug a real
 * user hit live: typing normally threw repeated "already exists" errors,
 * and a block they had actually typed was silently lost. See noteSync.ts
 * for the full account of why.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocksChanged, createSaveGate, shouldReloadVisibleContent } from '../src/lib/noteSync.js';

const block = (over: Partial<Parameters<typeof blocksChanged>[0][number]> = {}) => ({
  id: 'a',
  markdown: 'text',
  type: 'prose',
  locked: false,
  figureId: null,
  targetSectionId: null,
  ...over,
});

// ---------------------------------------------------------------------------
// blocksChanged
// ---------------------------------------------------------------------------

test('identical block lists report no change', () => {
  assert.equal(blocksChanged([block()], [block()]), false);
});

test('a different block count is a change', () => {
  assert.equal(blocksChanged([block()], [block(), block({ id: 'b' })]), true);
});

test('a reorder is a change even though every block is otherwise identical', () => {
  const a = block({ id: 'a' });
  const b = block({ id: 'b' });
  assert.equal(blocksChanged([a, b], [b, a]), true);
});

test('edited markdown is a change', () => {
  assert.equal(blocksChanged([block({ markdown: 'old' })], [block({ markdown: 'new' })]), true);
});

test('a lock toggle is a change even with identical text', () => {
  assert.equal(blocksChanged([block({ locked: false })], [block({ locked: true })]), true);
});

test('two empty lists report no change', () => {
  assert.equal(blocksChanged([], []), false);
});

// ---------------------------------------------------------------------------
// shouldReloadVisibleContent
// ---------------------------------------------------------------------------

test('a section never loaded before always reloads', () => {
  assert.equal(
    shouldReloadVisibleContent({
      alreadyLoadedThisSection: false,
      hasUnsavedLocalEdits: true,
      serverBlocksChanged: false,
    }),
    true,
  );
});

test('unsaved local edits block a reload even when the server changed', () => {
  // This is the case the original guard existed to protect: Generate Notes
  // (or a restore point) changes the server's copy while someone is still
  // typing, and reloading here would erase what they haven't saved yet.
  assert.equal(
    shouldReloadVisibleContent({
      alreadyLoadedThisSection: true,
      hasUnsavedLocalEdits: true,
      serverBlocksChanged: true,
    }),
    false,
  );
});

test('a clean editor with no server change does not reload', () => {
  // This is what stops every autosave's own end-of-batch refetch from
  // resetting the cursor for a document that hasn't actually changed.
  assert.equal(
    shouldReloadVisibleContent({
      alreadyLoadedThisSection: true,
      hasUnsavedLocalEdits: false,
      serverBlocksChanged: false,
    }),
    false,
  );
});

test('a clean editor reloads once the server genuinely changed', () => {
  // This is what lets Generate Notes' output actually appear without a
  // manual page reload, once it's safe to show it.
  assert.equal(
    shouldReloadVisibleContent({
      alreadyLoadedThisSection: true,
      hasUnsavedLocalEdits: false,
      serverBlocksChanged: true,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// createSaveGate
// ---------------------------------------------------------------------------

test('a second save for the same key while one runs is queued, not run concurrently', () => {
  const gate = createSaveGate();
  assert.equal(gate.tryEnter('section-a'), true);
  assert.equal(gate.tryEnter('section-a'), false, 'a second concurrent call must not also enter');
});

test('exiting reports whether a rerun was queued, and clears the queue', () => {
  const gate = createSaveGate();
  gate.tryEnter('section-a');
  gate.tryEnter('section-a'); // queues a rerun
  assert.equal(gate.exit('section-a'), true);
  assert.equal(gate.exit('section-a'), false, 'nothing queued the second time');
});

test('two different sections never gate or rerun against each other', () => {
  // This is the exact regression: this component does not remount between
  // sections, so a save still in flight for the section just navigated away
  // from must not affect the one just navigated to.
  const gate = createSaveGate();
  assert.equal(gate.tryEnter('section-a'), true);
  assert.equal(gate.tryEnter('section-b'), true, 'a different section must enter freely');
  assert.equal(gate.exit('section-b'), false);
  assert.equal(gate.exit('section-a'), false);
});

test('a fresh save for a key can enter again once the previous one exited', () => {
  const gate = createSaveGate();
  gate.tryEnter('section-a');
  gate.exit('section-a');
  assert.equal(gate.tryEnter('section-a'), true);
});
