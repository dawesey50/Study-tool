/**
 * A student's own image, dropped straight into a section's notes.
 *
 * The figure picker before this only ever listed images the ingestion
 * pipeline had extracted from an uploaded lecture — a phone photo of a
 * whiteboard, or a pasted screenshot, had no way in at all short of first
 * ingesting it as if it were a whole lecture. This exercises the upload
 * route end to end, through the real HTTP layer, the same way a browser's
 * paste or file-picker handler will call it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-pasted-images-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';

const { buildServer } = await import('../src/index.js');
const { closeDb } = await import('../src/db/index.js');

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

async function createModuleAndSection() {
  const module = JSON.parse(
    (
      await app.inject({ method: 'POST', url: '/api/modules', payload: { title: 'Cell Signalling' } })
    ).body,
  ) as { id: string };
  const section = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/sections',
        payload: { moduleId: module.id, title: 'Receptors' },
      })
    ).body,
  ) as { id: string };
  return { moduleId: module.id, sectionId: section.id };
}

/** A 1x1 transparent PNG — small enough to inline, real enough to be a valid image. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function uploadImage(sectionId: string, buffer: Buffer, mimetype: string, filename = 'photo.png') {
  const boundary = `----processortest${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
        `filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return app.inject({
    method: 'POST',
    url: `/api/sections/${sectionId}/images`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

test('uploading an image creates a figure the section can see', async () => {
  const { sectionId } = await createModuleAndSection();

  const response = await uploadImage(sectionId, ONE_PIXEL_PNG, 'image/png');
  assert.equal(response.statusCode, 201, response.body);
  const figure = JSON.parse(response.body) as { id: string; url: string };
  assert.ok(figure.url.startsWith('/media/figures/'), figure.url);

  const list = JSON.parse(
    (await app.inject({ method: 'GET', url: `/api/sections/${sectionId}/figures` })).body,
  ) as Array<{ id: string }>;
  assert.ok(list.some((f) => f.id === figure.id));
});

test('the actual bytes are readable back from /media', async () => {
  const { sectionId } = await createModuleAndSection();
  const figure = JSON.parse((await uploadImage(sectionId, ONE_PIXEL_PNG, 'image/png')).body) as {
    url: string;
  };

  const served = await app.inject({ method: 'GET', url: figure.url });
  assert.equal(served.statusCode, 200);
  assert.ok(Buffer.from(served.rawPayload).equals(ONE_PIXEL_PNG));
});

test('a second upload to the same section reuses one pasted source, not a new one each time', async () => {
  const { sectionId, moduleId } = await createModuleAndSection();

  await uploadImage(sectionId, ONE_PIXEL_PNG, 'image/png');
  await uploadImage(sectionId, ONE_PIXEL_PNG, 'image/jpeg', 'second.jpg');

  const sources = JSON.parse(
    (await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/sources` })).body,
  ) as Array<{ type: string }>;
  assert.equal(sources.filter((s) => s.type === 'pasted').length, 1);

  const figures = JSON.parse(
    (await app.inject({ method: 'GET', url: `/api/sections/${sectionId}/figures` })).body,
  ) as unknown[];
  assert.equal(figures.length, 2);
});

test('an unsupported file type is rejected rather than stored as a mystery blob', async () => {
  const { sectionId } = await createModuleAndSection();

  const response = await uploadImage(sectionId, Buffer.from('not an image'), 'application/pdf', 'x.pdf');
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /Unsupported image type/);
});

test('a section that does not exist is a 404, not a source created for nothing', async () => {
  const response = await uploadImage('does-not-exist', ONE_PIXEL_PNG, 'image/png');
  assert.equal(response.statusCode, 404);
});

test('re-ingesting the pasted-images source is refused rather than failing confusingly', async () => {
  const { sectionId, moduleId } = await createModuleAndSection();
  await uploadImage(sectionId, ONE_PIXEL_PNG, 'image/png');

  const sources = JSON.parse(
    (await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/sources` })).body,
  ) as Array<{ id: string; type: string }>;
  const pasted = sources.find((s) => s.type === 'pasted')!;

  const response = await app.inject({ method: 'POST', url: `/api/sources/${pasted.id}/ingest` });
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /not a document to parse/);
});
