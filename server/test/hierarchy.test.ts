/**
 * Proposing a section hierarchy — §4's default flow.
 *
 * The test that matters most here is not that a proposal comes back. It is
 * that applying one is a separate, deliberate act which says beforehand what
 * it would destroy.
 *
 * `replaceTree` deletes any section absent from what it is given, along with
 * every note inside it. A hierarchy that arrived from a model and rearranged a
 * term's work by itself would be the single most destructive thing in this
 * system — worse than a bad generation run, because a restore point is taken
 * before generation and nothing would have been taken before this.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { eq } from 'drizzle-orm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-hierarchy-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';
process.env.LLM_MODEL_HIERARCHY = 'claude-sonnet-5';
process.env.LLM_MONTHLY_CAP_GBP = '1000';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { setStub, resetStub, stubCalls } = await import('../src/llm/providers/stub.js');
const { newId } = await import('../src/lib/ids.js');
const { outlineOf, proposeHierarchy, notesAtRisk } = await import('../src/services/hierarchy.js');
const { flatten, getTree } = await import('../src/services/sections.js');
const { createBlock, listBlocks } = await import('../src/services/notes.js');

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

const PROPOSAL = JSON.stringify({
  sections: [
    {
      title: 'Bioenergetics',
      rationale: 'Lectures 1–3 all build towards the proton motive force.',
      children: [
        { title: 'Glycolysis', rationale: 'Lecture 1.' },
        { title: 'Oxidative phosphorylation', rationale: 'Lectures 2 and 3.' },
      ],
    },
    { title: 'Enzyme kinetics', rationale: 'Lecture 4 stands alone.' },
  ],
});

async function makeModule(title: string, options: { sources?: boolean } = { sources: true }) {
  const db = getDb();
  const moduleId = json<{ id: string }>(
    await app.inject({ method: 'POST', url: '/api/modules', payload: { title } }),
  ).id;

  if (options.sources) {
    for (const [index, source] of [
      { title: 'L01 Glycolysis', date: '2026-01-06' },
      { title: 'L02 The electron transport chain', date: '2026-01-13' },
      { title: 'L03 ATP synthase', date: '2026-01-20' },
      { title: 'L04 Enzyme kinetics', date: '2026-01-27' },
    ].entries()) {
      const sourceId = newId();
      db.insert(schema.sources)
        .values({
          id: sourceId,
          moduleId,
          type: 'slides',
          title: source.title,
          filename: `l0${index + 1}.pdf`,
          path: `media/sources/l0${index + 1}.pdf`,
          lectureDate: source.date,
          status: 'ingested',
        })
        .run();

      db.insert(schema.chunks)
        .values({
          id: newId(),
          sourceId,
          text: `${source.title}\nLearning outcomes\nDescribe the pathway and its regulation in detail, with reference to the tissues involved.\nThe committed step`,
          position: 0,
          slideNo: 1,
        })
        .run();
    }
  }

  return { moduleId };
}

// ---------------------------------------------------------------------------
// The outline it sends
// ---------------------------------------------------------------------------

test('the outline keeps headings and drops body prose', () => {
  const outline = outlineOf([
    {
      text: [
        'Oxidative phosphorylation',
        'The electron transport chain couples oxidation to proton pumping across the inner membrane, and this sentence is body prose.',
        'Learning outcomes',
        'a',
        'Chemiosmotic coupling',
        'Oxidative phosphorylation',
      ].join('\n'),
    },
  ]);

  assert.ok(outline.includes('Oxidative phosphorylation'));
  assert.ok(outline.includes('Chemiosmotic coupling'));
  // Body prose ends in a full stop and runs long; a heading does neither.
  assert.ok(!outline.some((line) => line.includes('body prose')));
  // Too short to be a heading, and duplicates add nothing.
  assert.ok(!outline.includes('a'));
  assert.equal(outline.filter((line) => line === 'Oxidative phosphorylation').length, 1);
});

test('the outline is bounded, so a textbook does not become the prompt', () => {
  const chunks = Array.from({ length: 50 }, (_, index) => ({
    text: Array.from({ length: 20 }, (_, line) => `Heading ${index}-${line}`).join('\n'),
  }));
  const outline = outlineOf(chunks);
  // A module's structure is visible in its titles. Sending the corpus would
  // cost pounds a proposal and risk the token ceiling on any module with a
  // textbook in it.
  assert.ok(outline.length <= 12, `${outline.length} lines`);
});

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

test('a proposal is returned as data, and nothing is applied', async () => {
  const { moduleId } = await makeModule('Proposal');
  setStub({ respond: () => PROPOSAL });

  const proposal = await proposeHierarchy({ moduleId });

  assert.equal(proposal.sections.length, 2);
  assert.equal(proposal.sections[0]!.title, 'Bioenergetics');
  assert.equal(proposal.sections[0]!.children?.length, 2);
  assert.ok(proposal.sections[0]!.rationale, 'a proposal you cannot judge is not a proposal');

  // The whole point of the split. Nothing has changed yet.
  assert.equal(flatten(getTree(moduleId)).length, 0);
});

test('past papers are not used to shape the hierarchy', async () => {
  const { moduleId } = await makeModule('Papers excluded');
  const db = getDb();

  const sourceId = newId();
  db.insert(schema.sources)
    .values({
      id: sourceId,
      moduleId,
      type: 'past_paper',
      title: 'BB20001 2025 paper',
      filename: 'paper.pdf',
      path: 'media/sources/paper.pdf',
      status: 'ingested',
    })
    .run();
  db.insert(schema.chunks)
    .values({ id: newId(), sourceId, text: 'Answer ALL questions\nSection A', position: 0 })
    .run();

  setStub({ respond: () => PROPOSAL });
  const proposal = await proposeHierarchy({ moduleId });

  // A paper says what was examined, not how the module was taught, and a
  // hierarchy built from one comes out shaped like an exam paper.
  assert.ok(!proposal.sourcesConsidered.some((source) => source.type === 'past_paper'));
  assert.equal(proposal.sourcesConsidered.length, 4);

  const prompt = stubCalls()[0]!.prompt;
  assert.ok(!prompt.includes('Answer ALL questions'));
  assert.ok(prompt.includes('L01 Glycolysis'));
});

test('material is offered in teaching order', async () => {
  const { moduleId } = await makeModule('Ordering');
  setStub({ respond: () => PROPOSAL });
  await proposeHierarchy({ moduleId });

  const prompt = stubCalls()[0]!.prompt;
  // The order material was taught in is the order it will be examined in, and
  // it is information the titles alone do not carry.
  assert.ok(
    prompt.indexOf('L01 Glycolysis') < prompt.indexOf('L04 Enzyme kinetics'),
    'sources were not offered in date order',
  );
});

test('proposing with no material says which step is missing', async () => {
  const { moduleId } = await makeModule('Empty', { sources: false });
  setStub({ respond: () => PROPOSAL });

  await assert.rejects(
    () => proposeHierarchy({ moduleId }),
    // The structure is read off the material rather than invented, so there is
    // nothing honest to propose.
    /upload|material/i,
  );
});

test('existing sections are offered back and marked when kept', async () => {
  const { moduleId } = await makeModule('Existing');
  await app.inject({
    method: 'PUT',
    url: `/api/modules/${moduleId}/sections`,
    payload: { tree: [{ title: 'Enzyme kinetics' }, { title: 'Something else entirely' }] },
  });

  setStub({ respond: () => PROPOSAL });
  const proposal = await proposeHierarchy({ moduleId });

  const kinetics = proposal.sections.find((section) => section.title === 'Enzyme kinetics');
  assert.equal(kinetics?.existing, true, 'a section that survives should say so');

  // Named up front, because applying would delete it and the notes in it.
  assert.deepEqual(proposal.wouldRemove, ['Something else entirely']);

  const prompt = stubCalls()[0]!.prompt;
  assert.ok(prompt.includes('Something else entirely'), 'the model was not told what exists');
});

// ---------------------------------------------------------------------------
// Applying — the destructive half
// ---------------------------------------------------------------------------

test('applying says what notes it would destroy before it does', async () => {
  const { moduleId } = await makeModule('At risk');
  const tree = json<Array<{ id: string; title: string }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: { tree: [{ title: 'Enzyme kinetics' }, { title: 'A section I wrote in' }] },
    }),
  );
  const doomed = tree.find((node) => node.title === 'A section I wrote in')!;

  createBlock({
    sectionId: doomed.id,
    type: 'prose',
    markdown: 'Notes I wrote by hand and would be very annoyed to lose.',
    origin: 'user_written',
  });

  const sections = [{ title: 'Bioenergetics' }, { title: 'Enzyme kinetics' }];

  const preview = json<{ atRisk: Array<{ sectionPath: string; blocks: number }> }>(
    await app.inject({
      method: 'POST',
      url: `/api/modules/${moduleId}/hierarchy/preview`,
      payload: { sections },
    }),
  );

  // Warning in the abstract is not a warning. It names the section and how
  // much is in it, because that is what decides whether you press the button.
  assert.equal(preview.atRisk.length, 1);
  assert.match(preview.atRisk[0]!.sectionPath, /A section I wrote in/);
  assert.equal(preview.atRisk[0]!.blocks, 1);

  // And it is still there — previewing changes nothing.
  assert.equal(listBlocks(doomed.id).length, 1);
  assert.equal(flatten(getTree(moduleId)).length, 2);
});

test('applying a proposal builds the tree', async () => {
  const { moduleId } = await makeModule('Applying');

  const applied = json<Array<{ title: string; children: Array<{ title: string }> }>>(
    await app.inject({
      method: 'POST',
      url: `/api/modules/${moduleId}/hierarchy/apply`,
      payload: {
        sections: [
          {
            title: 'Bioenergetics',
            children: [{ title: 'Glycolysis' }, { title: 'Oxidative phosphorylation' }],
          },
          { title: 'Enzyme kinetics' },
        ],
      },
    }),
  );

  assert.equal(applied.length, 2);
  assert.equal(applied[0]!.children.length, 2);

  const nodes = flatten(getTree(moduleId));
  assert.equal(nodes.length, 4);
  // Numbering is derived from position, so a nested proposal has to come out
  // numbered as one.
  assert.ok(nodes.some((node) => node.number === '1.1'));
});

test('a section kept by the proposal keeps its notes', async () => {
  const { moduleId } = await makeModule('Preserved');
  const tree = json<Array<{ id: string; title: string }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: { tree: [{ title: 'Enzyme kinetics' }] },
    }),
  );
  const kept = tree[0]!;

  createBlock({
    sectionId: kept.id,
    type: 'prose',
    markdown: 'Km is the substrate concentration at half Vmax.',
    origin: 'user_written',
  });

  await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/hierarchy/apply`,
    payload: { sections: [{ title: 'Bioenergetics' }, { title: 'Enzyme kinetics' }] },
  });

  // The section survives by title, so the work inside it must survive too —
  // otherwise "keep any that still fit" would be a lie.
  const nodes = flatten(getTree(moduleId));
  const survivor = nodes.find((node) => node.title === 'Enzyme kinetics')!;
  assert.equal(survivor.id, kept.id, 'the section was recreated rather than kept');
  const blocks = listBlocks(kept.id);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.markdown, /half Vmax/);
});

test('an empty proposal is refused rather than emptying the module', async () => {
  const { moduleId } = await makeModule('Empty apply');
  await app.inject({
    method: 'PUT',
    url: `/api/modules/${moduleId}/sections`,
    payload: { tree: [{ title: 'Something' }] },
  });

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/hierarchy/apply`,
    payload: { sections: [] },
  });

  // A model that returned nothing would otherwise delete the whole module.
  assert.equal(response.statusCode, 400);
  assert.equal(flatten(getTree(moduleId)).length, 1);
});

test('notesAtRisk ignores sections that are empty anyway', async () => {
  const { moduleId } = await makeModule('Empty sections');
  await app.inject({
    method: 'PUT',
    url: `/api/modules/${moduleId}/sections`,
    payload: { tree: [{ title: 'Never written in' }] },
  });

  // Losing an empty section is not a loss, and warning about it would train
  // you to click through the warning that matters.
  assert.deepEqual(notesAtRisk(moduleId, [{ title: 'Something else' }]), []);
});

test('the propose route reports a spending cap as a cap', async () => {
  const { moduleId } = await makeModule('Capped');
  const capped = Object.assign(new Error('Monthly cap reached'), { name: 'MonthlyCapError' });
  setStub({ respond: () => capped });

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/hierarchy/propose`,
  });

  // 429 rather than 400: the difference between "try again" and "raise the
  // cap".
  assert.equal(response.statusCode, 429);
});
