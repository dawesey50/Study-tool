/**
 * An oversized pasted image used to leave a truncated file behind under
 * figures/<sourceId>/ with no figures row ever pointing at it — nothing
 * would ever find or clean it up again. `written` (the flag the catch
 * block's cleanup checked) was only set *after* the truncation check, so
 * the file that had already been written by then was never removed.
 *
 * A dedicated file and server instance, because the upload size limit is
 * fixed at multipart-registration time — it has to be small before
 * buildServer() runs, which would affect every other pasted-image test if
 * done in the same process.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-oversized-image-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';
process.env.MAX_UPLOAD_MB = '0.001'; // ~1KB — small enough for a real image to exceed easily

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

function uploadImage(sectionId: string, buffer: Buffer) {
  const boundary = `----processortest${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
        `filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
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

test('an oversized pasted image is rejected and leaves nothing behind on disk', async () => {
  const module = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/modules', payload: { title: 'Oversized' } })).body,
  ) as { id: string };
  const section = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/sections',
        payload: { moduleId: module.id, title: 'Oversized Section' },
      })
    ).body,
  ) as { id: string };

  const bigBuffer = Buffer.alloc(20_000, 1); // comfortably over the ~1KB limit
  const response = await uploadImage(section.id, bigBuffer);
  assert.equal(response.statusCode, 413, response.body);

  // No figure was ever recorded...
  const figures = JSON.parse(
    (await app.inject({ method: 'GET', url: `/api/sections/${section.id}/figures` })).body,
  ) as unknown[];
  assert.equal(figures.length, 0);

  // ...and nothing was left behind under its would-be source's figures folder.
  const sources = JSON.parse(
    (await app.inject({ method: 'GET', url: `/api/modules/${module.id}/sources` })).body,
  ) as Array<{ id: string; type: string }>;
  for (const source of sources.filter((s) => s.type === 'pasted')) {
    const dir = path.join(tempDir, 'media', 'figures', source.id);
    const leftover = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(leftover, [], `expected no leftover files in ${dir}, found ${leftover}`);
  }
});
