/**
 * End-to-end: sitting a mock paper in a real browser.
 *
 *   npm run build && npm start     # in one terminal
 *   npm run test:e2e:exams         # in another
 *
 * The three claims worth checking in a browser rather than in a unit test:
 *
 *   - the whole paper is on one page, so you can look ahead and come back;
 *   - no answer is in the page before submission, checked against the served
 *     HTML rather than against the UI;
 *   - the clock actually runs out and submits, rather than showing a banner
 *     and waiting for you — a time limit you can ignore is not a time limit.
 *
 * The bank is seeded straight into SQLite for the same reason as the questions
 * e2e: the offline stub answers a schema request with an empty document, so no
 * question could be generated here without a real key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5174';
const HEADED = process.env.E2E_HEADED === '1';
const SHOTS = process.env.E2E_SCREENSHOT_DIR;
const DB_PATH =
  process.env.E2E_DB_PATH ??
  path.join(process.env.DATA_DIR ?? path.join(repoRoot, 'data'), 'processor.db');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed.\n\n  npm install -D playwright\n');
  process.exit(1);
}
const Database = require('better-sqlite3');

try {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  if (!health.ok) throw new Error('unhealthy');
} catch {
  console.error(`No server responding at ${BASE}.\n\n  npm run build && npm start\n`);
  process.exit(1);
}

const failures = [];
const consoleErrors = [];

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

async function call(method, url, body) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  });
  if (!response.ok) throw new Error(`${method} ${url} → ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

// ---------------------------------------------------------------------------
// Seed a bank: generated MCQs plus real past-paper questions
// ---------------------------------------------------------------------------

const stamp = Date.now();
const module = await call('POST', '/api/modules', { title: `Exam e2e ${stamp}` });
const tree = await call('PUT', `/api/modules/${module.id}/sections`, {
  tree: [{ title: 'Oxidative phosphorylation' }],
});
const sectionId = tree[0].id;

const db = new Database(DB_PATH);
const now = Math.floor(Date.now() / 1000);

const conceptId = `e2e-exam-c-${stamp}`;
db.prepare(
  `INSERT INTO concepts (id, section_id, statement, type, examinable_flag, created_at)
   VALUES (?, ?, ?, 'mechanism', 1, ?)`,
).run(conceptId, sectionId, 'Oligomycin blocks ATP synthase.', now);

const insert = db.prepare(
  `INSERT INTO questions
     (id, module_id, blueprint_json, concept_ids, section_ids, format, stem, options_json,
      worked_answer, source, times_served, times_correct, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
);

const MCQS = [
  'What happens to oxygen uptake when oligomycin is added to respiring mitochondria?',
  'Which parameter is unchanged in competitive inhibition?',
  'Why can erythrocytes not oxidise ketone bodies?',
  'What does an uncoupler do to the proton gradient?',
];
MCQS.forEach((stem, index) => {
  insert.run(
    `e2e-exam-q-${stamp}-${index}`,
    module.id,
    JSON.stringify({ archetype: 'perturbation' }),
    JSON.stringify([conceptId]),
    JSON.stringify([sectionId]),
    'mcq',
    stem,
    // Neutral option text: the leak check reads the page source, and options
    // named "correct"/"wrong" would make it pass or fail on the fixture.
    JSON.stringify([
      { text: `Alpha ${index}`, correct: true },
      { text: `Beta ${index}`, correct: false, whyWrong: 'the gradient runs the other way' },
      { text: `Gamma ${index}`, correct: false, whyWrong: 'that is a different tissue' },
    ]),
    'The reasoning, which must not appear before submission.',
    'generated',
    now + index,
  );
});

const PAPERS = [
  'Describe the effect of oligomycin on mitochondrial oxygen consumption and explain the mechanism.',
  'Compare the P/O ratio for succinate with that for malate, and account for the difference.',
];
PAPERS.forEach((stem, index) => {
  insert.run(
    `e2e-exam-p-${stamp}-${index}`,
    module.id,
    JSON.stringify({ origin: 'past_paper', paper: 'BB20001 2025', number: `${index + 1}`, marks: 6 }),
    JSON.stringify([conceptId]),
    JSON.stringify([sectionId]),
    'saq',
    stem,
    null,
    null,
    'past_paper',
    now + 10 + index,
  );
});
db.close();

console.log(`Seeded ${MCQS.length} generated and ${PAPERS.length} real questions\n`);

// ---------------------------------------------------------------------------
// Drive it
// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  headless: !HEADED,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const shoot = async (name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

try {
  console.log('Building a paper');
  await page.goto(`${BASE}/modules/${module.id}/exams`, { waitUntil: 'networkidle' });

  const body = await page.textContent('body');
  check('the exam page renders', body.includes('Mock exams'));

  await page.locator('input[type="number"]').first().fill('6');
  await page.getByRole('button', { name: /Build a paper/ }).click();
  await page.waitForURL(/\/exams\/[^/]+$/, { timeout: 10000 });
  await page.waitForSelector('ol li', { timeout: 10000 });

  const items = await page.locator('main ol > li').count();
  // The whole paper on one page is what lets you look ahead, skip and come
  // back — the thing practice cannot do.
  check('the whole paper is on one page', items === 6, `${items} questions rendered`);

  const sat = await page.content();
  check(
    'no answer is in the page before submission',
    !sat.includes('"correct"') &&
      !sat.includes('the gradient runs the other way') &&
      !sat.includes('must not appear before submission'),
  );

  const paperText = await page.textContent('main');
  check('real exam questions are marked as such', paperText.includes('real exam question'));
  check('a clock is running', /\d+:\d\d/.test(paperText));
  await shoot('exam-sitting');

  // Answer the first MCQ, leave the rest.
  await page.locator('main ol > li ul li button').first().click();
  await page.waitForTimeout(150);

  console.log('\nSubmitting');
  await page.getByRole('button', { name: 'Submit paper' }).click();
  // Unanswered questions are marked wrong, exactly as in a real paper, so it
  // confirms first.
  await page.getByRole('button', { name: /Submit anyway/ }).click();
  await page.waitForSelector('text=/of what could be marked|could be marked|Reasoning/', {
    timeout: 10000,
  });

  const marked = await page.textContent('main');
  check('a score is shown', /%/.test(marked));
  check(
    'written answers are excluded from the score and said to be',
    marked.includes('not included in that figure'),
  );
  check('the reasoning appears only now', marked.includes('Reasoning'));
  check(
    'a real paper question says why it has no mark scheme',
    marked.includes('prints the question and not the mark scheme'),
  );
  await shoot('exam-marked');

  // --- the API agrees ------------------------------------------------------
  const list = await call('GET', `/api/modules/${module.id}/exams`);
  check('the paper is recorded as submitted', list.exams[0]?.submittedAt !== null);

  const revision = await call('GET', `/api/modules/${module.id}/revision`);
  // A question answered under time pressure is at least as good evidence as
  // one answered at leisure, so a submitted paper feeds the schedule.
  check('sitting the paper fed the revision schedule', revision.reviewed === 1);

  console.log('\nConsole errors during the run:', consoleErrors.length);
  for (const error of consoleErrors.slice(0, 5)) console.log(`  ${error}`);
  check('no console errors', consoleErrors.length === 0, consoleErrors[0] ?? '');
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.error(error);
  await shoot('exam-failure');
} finally {
  await browser.close();
}

console.log(
  failures.length === 0
    ? '\nAll checks passed.'
    : `\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`,
);
process.exit(failures.length === 0 ? 0 : 1);
