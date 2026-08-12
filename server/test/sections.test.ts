import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, initDb, schema } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { repoRoot } from '../src/config.js';
import {
  createSection,
  deleteSection,
  flatten,
  getTree,
  moveSection,
  replaceTree,
} from '../src/services/sections.js';

let tempDir: string;
let moduleId: string;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-sections-'));
  initDb({
    dbPath: path.join(tempDir, 'test.db'),
    migrationsFolder: path.join(repoRoot, 'server/migrations'),
  });
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.delete(schema.modules).run();
  moduleId = newId();
  db.insert(schema.modules).values({ id: moduleId, title: 'Neuroscience' }).run();
});

/** The tree from the spec, so the numbering assertions mean something. */
function seed() {
  return replaceTree(moduleId, [
    {
      title: 'The Brain',
      children: [
        { title: 'Gross anatomy and organisation' },
        {
          title: 'The cerebral cortex',
          children: [{ title: 'Cortical layers' }, { title: 'Functional areas' }],
        },
      ],
    },
    { title: 'The Spinal Cord', children: [{ title: 'Structure and tracts' }] },
  ]);
}

test('numbers are derived from position, top level as N.0', () => {
  seed();
  const numbers = flatten(getTree(moduleId)).map((node) => `${node.number} ${node.title}`);

  assert.deepEqual(numbers, [
    '1.0 The Brain',
    '1.1 Gross anatomy and organisation',
    '1.2 The cerebral cortex',
    '1.2.1 Cortical layers',
    '1.2.2 Functional areas',
    '2.0 The Spinal Cord',
    '2.1 Structure and tracts',
  ]);
});

test('reordering renumbers the display without changing any id', () => {
  seed();
  const before = flatten(getTree(moduleId));
  const spinalCord = before.find((node) => node.title === 'The Spinal Cord')!;
  const cortex = before.find((node) => node.title === 'The cerebral cortex')!;

  moveSection(spinalCord.id, null, 0);

  const after = flatten(getTree(moduleId));
  const movedSpinalCord = after.find((node) => node.id === spinalCord.id)!;
  const movedCortex = after.find((node) => node.id === cortex.id)!;

  assert.equal(movedSpinalCord.number, '1.0', 'the moved section takes the first slot');
  assert.equal(movedCortex.number, '2.2', 'everything below it renumbers');
  // Identity is the UUID: a link to the cortex section still resolves.
  assert.equal(movedCortex.id, cortex.id);
  assert.equal(movedCortex.title, 'The cerebral cortex');
});

test('a section cannot be moved inside its own subtree', () => {
  seed();
  const nodes = flatten(getTree(moduleId));
  const brain = nodes.find((node) => node.title === 'The Brain')!;
  const corticalLayers = nodes.find((node) => node.title === 'Cortical layers')!;

  assert.throws(() => moveSection(brain.id, corticalLayers.id, 0), /cannot be moved inside itself/);
  // And the tree is unchanged by the rejected move.
  assert.equal(flatten(getTree(moduleId)).find((n) => n.id === brain.id)?.number, '1.0');
});

test('moving a section to a new parent keeps its children with it', () => {
  seed();
  const nodes = flatten(getTree(moduleId));
  const cortex = nodes.find((node) => node.title === 'The cerebral cortex')!;
  const spinalCord = nodes.find((node) => node.title === 'The Spinal Cord')!;

  moveSection(cortex.id, spinalCord.id, 0);

  const after = flatten(getTree(moduleId));
  const movedCortex = after.find((node) => node.id === cortex.id)!;
  assert.equal(movedCortex.number, '2.1');
  assert.deepEqual(
    movedCortex.children.map((child) => `${child.number} ${child.title}`),
    ['2.1.1 Cortical layers', '2.1.2 Functional areas'],
  );
});

test('replaceTree preserves ids for nodes it is given, so attached work survives', () => {
  seed();
  const before = flatten(getTree(moduleId));
  const brain = before.find((node) => node.title === 'The Brain')!;

  // A note block attached to the section must outlive an edit of the tree.
  getDb()
    .insert(schema.noteBlocks)
    .values({ id: newId(), sectionId: brain.id, position: 0, type: 'prose', markdown: 'Mine.' })
    .run();

  replaceTree(moduleId, [
    { id: brain.id, title: 'The Brain (revised)' },
    { title: 'Neurotransmission' },
  ]);

  const after = flatten(getTree(moduleId));
  assert.equal(after.length, 2);
  assert.equal(after[0]?.id, brain.id);
  assert.equal(after[0]?.title, 'The Brain (revised)');

  const blocks = getDb()
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, brain.id))
    .all();
  assert.equal(blocks.length, 1, 'the note block should still be attached');
});

test('deleting a parent deletes its subtree', () => {
  seed();
  const brain = flatten(getTree(moduleId)).find((node) => node.title === 'The Brain')!;

  deleteSection(brain.id);

  const remaining = flatten(getTree(moduleId)).map((node) => node.title);
  assert.deepEqual(remaining, ['The Spinal Cord', 'Structure and tracts']);
});

test('appending a section puts it last and numbers it accordingly', () => {
  seed();
  const created = createSection({ moduleId, title: 'Neurotransmission' });
  const node = flatten(getTree(moduleId)).find((n) => n.id === created.id)!;
  assert.equal(node.number, '3.0');
});

test('a section cannot be parented into a different module', () => {
  seed();
  const otherModuleId = newId();
  getDb().insert(schema.modules).values({ id: otherModuleId, title: 'Biochemistry' }).run();
  const foreign = createSection({ moduleId: otherModuleId, title: 'Glycolysis' });

  assert.throws(
    () => createSection({ moduleId, title: 'Bad child', parentId: foreign.id }),
    /different module/,
  );
});
