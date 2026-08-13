/**
 * One click, and Processor is open in your browser.
 *
 * Double-click Processor.bat on Windows, or Processor.command on a Mac. There
 * is nothing to type and no URL to paste.
 *
 * What it does, skipping anything already done:
 *   1. installs dependencies, if they are missing or out of date
 *   2. builds the app, if the build is missing or older than the source
 *   3. starts the server and waits for it to answer
 *   4. opens your browser
 *
 * Steps 1 and 2 only cost time the first run after a change. Day to day this
 * goes straight to step 3 and takes a couple of seconds.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const isWindows = process.platform === 'win32';

/** Records what state the last successful prepare ran against. */
const STAMP = path.join(root, 'node_modules', '.processor-launch.json');
const PORT = Number(process.env.PORT) || 5174;
const URL = `http://localhost:${PORT}`;

const say = (message) => console.log(message);
const step = (message) => console.log(`\n${message}`);

async function main() {
  say('Processor\n');

  if (process.env.PROCESSOR_SKIP_UPDATE !== '1') maybeUpdate();

  const stamp = readStamp();
  const lockHash = hashOf(path.join(root, 'package-lock.json'));

  if (!fs.existsSync(path.join(root, 'node_modules')) || stamp.lockHash !== lockHash) {
    step('Installing dependencies. First run only, this takes a minute…');
    run('npm', ['install'], 'Could not install dependencies.');
  }

  if (needsBuild()) {
    step('Building. This happens only when the code has changed…');
    run('npm', ['run', 'build'], 'Could not build the app.');
  }

  writeStamp({ lockHash, builtAt: Date.now() });

  // If a copy is already running, just open it rather than fighting for the port.
  if (await healthy()) {
    step('Processor is already running.');
    openBrowser(URL);
    say(`\nOpen at ${URL}\n`);
    return;
  }

  step('Starting…');
  const server = spawn(process.execPath, [path.join(root, 'server', 'dist', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      // Day to day this window should be quiet. Warnings and errors still show;
      // a line of JSON per request does not.
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const capture = (data) => {
    output += data.toString();
  };
  server.stdout?.on('data', capture);
  server.stderr?.on('data', capture);

  let exited = null;
  server.on('exit', (code) => {
    exited = code ?? 0;
  });

  const stop = () => {
    server.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && exited === null) {
    if (await healthy()) {
      openBrowser(URL);
      say(`\n  Processor is open at ${URL}`);
      say('  Your notes live in the data folder next to this project.');
      say('\n  Leave this window open while you work. Close it to shut down.\n');
      // Hand the server's own logging back to the window from here on.
      server.stdout?.off('data', capture);
      server.stderr?.off('data', capture);
      server.stdout?.pipe(process.stdout);
      server.stderr?.pipe(process.stderr);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  fail(
    exited === null
      ? 'The server did not start within 90 seconds.'
      : `The server stopped straight away (exit code ${exited}).`,
    output,
  );
}

// ---------------------------------------------------------------------------

/**
 * Pull the latest version, but only when it is completely safe: a git checkout,
 * on a branch, with nothing uncommitted, and a fast-forward available. Anything
 * else is skipped without comment — an app launcher has no business resolving
 * merge conflicts or discarding your work.
 */
function maybeUpdate() {
  const git = (...args) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });

  const inRepo = git('rev-parse', '--is-inside-work-tree');
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') return;

  const dirty = git('status', '--porcelain');
  if (dirty.status !== 0 || dirty.stdout.trim()) return;

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch.status !== 0 || branch.stdout.trim() === 'HEAD') return;

  const pulled = git('pull', '--ff-only');
  if (pulled.status !== 0) return;

  if (!/Already up to date/i.test(pulled.stdout)) {
    say('Updated to the latest version.');
  }
}

function needsBuild() {
  const serverEntry = path.join(root, 'server', 'dist', 'index.js');
  const webEntry = path.join(root, 'web', 'dist', 'index.html');
  if (!fs.existsSync(serverEntry) || !fs.existsSync(webEntry)) return true;

  const builtAt = Math.min(fs.statSync(serverEntry).mtimeMs, fs.statSync(webEntry).mtimeMs);
  return newestSourceTime() > builtAt;
}

/** Most recent modification time across the source we compile. */
function newestSourceTime() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(path.join(root, 'server', 'src'));
  walk(path.join(root, 'web', 'src'));
  return newest;
}

function run(command, args, whatFailed) {
  // npm is a batch file on Windows, which cannot be spawned without a shell.
  const result = spawnSync(isWindows ? `${command}.cmd` : command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
  if (result.status !== 0) {
    fail(whatFailed, 'The output above says why. Running `npm run doctor` often explains it.');
  }
}

async function healthy() {
  try {
    const response = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const [command, args] = isWindows
    ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // A missing browser opener surfaces as an asynchronous 'error' event rather
    // than a throw, and an unhandled one takes the whole launcher down. Not
    // being able to open a browser is not a reason to stop serving — the URL is
    // printed regardless.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Same reasoning for a synchronous failure.
  }
}

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  } catch {
    return {};
  }
}

function writeStamp(value) {
  try {
    fs.writeFileSync(STAMP, JSON.stringify(value));
  } catch {
    // A missing stamp only costs an unnecessary check next time.
  }
}

function hashOf(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function fail(headline, detail) {
  console.error(`\n  ${headline}\n`);
  if (detail?.trim()) {
    for (const line of detail.trim().split('\n')) console.error(`  ${line}`);
  }
  console.error('\n  For a full diagnosis, run:  npm run doctor\n');
  process.exit(1);
}

main().catch((error) => fail('Processor could not start.', error?.stack ?? String(error)));
