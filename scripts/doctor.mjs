/**
 * Diagnose why Processor will not start.
 *
 *   npm run doctor
 *
 * Runs the checks in the order things actually fail, stops at the first
 * blocker, and says what to do about it in plain English. The last check
 * genuinely boots the server and captures its output, so whatever the real
 * error is, it ends up on screen rather than scrolling past in a terminal.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(pathToFileURL(path.join(root, 'noop.cjs')));

const isWindows = process.platform === 'win32';
const tick = (ok) => (ok ? '  ok  ' : ' FAIL ');

let blockers = 0;
const notes = [];

function report(ok, label, detail) {
  console.log(`[${tick(ok)}] ${label}`);
  if (detail) for (const line of detail.split('\n')) console.log(`         ${line}`);
  if (!ok) blockers++;
}

function note(text) {
  notes.push(text);
}

console.log(`\nProcessor doctor`);
console.log(`  platform   ${process.platform} ${process.arch}`);
console.log(`  node       ${process.version}`);
console.log(`  project    ${root}\n`);

// --- 1. Node version ---------------------------------------------------------

{
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  const ok = major > 20 || (major === 20 && minor >= 11);
  report(
    ok,
    `Node ${process.versions.node}`,
    ok
      ? undefined
      : 'Processor needs Node 20.11 or newer. Install the current LTS from https://nodejs.org\n' +
          'and then run this again.',
  );
  if (!ok) finish();
}

// --- 2. Dependencies installed ----------------------------------------------

{
  const installed = fs.existsSync(path.join(root, 'node_modules'));
  report(
    installed,
    'Dependencies installed',
    installed ? undefined : 'Run:  npm install',
  );
  if (!installed) finish();
}

// --- 3. The native database module ------------------------------------------
//
// better-sqlite3 is a compiled binary. When npm cannot find a prebuild for your
// Node version it silently falls back to compiling from source, which needs
// build tools that a normal Windows machine does not have. The install can look
// like it worked and then fail here, which is exactly the kind of thing that
// leaves the server dead with no obvious cause.

{
  let ok = false;
  let detail;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('select 1 as n').get();
    db.close();
    ok = true;
  } catch (error) {
    detail =
      `better-sqlite3 could not load:\n${error.message}\n\n` +
      'This is the compiled database driver. Usually fixed by rebuilding it for\n' +
      'your Node version:\n\n' +
      '  npm rebuild better-sqlite3\n\n' +
      'If that fails, delete node_modules and package-lock.json, then npm install.\n' +
      (isWindows
        ? 'On Windows, compiling from source needs the "Desktop development with C++"\n' +
          'workload from Visual Studio Build Tools. Switching to the current Node LTS\n' +
          'is usually easier, because it has a prebuilt binary ready to download.'
        : '');
  }
  report(ok, 'Database driver (better-sqlite3)', detail);
  if (!ok) finish();
}

// --- 4. Vector extension (optional) -----------------------------------------

{
  let ok = false;
  let detail;
  try {
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const { v } = db.prepare('select vec_version() as v').get();
    db.close();
    ok = true;
    detail = `version ${v}`;
  } catch (error) {
    detail =
      `sqlite-vec did not load: ${error.message.split('\n')[0]}\n` +
      'Not a problem. Search falls back to comparing vectors in JavaScript, which\n' +
      'is fast enough for one person\'s material. Nothing to fix.';
  }
  // Never a blocker: the app is designed to run without it.
  console.log(`[${tick(ok)}] Vector extension (optional)`);
  if (detail) for (const line of detail.split('\n')) console.log(`         ${line}`);
  if (!ok) note('sqlite-vec is unavailable, so search uses the JavaScript fallback.');
}

// --- 5. Data directory -------------------------------------------------------

{
  const dataDir = process.env.DATA_DIR
    ? path.resolve(root, process.env.DATA_DIR)
    : path.join(root, 'data');

  let ok = false;
  let detail;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    ok = true;
    const dbFile = path.join(dataDir, 'processor.db');
    detail = fs.existsSync(dbFile)
      ? `${dataDir}\n(existing database, ${(fs.statSync(dbFile).size / 1024).toFixed(0)} KB)`
      : `${dataDir}\n(will be created on first run)`;
  } catch (error) {
    detail =
      `Cannot write to ${dataDir}\n${error.message}\n\n` +
      'Move the project somewhere your user account can write to — a folder under\n' +
      'Documents is fine. Avoid Program Files and any synced folder that locks files.';
  }
  report(ok, 'Data folder writable', detail);
  if (!ok) finish();
}

// --- 6. Ports ----------------------------------------------------------------

async function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

const SERVER_PORT = Number(process.env.PORT) || 5174;

{
  const free = await portFree(SERVER_PORT);
  let inUseByProcessor = false;

  if (!free) {
    try {
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`);
      inUseByProcessor = response.ok;
    } catch {
      inUseByProcessor = false;
    }
  }

  if (free) {
    report(true, `Port ${SERVER_PORT} available`);
  } else if (inUseByProcessor) {
    report(true, `Port ${SERVER_PORT} — Processor is already running there`);
    note(
      `A Processor server is already running on port ${SERVER_PORT}. ` +
        'Open http://localhost:5173 (dev) or ' +
        `http://localhost:${SERVER_PORT} (built).`,
    );
  } else {
    report(
      false,
      `Port ${SERVER_PORT} is taken by something else`,
      'Another program is using this port, so the server cannot start.\n' +
        'Either close it, or pick a different port by putting this in a file\n' +
        `named .env in the project folder:\n\n  PORT=5199\n\n` +
        (isWindows
          ? 'To see what is holding it:\n' +
            `  netstat -ano | findstr :${SERVER_PORT}\n` +
            '  taskkill /PID <the number in the last column> /F'
          : `To see what is holding it:\n  lsof -i :${SERVER_PORT}`),
    );
  }
}

// --- 7. Actually boot the server --------------------------------------------
//
// Everything above can pass and the server still fail, so the last check is to
// run it for real on a scratch database and see what it says.

{
  const built = fs.existsSync(path.join(root, 'server/dist/index.js'));
  const entry = built
    ? { args: [path.join(root, 'server/dist/index.js')], label: 'built server' }
    : { args: ['--import', 'tsx', path.join(root, 'server/src/index.ts')], label: 'source server' };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-doctor-'));
  const probePort = 5100 + Math.floor(Math.random() * 800);
  const TIMEOUT_MS = 180_000;

  // This check can take a while, so it narrates. A silent wait is impossible to
  // tell apart from a hang, and the difference matters: on Windows a cold start
  // from TypeScript source with an antivirus scanning node_modules can take a
  // genuinely long time without anything being wrong.
  // Progress dots only make sense on a real terminal; when the output is piped
  // or redirected they would just litter the transcript.
  const live = Boolean(process.stdout.isTTY);
  console.log(
    `[ .... ] Server starts (${entry.label}) — booting, please wait` +
      (built ? '' : '\n         (compiling TypeScript as it goes; the built server starts faster)'),
  );

  const child = spawn(process.execPath, entry.args, {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(probePort),
      HOST: '127.0.0.1',
      DATA_DIR: scratch,
      EMBEDDINGS_PROVIDER: 'hash',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const collect = (data) => {
    output += data.toString();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let exitCode = null;
  let spawnError = null;
  child.on('exit', (code) => (exitCode = code ?? 0));
  child.on('error', (error) => (spawnError = error));

  const startedAt = Date.now();
  const deadline = startedAt + TIMEOUT_MS;
  let started = false;
  let lastDot = 0;

  while (Date.now() < deadline && exitCode === null && !spawnError && !started) {
    try {
      const response = await fetch(`http://127.0.0.1:${probePort}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) started = true;
    } catch {
      /* not up yet */
    }
    if (!started) {
      // One dot a second, so the window visibly keeps working.
      if (live && Date.now() - lastDot >= 1000) {
        process.stdout.write('.');
        lastDot = Date.now();
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  // Blank the dots with spaces rather than an ANSI erase code, which older
  // Windows consoles can print literally.
  if (live) process.stdout.write(`\r${' '.repeat(78)}\r`);

  child.kill();
  fs.rmSync(scratch, { recursive: true, force: true });

  if (spawnError) {
    report(false, 'Server could not be launched', spawnError.message);
  } else if (started) {
    report(true, `Server starts (${entry.label}) — ready in ${seconds}s`);
    if (Number(seconds) > 20) {
      note(
        `Startup took ${seconds}s, which is slow. If the project sits in a folder your ` +
          'antivirus scans (or on a slow or network drive), excluding the node_modules ' +
          'folder usually makes a large difference. Processor.bat runs the built server, ' +
          'which starts far faster than the source one.',
      );
    }
  } else if (exitCode !== null) {
    report(
      false,
      `Server exited after ${seconds}s with code ${exitCode}`,
      (output.trim() || '(no output at all)') +
        '\n\nCopy the text above — it names the real problem.',
    );
  } else {
    report(
      false,
      `Server did not respond within ${TIMEOUT_MS / 1000}s`,
      (output.trim() || '(the server printed nothing at all)') +
        '\n\nIt is running but never finished starting. Most often that is a folder ' +
        'being scanned by antivirus, or a slow or network drive.\n' +
        'Try excluding the project folder from real-time scanning, or move it to a\n' +
        'local disk, then run this again.',
    );
  }
}

finish();

function finish() {
  console.log('');
  if (blockers === 0) {
    console.log('Everything checks out. Start it with:\n');
    console.log('  npm start        (or double-click Processor.bat on Windows)\n');
  } else {
    console.log(
      `${blockers} problem${blockers === 1 ? '' : 's'} found. Fix the first FAIL above and run this again.\n`,
    );
  }
  for (const text of notes) console.log(`note: ${text}`);
  if (notes.length) console.log('');
  process.exit(blockers === 0 ? 0 : 1);
}
