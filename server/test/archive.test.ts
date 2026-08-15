/**
 * Export and restore.
 *
 * The test that matters is the one a real backup has to survive: export a
 * module, destroy the database and the media folder completely, and bring it
 * back. Anything less — restoring alongside the original, or checking only row
 * counts — would pass while leaving the thing unusable in the case you actually
 * need it for.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-archive-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';

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

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

function multipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; body: Buffer },
) {
  const boundary = `----archivetest${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; ` +
        `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.body,
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function ingestAndWait(sourceId: string) {
  await app.inject({ method: 'POST', url: `/api/sources/${sourceId}/ingest` });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = json<{ phase: string }>(
      await app.inject({ method: 'GET', url: `/api/sources/${sourceId}/ingest` }),
    );
    if (job.phase === 'done' || job.phase === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('ingest did not finish');
}

test('a module survives export, total data loss, and restore', async () => {
  // --- build a module with everything in it -------------------------------
  const moduleId = json<{ id: string }>(
    await app.inject({
      method: 'POST',
      url: '/api/modules',
      payload: { title: 'Neuroscience', code: 'PA20345' },
    }),
  ).id;

  const tree = json<Array<{ id: string; title: string; children: unknown[] }>>(
    await app.inject({
      method: 'PUT',
      url: `/api/modules/${moduleId}/sections`,
      payload: {
        tree: [
          { title: 'The Brain', children: [{ title: 'Cortical layers' }] },
          { title: 'Neurotransmission' },
        ],
      },
    }),
  );
  const sectionId = tree[0]!.id;

  const upload = multipart(
    { type: 'slides', title: 'L07' },
    {
      field: 'file',
      filename: 'l07.pdf',
      contentType: 'application/pdf',
      body: fs.readFileSync(path.join(FIXTURES, 'lecture-07-action-potentials.pdf')),
    },
  );
  const sourceId = json<{ id: string }>(
    await app.inject({
      method: 'POST',
      url: `/api/modules/${moduleId}/sources`,
      payload: upload.payload,
      headers: upload.headers,
    }),
  ).id;
  await ingestAndWait(sourceId);

  await app.inject({
    method: 'POST',
    url: `/api/sections/${sectionId}/notes`,
    payload: { type: 'prose', markdown: 'A note I wrote myself, which must survive.' },
  });

  const before = json<{ figures: Array<{ url: string }>; chunkCount: number }>(
    await app.inject({ method: 'GET', url: `/api/sources/${sourceId}` }),
  );
  assert.ok(before.chunkCount > 0);
  assert.ok(before.figures.length > 0);
  const figureUrl = before.figures[0]!.url;

  // --- export --------------------------------------------------------------
  const exported = await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/export` });
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers['content-disposition'] as string, /\.processor\.zip"$/);

  const archive = exported.rawPayload;
  // A real zip, openable without this program.
  assert.equal(archive.subarray(0, 2).toString(), 'PK');

  // --- destroy everything --------------------------------------------------
  await app.inject({ method: 'DELETE', url: `/api/modules/${moduleId}` });
  fs.rmSync(path.join(tempDir, 'media'), { recursive: true, force: true });

  assert.equal(
    json<unknown[]>(await app.inject({ method: 'GET', url: '/api/modules' })).length,
    0,
    'the module should be gone before restoring',
  );

  // --- restore -------------------------------------------------------------
  const restore = multipart(
    {},
    {
      field: 'file',
      filename: 'backup.processor.zip',
      contentType: 'application/zip',
      body: Buffer.from(archive),
    },
  );
  const restored = await app.inject({
    method: 'POST',
    url: '/api/modules/import',
    payload: restore.payload,
    headers: restore.headers,
  });
  assert.equal(restored.statusCode, 200);

  const result = json<{
    moduleId: string;
    remapped: boolean;
    missingFiles: string[];
    chunks: number;
    noteBlocks: number;
  }>(restored);

  assert.equal(result.moduleId, moduleId, 'a clean restore keeps the original identifiers');
  assert.equal(result.remapped, false);
  assert.deepEqual(result.missingFiles, []);

  // --- everything is actually back -----------------------------------------
  const module = json<{ title: string; sections: Array<{ number: string; title: string }> }>(
    await app.inject({ method: 'GET', url: `/api/modules/${moduleId}` }),
  );
  assert.equal(module.title, 'Neuroscience');
  assert.equal(module.sections.length, 2);

  const chunks = json<Array<{ location: string }>>(
    await app.inject({ method: 'GET', url: `/api/sources/${sourceId}/chunks` }),
  );
  assert.ok(chunks.length > 0);
  assert.match(chunks[0]!.location, /slide \d/, 'citations survive');

  const notes = json<Array<{ markdown: string; origin: string }>>(
    await app.inject({ method: 'GET', url: `/api/sections/${sectionId}/notes` }),
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.markdown, /must survive/);
  assert.equal(notes[0]!.origin, 'user_written', 'your authorship survives');

  // The extracted image is back on disk and served, not just referenced.
  const image = await app.inject({ method: 'GET', url: figureUrl });
  assert.equal(image.statusCode, 200);
  assert.equal(image.rawPayload.subarray(1, 4).toString(), 'PNG');

  // Search still works, so the embeddings came back rather than needing a model.
  const hits = json<Array<{ kind: string }>>(
    await app.inject({ method: 'GET', url: `/api/search?q=ATPase&moduleId=${moduleId}` }),
  );
  assert.ok(hits.length > 0, 'restored content is searchable');
});

test('restoring over an existing module duplicates rather than overwrites', async () => {
  const moduleId = json<{ id: string }>(
    await app.inject({
      method: 'POST',
      url: '/api/modules',
      payload: { title: 'Biochemistry' },
    }),
  ).id;

  const archive = (await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/export` }))
    .rawPayload;

  const restore = multipart(
    {},
    {
      field: 'file',
      filename: 'again.zip',
      contentType: 'application/zip',
      body: Buffer.from(archive),
    },
  );
  const result = json<{ moduleId: string; remapped: boolean }>(
    await app.inject({
      method: 'POST',
      url: '/api/modules/import',
      payload: restore.payload,
      headers: restore.headers,
    }),
  );

  // Never merge into the existing module: a duplicate can be deleted, a silent
  // overwrite cannot be undone.
  assert.equal(result.remapped, true);
  assert.notEqual(result.moduleId, moduleId);

  const titles = json<Array<{ title: string }>>(
    await app.inject({ method: 'GET', url: '/api/modules' }),
  ).map((row) => row.title);
  assert.ok(titles.includes('Biochemistry'));
  assert.ok(titles.includes('Biochemistry (restored)'));
});

test('a file that is not an export is rejected clearly', async () => {
  const junk = multipart(
    {},
    {
      field: 'file',
      filename: 'notes.txt',
      contentType: 'text/plain',
      body: Buffer.from('this is not a zip'),
    },
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/modules/import',
    payload: junk.payload,
    headers: junk.headers,
  });

  assert.equal(response.statusCode, 422);
  assert.match(json<{ error: string }>(response).error, /not a readable Processor export/);
});
