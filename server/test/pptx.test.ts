/**
 * PowerPoint ingestion.
 *
 * This format was missing, which made the system unusable for the thing it was
 * built for: university lectures arrive as .pptx, and "export thirty decks to
 * PDF by hand" is not a workaround.
 *
 * The tests are about the two ways a real deck defeats a naive parser. First,
 * slides are mostly bullet fragments and the actual teaching is in the speaker
 * notes — a parser that reads only the slide bodies gets "Oxidative
 * phosphorylation / • Fo channel / • F1 catalytic head" and nothing a concept
 * could be extracted from. Second, a deck exported as one flat image per slide
 * parses perfectly and yields nothing, which looks like success and is the
 * same failure a scanned PDF has.
 *
 * The fixtures are real zip files built by `scripts` rather than XML strings
 * assembled inline, so what is under test is a file PowerPoint would recognise.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-pptx-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';

const { parsePptx } = await import('../src/ingest/pptx.js');
const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');

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

const figureDir = () => fs.mkdtempSync(path.join(tempDir, 'figs-'));

// ---------------------------------------------------------------------------

test('a lecture deck yields one block per slide, in order', async () => {
  const result = await parsePptx(
    path.join(FIXTURES, 'lecture-04-oxidative-phosphorylation.pptx'),
    { figureDir: figureDir(), figurePrefix: 'l04' },
  );

  assert.equal(result.pageCount, 5);
  assert.equal(result.blocks.length, 5);
  assert.deepEqual(
    result.blocks.map((block) => block.slideNo),
    [1, 2, 3, 4, 5],
  );
  assert.match(result.blocks[0]!.text, /Oxidative phosphorylation/);
  assert.match(result.blocks[2]!.text, /ATP synthase/);
});

test('speaker notes are captured, because that is where the teaching is', async () => {
  const result = await parsePptx(
    path.join(FIXTURES, 'lecture-04-oxidative-phosphorylation.pptx'),
    { figureDir: figureDir(), figurePrefix: 'l04' },
  );

  const atpSynthase = result.blocks[2]!.text;

  // The slide says "• Fo channel". The notes say what that means, in
  // sentences. Without them there is nothing here a concept could be extracted
  // from, and the whole pipeline downstream reads text.
  assert.match(atpSynthase, /Fo channel/);
  assert.match(atpSynthase, /oxygen consumption falls/);
  assert.match(atpSynthase, /Speaker notes:/);

  // Labelled rather than silently merged, so a citation can say which it came
  // from — prose from the notes is different evidence from a bullet fragment.
  assert.ok(atpSynthase.indexOf('Fo channel') < atpSynthase.indexOf('Speaker notes:'));
});

test('the slide number PowerPoint puts in the notes is not treated as notes', async () => {
  const result = await parsePptx(
    path.join(FIXTURES, 'lecture-04-oxidative-phosphorylation.pptx'),
    { figureDir: figureDir(), figurePrefix: 'l04' },
  );

  // Every notes page carries the slide's own number as a placeholder. Left in,
  // every slide would gain a "Speaker notes: 3" and the last slide — which has
  // no real notes — would claim to have some.
  const summary = result.blocks[4]!.text;
  assert.ok(!summary.includes('Speaker notes:'), 'a slide with no real notes claimed to have some');
  assert.ok(!/Speaker notes:\n\d+$/m.test(result.blocks[0]!.text));
});

test('slide 10 comes after slide 9, not after slide 1', async () => {
  const result = await parsePptx(path.join(FIXTURES, 'lecture-06-ordering.pptx'), {
    figureDir: figureDir(),
    figurePrefix: 'l06',
  });

  assert.equal(result.blocks.length, 12);
  // Sorting the zip entries as strings puts slide10 between slide1 and slide2,
  // which silently scrambles a deck's teaching order — and teaching order is
  // what the hierarchy proposal and every citation depend on.
  assert.match(result.blocks[9]!.text, /Slide 10 heading/);
  assert.match(result.blocks[11]!.text, /Slide 12 heading/);
});

test('images come out, and bullet glyphs and vector files do not', async () => {
  const dir = figureDir();
  const result = await parsePptx(
    path.join(FIXTURES, 'lecture-04-oxidative-phosphorylation.pptx'),
    { figureDir: dir, figurePrefix: 'l04' },
  );

  // A deck's logos and bullet glyphs live in the same folder as its diagrams,
  // and EMF/WMF are Windows vector formats no browser renders — writing those
  // out puts broken images in the figures strip, which reads as a bug.
  assert.equal(result.figures.length, 1, 'expected only the real diagram');
  assert.ok(fs.existsSync(result.figures[0]!.absolutePath));
  assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith('.emf')));
});

test('a deck that is really just pictures says so, loudly', async () => {
  const result = await parsePptx(path.join(FIXTURES, 'lecture-05-images-only.pptx'), {
    figureDir: figureDir(),
    figurePrefix: 'l05',
  });

  // This is the failure that looks like success: the file parses, no error is
  // raised, and nothing downstream can read a word of it. It has to be
  // reported as loudly as a scanned PDF, for exactly the same reason.
  assert.equal(result.likelyScanned, true);
  assert.equal(result.blocks.length, 0);
  assert.ok(result.warnings.some((warning) => /almost no selectable text/i.test(warning)));
});

test('a terse deck with no notes warns that there is little to work with', async () => {
  const result = await parsePptx(path.join(FIXTURES, 'lecture-06-ordering.pptx'), {
    figureDir: figureDir(),
    figurePrefix: 'l06',
  });

  // Not a failure — plenty of decks are like this — but concept extraction
  // works from the words in the file, and saying so beforehand is better than
  // a thin concept list that looks like the model's fault.
  assert.equal(result.likelyScanned, undefined);
  assert.ok(result.warnings.some((warning) => /No speaker notes/i.test(warning)));
});

test('the upload route accepts .pptx', async () => {
  const moduleId = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/modules',
        payload: { title: 'PowerPoint module' },
      })
    ).body,
  ).id as string;

  const file = fs.readFileSync(
    path.join(FIXTURES, 'lecture-04-oxidative-phosphorylation.pptx'),
  );

  const boundary = '----processortest';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nLecture 4\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nslides\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
        `filename="lecture-04.pptx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/sources`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });

  // Rejecting at the door was the actual blocker: the parser could be perfect
  // and the file would never reach it.
  assert.equal(response.statusCode, 201, response.body);
  const source = JSON.parse(response.body) as { id: string };

  // Ingestion is a background job — a textbook takes minutes and holding the
  // request open would freeze the whole app.
  const started = await app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/ingest`,
  });
  assert.equal(started.statusCode, 202, started.body);

  let finished = false;
  for (let wait = 0; wait < 150 && !finished; wait++) {
    const job = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/sources/${source.id}/ingest` })).body,
    ) as { phase: string; error?: string };
    if (['done', 'failed', 'cancelled'].includes(job.phase)) {
      assert.equal(job.phase, 'done', job.error ?? job.phase);
      finished = true;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  assert.ok(finished, 'ingestion never finished');

  const chunks = getDb()
    .select()
    .from(schema.chunks)
    .where(eqSource(source.id))
    .all();
  assert.ok(chunks.length > 0, 'a PowerPoint deck produced no chunks');
  assert.ok(chunks.some((chunk) => /oxygen consumption falls/.test(chunk.text)));
});

test('the old binary .ppt is refused at the door, with the fix named', async () => {
  const moduleId = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/modules',
        payload: { title: 'Old format' },
      })
    ).body,
  ).id as string;

  const boundary = '----processortest2';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nOld deck\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nslides\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
        `filename="lecture.ppt"\r\nContent-Type: application/vnd.ms-powerpoint\r\n\r\n`,
    ),
    Buffer.from('not really a powerpoint'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/sources`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });

  // Rejected, and the message should be usable. A student with thirty .ppt
  // files needs to know the two-click fix, not that the type is unsupported.
  assert.equal(response.statusCode, 400);
  const error = JSON.parse(response.body).error as string;
  assert.match(error, /pptx/i, `unhelpful message: ${error}`);
});

const { eq } = await import('drizzle-orm');
function eqSource(sourceId: string) {
  return eq(schema.chunks.sourceId, sourceId);
}
