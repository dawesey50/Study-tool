/**
 * Route-level tests: the real Fastify app, the real SQLite file, the real
 * ingestion pipeline, driven through HTTP via app.inject().
 *
 * Only two things are substituted. The database and media folder point at a
 * temporary directory, and embeddings use the deterministic offline provider so
 * the suite never needs to download a model. Everything else — multipart
 * upload, PDF parsing, figure extraction, chunking, mapping — is the code that
 * runs in production.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
const PDF = path.join(FIXTURES, 'lecture-07-action-potentials.pdf');
const VTT = path.join(FIXTURES, 'lecture-07-transcript.vtt');

// Config reads the environment when it is first imported, so this has to be set
// before the app module is pulled in. node:test runs each file in its own
// process, so this cannot leak into the other suites.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-api-'));
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

/** Build a multipart body by hand so uploads go through the real parser. */
function multipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; path: string },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----processortest${Date.now()}`;
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
    fs.readFileSync(file.path),
    Buffer.from('\r\n'),
  );
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

interface IngestJob {
  phase: string;
  done: number;
  total: number;
  message: string;
  result?: { chunks: number; figures: number; embedded: boolean; warnings: string[] };
  error?: string;
}

/**
 * Ingestion is a background job now, so tests start it and then follow it.
 * Polling here mirrors exactly what the browser does.
 */
async function ingestAndWait(sourceId: string, timeoutMs = 120_000): Promise<IngestJob> {
  const started = await app.inject({
    method: 'POST',
    url: `/api/sources/${sourceId}/ingest`,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(started.statusCode, 202, 'ingestion should be accepted, not awaited');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/api/sources/${sourceId}/ingest` });
    const job = json<IngestJob>(response);
    if (job.phase === 'done' || job.phase === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('ingestion did not finish in time');
}

// Shared across tests, in declaration order.
let moduleId: string;
let sectionIds: Record<string, string> = {};
let pdfSourceId: string;

test('health reports the embedding provider and vector backend', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);

  const body = json<{ ok: boolean; embeddings: { provider: string; state: string } }>(response);
  assert.equal(body.ok, true);
  assert.equal(body.embeddings.provider, 'hash');
  assert.equal(body.embeddings.state, 'ready');
});

test('a module can be created and read back', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/modules',
    payload: { title: 'Neuroscience', code: 'PA20345', year: 2 },
  });
  assert.equal(created.statusCode, 201);

  moduleId = json<{ id: string }>(created).id;

  const listed = await app.inject({ method: 'GET', url: '/api/modules' });
  const modules = json<Array<{ id: string; title: string }>>(listed);
  assert.equal(modules.length, 1);
  assert.equal(modules[0]?.title, 'Neuroscience');
});

test('a hierarchy committed in one PUT comes back correctly numbered', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/modules/${moduleId}/sections`,
    payload: {
      tree: [
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
        {
          title: 'Neurotransmission',
          children: [
            {
              title: 'Resting membrane potential',
              learningOutcomes: ['Explain how the Na+/K+ ATPase establishes the resting potential'],
            },
            { title: 'Action potential propagation' },
          ],
        },
      ],
    },
  });
  assert.equal(response.statusCode, 200);

  interface Node {
    id: string;
    title: string;
    number: string;
    children: Node[];
  }
  const flatten = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);
  const flat = flatten(json<Node[]>(response));

  assert.deepEqual(
    flat.map((node) => `${node.number} ${node.title}`),
    [
      '1.0 The Brain',
      '1.1 Gross anatomy and organisation',
      '1.2 The cerebral cortex',
      '1.2.1 Cortical layers',
      '1.2.2 Functional areas',
      '2.0 Neurotransmission',
      '2.1 Resting membrane potential',
      '2.2 Action potential propagation',
    ],
  );

  sectionIds = Object.fromEntries(flat.map((node) => [node.title, node.id]));
});

test('uploading slides stores the file without parsing it', async () => {
  const { payload, headers } = multipart(
    { type: 'slides', title: 'L07 Action Potentials' },
    {
      field: 'file',
      filename: 'lecture-07.pdf',
      contentType: 'application/pdf',
      path: PDF,
    },
  );

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/sources`,
    payload,
    headers,
  });
  assert.equal(response.statusCode, 201);

  const source = json<{ id: string; title: string; status: string; type: string }>(response);
  assert.equal(source.title, 'L07 Action Potentials', 'the title field must survive the upload');
  assert.equal(source.type, 'slides');
  assert.equal(source.status, 'uploaded', 'parsing is a separate step');
  pdfSourceId = source.id;
});

test('an unsupported file type is rejected', async () => {
  const scratch = path.join(tempDir, 'notes.pages');
  fs.writeFileSync(scratch, 'not a supported format');

  const { payload, headers } = multipart(
    {},
    { field: 'file', filename: 'notes.pages', contentType: 'application/octet-stream', path: scratch },
  );

  const response = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/sources`,
    payload,
    headers,
  });
  assert.equal(response.statusCode, 400);
  assert.match(json<{ error: string }>(response).error, /Unsupported file type/);
});

test('ingesting runs as a job and extracts chunks and figures', async () => {
  // A bodyless POST that still declares JSON must not be rejected: this is
  // exactly the shape a browser fetch sends, and it used to fail with a 400.
  const job = await ingestAndWait(pdfSourceId);

  assert.equal(job.phase, 'done', job.error ?? '');
  assert.equal(job.result?.chunks, 2, 'one chunk per page of the fixture');
  assert.equal(job.result?.figures, 2, 'both captioned figures should be extracted');
  assert.equal(job.result?.embedded, true);
  assert.deepEqual(job.result?.warnings, []);
});

test('a source with a figure repeated across pages yields one figure per image', async () => {
  const { payload, headers } = multipart(
    { type: 'textbook', title: 'Reused figures' },
    {
      field: 'file',
      filename: 'reused.pdf',
      contentType: 'application/pdf',
      path: path.join(FIXTURES, 'reused-figure.pdf'),
    },
  );

  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/sources`,
    payload,
    headers,
  });
  const sourceId = json<{ id: string }>(uploaded).id;

  const job = await ingestAndWait(sourceId);
  assert.equal(job.phase, 'done', job.error ?? '');
  // Four pages, two distinct diagrams, each drawn twice. Identical images are
  // stored once rather than per appearance.
  assert.equal(job.result?.figures, 2);

  await app.inject({ method: 'DELETE', url: `/api/sources/${sourceId}` });
});

test('chunks carry a citation naming the exact slide', async () => {
  const response = await app.inject({ method: 'GET', url: `/api/sources/${pdfSourceId}/chunks` });
  const chunks = json<Array<{ text: string; slideNo: number; location: string; embedded: boolean }>>(
    response,
  );

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.slideNo, 1);
  assert.equal(chunks[0]?.location, 'L07 Action Potentials slide 1');
  assert.equal(chunks[1]?.location, 'L07 Action Potentials slide 2');
  assert.match(chunks[0]!.text, /Na\+\/K\+ ATPase/);
  assert.match(chunks[1]!.text, /saltatory conduction/i);
  assert.ok(chunks.every((chunk) => chunk.embedded));
});

test('extracted figures keep their caption, page and a servable file', async () => {
  const response = await app.inject({ method: 'GET', url: `/api/sources/${pdfSourceId}` });
  const source = json<{
    pageCount: number;
    figures: Array<{ url: string; pageNo: number; captionExtracted: string }>;
  }>(response);

  assert.equal(source.pageCount, 2);
  assert.equal(source.figures.length, 2);

  const [first, second] = source.figures;
  assert.match(first!.captionExtracted, /^Figure 1\./);
  assert.equal(first!.pageNo, 1);
  assert.match(second!.captionExtracted, /^Figure 2\./);

  // The URL must actually resolve through the static handler.
  const image = await app.inject({ method: 'GET', url: first!.url });
  assert.equal(image.statusCode, 200);
  assert.ok(image.rawPayload.length > 0);
  assert.equal(image.rawPayload.subarray(1, 4).toString(), 'PNG');
});

test('a transcript keeps its timestamps and splits at a long silence', async () => {
  const { payload, headers } = multipart(
    { type: 'transcript', title: 'L07 transcript' },
    { field: 'file', filename: 'l07.vtt', contentType: 'text/vtt', path: VTT },
  );

  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/sources`,
    payload,
    headers,
  });
  const sourceId = json<{ id: string }>(uploaded).id;

  const job = await ingestAndWait(sourceId);
  assert.equal(job.phase, 'done', job.error ?? '');

  const response = await app.inject({ method: 'GET', url: `/api/sources/${sourceId}/chunks` });
  const chunks = json<Array<{ location: string; text: string; timestamp: number }>>(response);

  // The fixture has a 34-minute gap in the middle; material after it must not
  // be swept into a chunk that claims to start at 0:04.
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.location, 'L07 transcript 0:04');
  assert.equal(chunks[1]?.location, 'L07 transcript 34:18');
  assert.doesNotMatch(chunks[0]!.text, /saltatory/i);
  assert.match(chunks[1]!.text, /nodes of Ranvier/);
});

test('confirming a section mapping overrides what was proposed', async () => {
  const target = [sectionIds['Resting membrane potential']!, sectionIds['Action potential propagation']!];

  const response = await app.inject({
    method: 'PUT',
    url: `/api/sources/${pdfSourceId}/sections`,
    payload: { sectionIds: target },
  });
  assert.equal(response.statusCode, 200);

  const mappings = json<Array<{ sectionId: string; confirmed: boolean; sectionNumber: string }>>(
    response,
  );
  assert.equal(mappings.length, 2);
  assert.ok(mappings.every((mapping) => mapping.confirmed));
  assert.deepEqual(
    mappings.map((mapping) => mapping.sectionNumber).sort(),
    ['2.1', '2.2'],
  );
});

test('a section exposes the figures of the sources mapped to it', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/sections/${sectionIds['Action potential propagation']}/figures`,
  });
  const figures = json<Array<{ id: string }>>(response);
  assert.equal(figures.length, 2, 'both figures from the mapped deck should be reachable');
});

test('note blocks round-trip, and editing generated text marks it as yours', async () => {
  const sectionId = sectionIds['Resting membrane potential']!;

  const created = await app.inject({
    method: 'POST',
    url: `/api/sections/${sectionId}/notes`,
    payload: { type: 'prose', markdown: 'The Na+/K+ ATPase establishes the resting potential.' },
  });
  assert.equal(created.statusCode, 201);

  const block = json<{ id: string; origin: string; position: number }>(created);
  assert.equal(block.origin, 'user_written');
  assert.equal(block.position, 0);

  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/notes/${block.id}`,
    payload: {
      markdown: 'Revised: the Na+/K+ ATPase is electrogenic, exporting 3 Na+ for every 2 K+.',
    },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(json<{ embedded: boolean }>(updated).embedded, true);

  const locked = await app.inject({
    method: 'PATCH',
    url: `/api/notes/${block.id}`,
    payload: { locked: true },
  });
  assert.equal(json<{ locked: boolean }>(locked).locked, true);

  const listed = await app.inject({ method: 'GET', url: `/api/sections/${sectionId}/notes` });
  const blocks = json<Array<{ id: string; markdown: string }>>(listed);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.markdown, /electrogenic/);
});

test('writing a note moves the section off "empty"', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/sections/${sectionIds['Resting membrane potential']}`,
  });
  assert.equal(json<{ status: string }>(response).status, 'edited');
});

test('search finds both a note and the source material behind it', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/search?q=${encodeURIComponent('ATPase')}&moduleId=${moduleId}`,
  });
  assert.equal(response.statusCode, 200);

  const hits = json<Array<{ kind: string; location?: string }>>(response);
  const kinds = new Set(hits.map((hit) => hit.kind));
  assert.ok(kinds.has('note_block'), 'should find the note');
  assert.ok(kinds.has('chunk'), 'should find the slide it came from');

  const chunkHit = hits.find((hit) => hit.kind === 'chunk');
  assert.match(chunkHit!.location!, /slide \d/);
});

test('a rejected move leaves the tree untouched', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/sections/${sectionIds['The Brain']}/move`,
    payload: { parentId: sectionIds['Cortical layers'], position: 0 },
  });
  assert.equal(response.statusCode, 400);
  assert.match(json<{ error: string }>(response).error, /cannot be moved inside itself/);

  const tree = await app.inject({ method: 'GET', url: `/api/modules/${moduleId}/sections` });
  assert.equal(json<Array<{ number: string }>>(tree)[0]?.number, '1.0');
});

test('deleting a source removes its chunks and its files', async () => {
  const before = await app.inject({ method: 'GET', url: `/api/sources/${pdfSourceId}` });
  const figureUrl = json<{ figures: Array<{ url: string }> }>(before).figures[0]!.url;

  const deleted = await app.inject({ method: 'DELETE', url: `/api/sources/${pdfSourceId}` });
  assert.equal(deleted.statusCode, 204);

  const missing = await app.inject({ method: 'GET', url: `/api/sources/${pdfSourceId}` });
  assert.equal(missing.statusCode, 404);

  const image = await app.inject({ method: 'GET', url: figureUrl });
  assert.equal(image.statusCode, 404, 'extracted figures should be cleaned up too');
});

test('unknown records 404 rather than erroring', async () => {
  const responses = await Promise.all([
    app.inject({ method: 'GET', url: '/api/modules/does-not-exist' }),
    app.inject({ method: 'GET', url: '/api/sections/does-not-exist' }),
    app.inject({ method: 'GET', url: '/api/sources/does-not-exist' }),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 404);
});

test('an invalid payload is a 400 with detail, not a 500', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/modules',
    payload: { code: 'PA20345' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(json<{ error: string }>(response).error, 'Invalid request');
});
