/**
 * Does the server actually start when run the way `npm run dev` runs it?
 *
 * Every other suite imports buildServer() directly, which skips the entry-point
 * guard at the bottom of index.ts entirely. That guard compares import.meta.url
 * against argv[1], and a version of it that concatenated "file://" onto argv[1]
 * worked perfectly on macOS and Linux while silently failing on Windows: the
 * module loaded, the comparison never matched, main() never ran, and the
 * process exited without ever listening. Every test still passed, because none
 * of them ran the file as a script.
 *
 * So this spawns it as a real child process and waits for it to serve a
 * request, which is the only way to catch that whole class of bug.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'index.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-startup-'));

let child: ChildProcess | null = null;

after(() => {
  child?.kill();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Ask the OS for a port that is definitely free, to avoid clashing with a dev server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('could not determine a free port')));
      }
    });
    server.on('error', reject);
  });
}

test('running index.ts as a script starts a listening server', async (t) => {
  const port = await freePort();

  child = spawn(
    process.execPath,
    ['--import', 'tsx', entry],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: tempDir,
        EMBEDDINGS_PROVIDER: 'hash',
        NODE_ENV: 'production', // skips the pretty-print transport
        LOG_LEVEL: 'silent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? 0;
  });

  // Poll until it answers, rather than sleeping a fixed amount: startup time
  // varies a lot between a warm and a cold tsx cache.
  const deadline = Date.now() + 45_000;
  let health: { ok: boolean } | null = null;

  while (Date.now() < deadline) {
    if (exited !== null) {
      assert.fail(
        `The server exited with code ${exited} instead of listening.\n` +
          'If main() never ran, suspect the entry-point guard at the bottom of ' +
          `index.ts.\n${stderr.slice(0, 800)}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        health = (await response.json()) as { ok: boolean };
        break;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!health) {
    t.diagnostic(stderr.slice(0, 800));
    assert.fail(`The server never answered on port ${port} within 45s.`);
  }

  assert.equal(health.ok, true);

  // And it should create its data directory rather than assuming one exists.
  assert.ok(fs.existsSync(path.join(tempDir, 'processor.db')), 'database file should be created');
});
