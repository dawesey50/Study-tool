/**
 * What happens when an upload goes wrong.
 *
 * A textbook is the largest thing this system is ever asked to swallow and the
 * most likely upload to fail, so the failures need to say something useful. The
 * size limit is the case that matters most: it came back as a bare "request
 * file too large" with no mention of the limit or how to change it, because the
 * error aborts the multipart stream and never reaches the check that had the
 * good message.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-upload-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.MAX_UPLOAD_MB = '1';

const { buildServer } = await import('../src/index.js');
const { closeDb } = await import('../src/db/index.js');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let moduleId: string;

before(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
  moduleId = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/modules',
        payload: { title: 'Uploads' },
      })
    ).body,
  ).id;
});

after(async () => {
  await app.close();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function multipart(fields: Record<string, string>, file: { filename: string; body: Buffer }) {
  const boundary = `----uploadtest${Date.now()}`;
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
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n',
    ),
    file.body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const upload = (filename: string, body: Buffer) => {
  const form = multipart({ type: 'textbook', title: 'A textbook' }, { filename, body });
  return app.inject({
    method: 'POST',
    url: `/api/modules/${moduleId}/sources`,
    payload: form.payload,
    headers: form.headers,
  });
};

test('an oversized textbook names the limit and how to raise it', async () => {
  // Two megabytes against a one-megabyte limit.
  const response = await upload('huge-textbook.pdf', Buffer.alloc(2 * 1024 * 1024, 0x41));

  assert.equal(response.statusCode, 413);
  const { error } = JSON.parse(response.body) as { error: string };

  assert.match(error, /huge-textbook\.pdf/, 'say which file');
  assert.match(error, /1 MB/, 'say what the limit is');
  assert.match(error, /MAX_UPLOAD_MB/, 'say which setting changes it');
  assert.doesNotMatch(
    error,
    /^request file too large$/,
    'the raw multipart message tells you nothing actionable',
  );
});

test('an oversized upload leaves no half-written file behind', async () => {
  await upload('partial.pdf', Buffer.alloc(2 * 1024 * 1024, 0x41));

  const dir = path.join(tempDir, 'media', 'sources', moduleId);
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(
    leftovers,
    [],
    'a truncated file on disk would be ingested and reported as a corrupt PDF',
  );
});

test('an unsupported file type lists what is supported', async () => {
  // Keynote rather than PowerPoint: .pptx used to be the example here and is
  // now supported, which is exactly the kind of stale fixture that turns a
  // test into a check that nothing has improved.
  const response = await upload('lecture.key', Buffer.from('not a pdf'));
  assert.equal(response.statusCode, 400);
  const { error } = JSON.parse(response.body) as { error: string };
  assert.match(error, /\.key/);
  assert.match(error, /\.pdf/, 'say what would work instead');
  assert.match(error, /\.pptx/, 'PowerPoint is the commonest lecture format');
});

test('the old binary .ppt names the two-click fix', async () => {
  const response = await upload('lecture.ppt', Buffer.from('old office binary'));
  assert.equal(response.statusCode, 400);
  const { error } = JSON.parse(response.body) as { error: string };
  // A student with thirty .ppt files needs to know about Save As, not that
  // the format is unsupported.
  assert.match(error, /pptx/i, `unhelpful: ${error}`);
});

test('a file within the limit still uploads', async () => {
  const response = await upload('small.pdf', Buffer.from('%PDF-1.4\ntrailer<<>>\n%%EOF\n'));
  assert.equal(response.statusCode, 201, JSON.stringify(response.body));
});
