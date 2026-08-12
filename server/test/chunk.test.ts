import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkBlocks } from '../src/ingest/chunk.js';

test('a chunk never spans two pages', () => {
  const chunks = chunkBlocks([
    { text: 'Short text on page one.', pageNo: 1 },
    { text: 'Short text on page two.', pageNo: 2 },
  ]);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.pageNo, 1);
  assert.equal(chunks[1]?.pageNo, 2);
});

test('blocks on the same page are merged into one chunk', () => {
  const chunks = chunkBlocks([
    { text: 'First paragraph.', pageNo: 3, slideNo: 3 },
    { text: 'Second paragraph.', pageNo: 3, slideNo: 3 },
  ]);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.text, /First paragraph/);
  assert.match(chunks[0]!.text, /Second paragraph/);
  assert.equal(chunks[0]?.slideNo, 3);
});

test('timestamped blocks are never merged, so a citation stays truthful', () => {
  const chunks = chunkBlocks([
    { text: 'Talking about the resting potential.', timestamp: 5 },
    { text: 'Much later, talking about myelination.', timestamp: 2060 },
  ]);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.timestamp, 5);
  assert.equal(chunks[1]?.timestamp, 2060);
  assert.doesNotMatch(chunks[0]!.text, /myelination/);
});

test('long text is split with overlap and keeps its page number', () => {
  const sentence = 'The sodium potassium ATPase maintains the electrochemical gradient. ';
  const chunks = chunkBlocks([{ text: sentence.repeat(80), pageNo: 7 }]);

  assert.ok(chunks.length > 1, 'expected the text to be split');
  assert.ok(
    chunks.every((chunk) => chunk.pageNo === 7),
    'every piece should still cite page 7',
  );
  // Positions must be dense and ordered, since they drive display order.
  assert.deepEqual(
    chunks.map((chunk) => chunk.position),
    chunks.map((_, i) => i),
  );
});

test('splitting always terminates and loses no content', () => {
  // A single unbroken token longer than the target has no natural boundary,
  // which is exactly the case that can loop forever if progress is not forced.
  const chunks = chunkBlocks([{ text: 'x'.repeat(5000), pageNo: 1 }]);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length > 0));
});

test('empty and whitespace-only blocks are dropped', () => {
  const chunks = chunkBlocks([
    { text: '   ', pageNo: 1 },
    { text: '', pageNo: 2 },
    { text: 'Real content.', pageNo: 3 },
  ]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.pageNo, 3);
});
