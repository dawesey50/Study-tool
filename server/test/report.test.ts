/**
 * The diagnostic report — `npm run report`.
 *
 * The report exists to be sent to someone who cannot see your screen, which
 * makes two of its promises worth testing rather than trusting:
 *
 *   - it never contains an API key;
 *   - `--quiet` really does leave your material out.
 *
 * Both are the kind of promise that breaks silently. A field added to the
 * report six months from now that happens to include a stem would defeat
 * `--quiet` without any test failing, unless a test looks at the finished file
 * for the material itself — which is what this does.
 *
 * The script is run as a subprocess rather than imported, because what is
 * being checked is the file it writes, not the functions inside it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-report-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const { newId } = await import('../src/lib/ids.js');

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;

/** Distinctive enough that finding it in the output is unambiguous. */
const SECRET_KEY = 'sk-ant-thisisnotarealkey-0000000000';
const CONCEPT = 'Zygomorphic quenching of the flavodoxin shuttle in xenobiotic tissue';
const STEM = 'Why does the flavodoxin shuttle stall under zygomorphic quenching?';
const NOTE = 'The flavodoxin shuttle is quenched zygomorphically, which stalls the transfer.';
const OPTION = 'Because the quencher outcompetes the shuttle';

before(async () => {
  app = await buildServer({ logger: false });
  await app.ready();

  const db = getDb();
  const moduleId = newId();
  db.insert(schema.modules).values({ id: moduleId, title: 'Report fixture' }).run();

  const sectionId = newId();
  db.insert(schema.sections)
    .values({ id: sectionId, moduleId, parentId: null, title: 'Flavodoxin', position: 0 })
    .run();

  db.insert(schema.concepts)
    .values({
      id: newId(),
      sectionId,
      statement: CONCEPT,
      type: 'mechanism',
      examinableFlag: true,
    })
    .run();

  db.insert(schema.noteBlocks)
    .values({
      id: newId(),
      sectionId,
      position: 0,
      type: 'prose',
      markdown: NOTE,
      origin: 'ai_generated',
    })
    .run();

  db.insert(schema.questions)
    .values({
      id: newId(),
      moduleId,
      format: 'mcq',
      stem: STEM,
      sectionIds: [sectionId],
      conceptIds: [],
      optionsJson: [
        { text: OPTION, correct: true },
        { text: 'Some other reason', correct: false, whyWrong: 'not the mechanism' },
      ],
      workedAnswer: 'Because of the quenching.',
      source: 'generated',
    })
    .run();
});

after(async () => {
  await app.close();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Runs the report with a key set in its environment, and returns the file. */
function runReport(extraArgs: string[]): string {
  const outFile = path.join(tempDir, `out-${extraArgs.join('') || 'plain'}.md`);
  execFileSync(
    'npx',
    ['tsx', 'scripts/report.ts', '--out', outFile, ...extraArgs],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: tempDir,
        EMBEDDINGS_PROVIDER: 'hash',
        // The whole point: a key is present while the report runs.
        ANTHROPIC_API_KEY: SECRET_KEY,
      },
      stdio: 'pipe',
    },
  );
  return fs.readFileSync(outFile, 'utf8');
}

test('the report never contains an API key', () => {
  const report = runReport([]);

  // The report says whether a key is set, because that changes what can run.
  // It must never say what the key is.
  assert.ok(!report.includes(SECRET_KEY), 'the API key appeared in the report');
  assert.ok(!report.includes('sk-ant-'), 'something key-shaped appeared in the report');
  assert.match(report, /anthropic: set/, 'it should still say a key is present');
});

test('the default report includes the material, so the writing can be judged', () => {
  const report = runReport([]);

  // Counts can look perfect while the writing is useless. The excerpts are the
  // only part that answers the question the project exists to ask, so their
  // absence would make the report worthless even though nothing errored.
  assert.ok(report.includes(CONCEPT.slice(0, 40)), 'no concept excerpt');
  assert.ok(report.includes(STEM.slice(0, 40)), 'no question stem');
  assert.ok(report.includes(NOTE.slice(0, 40)), 'no note excerpt');
});

test('--quiet leaves the material out entirely', () => {
  const report = runReport(['--quiet']);

  // Someone who would rather not share their coursework still needs the shape.
  // A field added later that happened to carry a stem would defeat this
  // silently, which is why the check is on the finished file rather than on
  // the code that writes it.
  assert.ok(!report.includes(CONCEPT.slice(0, 30)), 'a concept leaked through --quiet');
  assert.ok(!report.includes(STEM.slice(0, 30)), 'a question stem leaked through --quiet');
  assert.ok(!report.includes(NOTE.slice(0, 30)), 'a note leaked through --quiet');
  assert.ok(!report.includes(OPTION.slice(0, 30)), 'an option leaked through --quiet');
  assert.ok(!report.includes(SECRET_KEY));

  // Still useful: the shape survives.
  assert.match(report, /Report fixture/, 'the module title should still be there');
  assert.match(report, /Thresholds in force/);
  assert.match(report, /## What looks wrong/);
});

test('the report names the thresholds that were in force', () => {
  const report = runReport([]);

  // The numbers are the point of sending it: they are all guesses, and knowing
  // which guess produced which result is what makes a report actionable.
  assert.match(report, /questions\.cosineLimit = /);
  assert.match(report, /generation\.coverageThreshold = /);
  assert.match(report, /pastPapers\.matchThreshold = /);
});

test('the report warns when the offline embedder is in use', () => {
  const report = runReport([]);

  // Running the whole walkthrough on `hash` would produce a report full of
  // meaningless numbers that looked fine, which is the worst outcome this
  // file can prevent.
  assert.match(report, /## What looks wrong/);
  assert.match(report, /no semantic understanding/i);
});
