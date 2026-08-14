/**
 * Round-trip tests for the document/block bridge.
 *
 * These matter more than most: this code runs on every keystroke-triggered
 * save, and a bug here does not crash anything — it quietly rewrites your notes
 * into something slightly wrong, over and over, until you notice weeks later.
 * So the property under test is that stored markdown survives a trip through
 * the editor unchanged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blocksToDoc,
  docToBlocks,
  type BlockType,
  type StoredBlock,
} from '../src/lib/blockMarkdown.js';

/** Storage → editor → storage, which is exactly what an idle edit session does. */
function roundTrip(blocks: StoredBlock[]) {
  return docToBlocks(blocksToDoc(blocks));
}

const block = (type: BlockType, markdown: string, id = `id-${type}`): StoredBlock => ({
  id,
  type,
  markdown,
});

test('a heading keeps its level and text', () => {
  const result = roundTrip([block('heading', '## Establishing the resting potential')]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.type, 'heading');
  assert.equal(result[0]?.markdown, '## Establishing the resting potential');
  assert.equal(result[0]?.blockId, 'id-heading');
});

test('headings of every level survive', () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const markdown = `${'#'.repeat(level)} Level ${level}`;
    const [result] = roundTrip([block('heading', markdown)]);
    assert.equal(result?.markdown, markdown);
  }
});

test('prose keeps its inline formatting', () => {
  const markdown =
    'The **Na+/K+ ATPase** is *electrogenic*, exporting `3 Na+` for every ~~1~~ 2 K+.';
  const [result] = roundTrip([block('prose', markdown)]);
  assert.equal(result?.type, 'prose');
  assert.equal(result?.markdown, markdown);
});

test('a bulleted list survives, including nesting', () => {
  const markdown = ['- Resting potential', '- Depolarisation', '  - Sodium influx', '  - Threshold'].join(
    '\n',
  );
  const [result] = roundTrip([block('list', markdown)]);
  assert.equal(result?.type, 'list');
  assert.equal(result?.markdown, markdown);
});

test('a numbered list stays numbered and renumbers sequentially', () => {
  const markdown = ['1. Depolarisation', '2. Repolarisation', '3. Hyperpolarisation'].join('\n');
  const [result] = roundTrip([block('list', markdown)]);
  assert.equal(result?.type, 'list');
  assert.equal(result?.markdown, markdown);
});

test('a callout stays a callout, not a plain quote', () => {
  const [result] = roundTrip([block('callout', '> Beyond the lecture: potassium leak channels.')]);
  assert.equal(result?.type, 'callout');
  assert.equal(result?.markdown, '> Beyond the lecture: potassium leak channels.');
});

test('a summary is distinguishable from a callout after the trip', () => {
  const [result] = roundTrip([block('summary', '> Three things that matter.')]);
  assert.equal(result?.type, 'summary', 'summary must not collapse into callout');
});

test('a multi-paragraph callout keeps both paragraphs', () => {
  const markdown = '> First aside.\n> Second aside.';
  const [result] = roundTrip([block('callout', markdown)]);
  assert.equal(result?.type, 'callout');
  assert.equal(result?.markdown, markdown);
});

test('a heading is never swallowed by an adjacent callout', () => {
  // The editor schema now allows only paragraphs inside a callout, because a
  // heading nested in one used to be stored as part of the quote and read back
  // as the literal text "## ...". These have to stay separate blocks.
  const blocks: StoredBlock[] = [
    block('callout', '> An aside.', 'quote'),
    block('heading', '## Ionic basis', 'head'),
  ];

  const result = roundTrip(blocks);

  assert.equal(result.length, 2);
  assert.equal(result[0]?.type, 'callout');
  assert.equal(result[1]?.type, 'heading');
  assert.equal(result[1]?.markdown, '## Ionic basis');
  assert.doesNotMatch(result[0]!.markdown, /Ionic basis/);
});

test('a mermaid diagram keeps its fence and language', () => {
  const markdown = '```mermaid\ngraph TD;\n  A-->B;\n```';
  const [result] = roundTrip([block('diagram', markdown)]);
  assert.equal(result?.type, 'diagram');
  assert.equal(result?.markdown, markdown);
});

test('a whole section of mixed blocks keeps its order and ids', () => {
  const blocks: StoredBlock[] = [
    block('heading', '## Action potentials', 'a'),
    block('prose', 'Voltage-gated channels open at threshold.', 'b'),
    block('list', '- Depolarisation\n- Repolarisation', 'c'),
    block('callout', '> Myelination speeds this up.', 'd'),
    block('summary', '> Saltatory conduction is the mechanism.', 'e'),
  ];

  const result = roundTrip(blocks);

  assert.deepEqual(
    result.map((entry) => entry.blockId),
    ['a', 'b', 'c', 'd', 'e'],
    'every block keeps its identity, which is what locking and regeneration rely on',
  );
  assert.deepEqual(
    result.map((entry) => entry.type),
    ['heading', 'prose', 'list', 'callout', 'summary'],
  );
  assert.deepEqual(
    result.map((entry) => entry.markdown),
    blocks.map((entry) => entry.markdown),
  );
});

test('empty blocks are dropped rather than stored', () => {
  const result = docToBlocks({
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { blockId: 'keep' }, content: [{ type: 'text', text: 'Real.' }] },
      { type: 'paragraph', attrs: { blockId: 'drop' } },
      { type: 'paragraph', attrs: { blockId: 'drop2' }, content: [{ type: 'text', text: '   ' }] },
    ],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.blockId, 'keep');
});

test('a newly typed node has no id yet, so the editor knows to create one', () => {
  const result = docToBlocks({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just typed.' }] }],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.blockId, null);
});

test('an empty document still produces a valid editor document', () => {
  const doc = blocksToDoc([]);
  assert.equal(doc.type, 'doc');
  assert.ok((doc.content?.length ?? 0) > 0, 'ProseMirror rejects an empty doc');
});

test('a paragraph split across lines becomes separate blocks', () => {
  // Only the first keeps the original id; the rest are new blocks, which is the
  // honest reading of "this was split in two".
  const result = roundTrip([block('prose', 'First thought.\nSecond thought.', 'original')]);

  assert.equal(result.length, 2);
  assert.equal(result[0]?.blockId, 'original');
  assert.equal(result[1]?.blockId, null);
});

test('markdown characters in ordinary prose are not mangled', () => {
  // A lone asterisk or backtick should come back exactly as written.
  const markdown = 'The 5* rating and the C* pathway cost 3 * 4 units.';
  const [result] = roundTrip([block('prose', markdown)]);
  assert.equal(result?.markdown, markdown);
});
