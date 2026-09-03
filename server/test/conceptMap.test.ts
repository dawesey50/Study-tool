/**
 * The concept map — §10.
 *
 * The map is a picture of `concept_links`, and a picture is exactly where a
 * quiet data error becomes invisible. So the tests here are about the things
 * that would make the drawing lie: an edge counted twice, an edge pointing at
 * a node that is not on the map, or a section reported as isolated when it is
 * not.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-map-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { newId } = await import('../src/lib/ids.js');
const { conceptMap } = await import('../src/services/conceptMap.js');
const { recordReview } = await import('../src/services/schedule.js');

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

async function makeModule(title: string) {
  const db = getDb();
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title } }),
  ).id;

  const tree = json<Array<{ id: string }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: {
        tree: [{ title: 'Bioenergetics' }, { title: 'Enzymes' }, { title: 'Membranes' }],
      },
    }),
  );
  const sectionIds = tree.map((node) => node.id);

  const conceptIds: Record<string, string[]> = {};
  for (const sectionId of sectionIds) {
    conceptIds[sectionId] = [];
    for (let index = 0; index < 3; index++) {
      const id = newId();
      db.insert(schema.concepts)
        .values({
          id,
          sectionId,
          statement: `Concept ${index} of ${sectionId}`,
          type: 'fact',
          examinableFlag: index === 0,
        })
        .run();
      conceptIds[sectionId]!.push(id);
    }
  }

  return { moduleId, sectionIds, conceptIds };
}

function link(from: string, to: string) {
  getDb()
    .insert(schema.conceptLinks)
    .values({ fromConceptId: from, toConceptId: to, type: 'duplicate', note: null })
    .run();
}

// ---------------------------------------------------------------------------

test('a link recorded in both directions is drawn once', async () => {
  const { moduleId, sectionIds, conceptIds } = await makeModule('Both directions');
  const a = conceptIds[sectionIds[0]!]![0]!;
  const b = conceptIds[sectionIds[1]!]![0]!;

  // Ownership assignment records the match from both ends.
  link(a, b);
  link(b, a);

  const map = conceptMap(moduleId);

  // Drawing both would double every line on the map and double the degree of
  // every node, which is the number the whole view is sorted by.
  assert.equal(map.edges.length, 1);
  assert.equal(map.nodes.find((node) => node.id === a)!.degree, 1);
  assert.equal(map.nodes.find((node) => node.id === b)!.degree, 1);
});

test('a link to a concept outside the module is not drawn', async () => {
  const { moduleId, sectionIds, conceptIds } = await makeModule('Dangling');
  const other = await makeModule('Elsewhere');

  const mine = conceptIds[sectionIds[0]!]![0]!;
  link(mine, other.conceptIds[other.sectionIds[0]!]![0]!);

  const map = conceptMap(moduleId);

  // A line to a node that is not on the map is a line going nowhere.
  assert.equal(map.edges.length, 0);
  assert.equal(map.nodes.find((node) => node.id === mine)!.degree, 0);
});

test('cross-section links are marked as such', async () => {
  const { moduleId, sectionIds, conceptIds } = await makeModule('Cross');
  const within = conceptIds[sectionIds[0]!]!;
  link(within[0]!, within[1]!);
  link(within[0]!, conceptIds[sectionIds[1]!]![0]!);

  const map = conceptMap(moduleId);

  // The map defaults to showing only cross-section links, because those are
  // the ones that say something about the module's shape.
  assert.equal(map.edges.length, 2);
  assert.equal(map.edges.filter((edge) => edge.crossSection).length, 1);
});

test('a section whose only links are internal counts as isolated', async () => {
  const { moduleId, sectionIds, conceptIds } = await makeModule('Isolated');

  // Bioenergetics and Enzymes are joined; Membranes only links to itself.
  link(conceptIds[sectionIds[0]!]![0]!, conceptIds[sectionIds[1]!]![0]!);
  link(conceptIds[sectionIds[2]!]![0]!, conceptIds[sectionIds[2]!]![1]!);

  const map = conceptMap(moduleId);

  // A section that only talks to itself is exactly the case worth surfacing:
  // bridge questions are sampled across sections and there is nothing here to
  // bridge to.
  assert.equal(map.isolatedSections.length, 1);
  assert.match(map.isolatedSections[0]!, /Membranes/);
});

test('mastery is shown only where it has been measured', async () => {
  const { moduleId, sectionIds, conceptIds } = await makeModule('Mastery');
  const reviewed = conceptIds[sectionIds[0]!]![0]!;
  recordReview({ conceptIds: [reviewed], correct: true, confidence: 5 });

  const map = conceptMap(moduleId);

  const seen = map.nodes.find((node) => node.id === reviewed)!;
  const unseen = map.nodes.find((node) => node.id === conceptIds[sectionIds[0]!]![1]!)!;

  assert.ok(seen.mastery !== null && seen.mastery > 0);
  // Null rather than zero: never tested is unknown, not known to be nothing,
  // and a zero would draw identically to a concept you keep getting wrong.
  assert.equal(unseen.mastery, null);
});

test('a module with no concepts returns an empty map rather than failing', async () => {
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title: 'Empty' } }),
  ).id;

  const map = conceptMap(moduleId);
  assert.deepEqual(map.nodes, []);
  assert.deepEqual(map.edges, []);
  assert.deepEqual(map.isolatedSections, []);
});

test('the route returns the map with its sections in display order', async () => {
  const { moduleId, sectionIds, conceptIds } = await makeModule('Route');
  link(conceptIds[sectionIds[0]!]![0]!, conceptIds[sectionIds[1]!]![0]!);

  const map = json<{
    nodes: Array<{ sectionIndex: number }>;
    sections: Array<{ index: number; concepts: number }>;
  }>(await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/map` }));

  assert.equal(map.nodes.length, 9);
  assert.equal(map.sections.length, 3);
  // Index drives both the layout arc and the colour, so it has to match
  // display order or the legend disagrees with the drawing.
  assert.deepEqual(
    map.sections.map((section) => section.index),
    [0, 1, 2],
  );
  assert.ok(map.sections.every((section) => section.concepts === 3));
});
