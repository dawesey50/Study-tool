/**
 * End-to-end: the question bank and practice, in a real browser.
 *
 *   npm run build && npm start     # in one terminal
 *   npm run test:e2e:questions     # in another
 *
 * WHY THIS SEEDS THE DATABASE DIRECTLY
 *
 * The obvious shape would be to click Generate and watch questions appear.
 * That needs a model: the offline stub answers a JSON-schema request with a
 * valid but empty document, so every generated stem would be empty and the
 * novelty gate would reject all of them — correctly. Running it against a real
 * provider would make this test cost money and depend on the network, which is
 * not what a smoke test is for.
 *
 * So the bank is written straight into SQLite (WAL, so a second writer is
 * fine) and what gets tested is everything after generation: that the bank
 * renders, that the set-level answer-key view is right, that practice serves
 * questions, and — the one that matters — that the answer is genuinely not in
 * the page until an attempt has been recorded. That last one is a claim about
 * the wire, and this is the only place it is checked in a real browser.
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
  process.env.E2E_DB_PATH ?? path.join(process.env.DATA_DIR ?? path.join(repoRoot, 'data'), 'processor.db');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'Playwright is not installed.\n\n' +
      '  npm install -D playwright && npx playwright install chromium\n\n' +
      'Then run this again. The unit and API suites (npm test) need nothing extra.',
  );
  process.exit(1);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  console.error('better-sqlite3 not resolvable from the repo root. Run npm install first.');
  process.exit(1);
}

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
  if (!response.ok) throw new Error(`${method} ${url} → ${response.status}`);
  return response.status === 204 ? null : response.json();
}

// ---------------------------------------------------------------------------
// Set up a module with a bank
// ---------------------------------------------------------------------------

const stamp = Date.now();
const module = await call('POST', '/api/modules', { title: `Question bank e2e ${stamp}` });
const tree = await call('PUT', `/api/modules/${module.id}/sections`, {
  tree: [{ title: 'Oxidative phosphorylation' }, { title: 'Glycolysis' }],
});
const sectionIds = tree.map((node) => node.id);

const QUESTIONS = [
  {
    concept: 'Oligomycin blocks the Fo channel, so the proton motive force rises until the chain stalls.',
    stem: 'Isolated mitochondria respiring on succinate are given oligomycin. Predict the change in oxygen uptake and justify it.',
    options: [
      { text: 'It falls, because the chain cannot pump against a rising gradient', correct: true },
      { text: 'It rises, because the gradient is dissipated', correct: false, whyWrong: 'that describes an uncoupler, not an ATP synthase block' },
      { text: 'It is unchanged, because succinate bypasses complex I', correct: false, whyWrong: 'the entry point is irrelevant to a block downstream' },
      { text: 'It falls to zero immediately', correct: false, whyWrong: 'proton leak keeps a slow rate going' },
    ],
  },
  {
    concept: 'Competitive inhibition raises apparent Km and leaves Vmax unchanged.',
    stem: 'Two Lineweaver-Burk lines intersect on the y-axis. What does that reveal about where the inhibitor binds?',
    options: [
      { text: 'It binds the free enzyme at the active site', correct: true },
      { text: 'It binds only the enzyme-substrate complex', correct: false, whyWrong: 'that is uncompetitive, which shifts both intercepts' },
      { text: 'It binds an allosteric site with equal affinity either way', correct: false, whyWrong: 'that is non-competitive, and Vmax would fall' },
      { text: 'Nothing — the intercept is set by the assay', correct: false, whyWrong: 'the y-intercept is 1/Vmax, a property of the enzyme' },
    ],
  },
  {
    concept: 'Erythrocytes have no mitochondria, so they cannot oxidise ketone bodies.',
    stem: 'During prolonged starvation, hepatocytes export ketone bodies. Why can erythrocytes not use them?',
    options: [
      { text: 'They have no mitochondria', correct: true },
      { text: 'They lack the monocarboxylate transporter', correct: false, whyWrong: 'they carry it; the problem is downstream' },
      { text: 'Ketone bodies cannot cross their membrane', correct: false, whyWrong: 'they cross readily' },
      { text: 'Their pH is too low for the enzymes', correct: false, whyWrong: 'the enzymes are absent, not inhibited' },
    ],
  },
];

const db = new Database(DB_PATH);
const now = Math.floor(Date.now() / 1000);

// Concepts first: the schedule is built on concepts, and a question with none
// attached schedules nothing — which would make the revision view honestly
// empty and this test meaningless.
const insertConcept = db.prepare(
  `INSERT INTO concepts (id, section_id, statement, type, examinable_flag, created_at)
   VALUES (?, ?, ?, 'mechanism', 1, ?)`,
);
const conceptIds = QUESTIONS.map((question, index) => {
  const id = `e2e-c-${stamp}-${index}`;
  insertConcept.run(id, sectionIds[index % sectionIds.length], question.concept, now);
  return id;
});

// One extra that no question tests, so the view has something never-seen to
// count. A mastery figure that quietly leaves those out is the failure this
// whole page exists to avoid.
insertConcept.run(`e2e-c-${stamp}-spare`, sectionIds[0], 'A concept no question covers.', now);

const insert = db.prepare(
  `INSERT INTO questions
     (id, module_id, blueprint_json, concept_ids, section_ids, format, stem, options_json,
      worked_answer, bloom_level, source, times_served, times_correct, critic_score, created_at)
   VALUES (?, ?, ?, ?, ?, 'mcq', ?, ?, ?, 'analysis', 'generated', 0, 0, 4.5, ?)`,
);

const ids = [];
QUESTIONS.forEach((question, index) => {
  const id = `e2e-${stamp}-${index}`;
  ids.push(id);
  insert.run(
    id,
    module.id,
    JSON.stringify({ archetype: 'perturbation', scenario: ['hepatocytes'], constraint: null }),
    JSON.stringify([conceptIds[index]]),
    JSON.stringify([sectionIds[index % sectionIds.length]]),
    question.stem,
    JSON.stringify(question.options),
    'The reasoning, revealed only after an attempt.',
    now + index,
  );
});
db.close();

console.log(`Seeded ${ids.length} questions into ${module.title}\n`);

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
  // --- the bank ------------------------------------------------------------
  console.log('The question bank');
  await page.goto(`${BASE}/modules/${module.id}/questions`, { waitUntil: 'networkidle' });

  const body = await page.textContent('body');
  check('every seeded stem is listed', QUESTIONS.every((q) => body.includes(q.stem.slice(0, 40))));
  check('the answer-key view is shown', body.includes('How the answers fall'));

  // Expanding a question reveals the full record — this is the review surface,
  // so here the answer is meant to be visible.
  await page.getByText(QUESTIONS[0].stem.slice(0, 40)).first().click();
  await page.waitForTimeout(200);
  const expanded = await page.textContent('body');
  check('expanding shows which option is correct', expanded.includes('correct'));
  check('expanding shows why a distractor is wrong', expanded.includes('that describes an uncoupler'));
  check('expanding shows the blueprint', expanded.toLowerCase().includes('blueprint'));
  await shoot('questions-bank');

  // --- practice ------------------------------------------------------------
  console.log('\nPractice');
  await page.goto(`${BASE}/modules/${module.id}/practice`, { waitUntil: 'networkidle' });

  const beforeAnswering = await page.content();
  // The claim the server makes, checked where it matters: in the page itself.
  check(
    'the answer is not in the page before answering',
    !beforeAnswering.includes('that describes an uncoupler') &&
      !beforeAnswering.includes('"correct"') &&
      !beforeAnswering.includes('revealed only after an attempt'),
  );

  const answerButton = page.getByRole('button', { name: 'Answer' });
  check('Answer is disabled before anything is chosen', await answerButton.isDisabled());

  // Choosing an option is not enough — confidence is required too.
  // Scoped to <main>: an unscoped `li button` picks up the sidebar's module
  // list first and navigates away from the page under test.
  await page.locator('main ul li button').first().click();
  await page.waitForTimeout(120);
  check(
    'Answer is still disabled with no confidence given',
    await answerButton.isDisabled(),
    'confidence must be required, or the signal is worthless',
  );

  await page.getByRole('button', { name: 'Certain' }).click();
  await page.waitForTimeout(120);
  check('Answer is enabled once both are given', !(await answerButton.isDisabled()));
  await shoot('questions-practice');

  await answerButton.click();
  await page.waitForSelector('text=/Correct|Not right/', { timeout: 5000 });

  const afterAnswering = await page.textContent('body');
  check('the reasoning appears after answering', afterAnswering.includes('Reasoning'));
  check(
    'a wrong answer given confidently is called out',
    // Which option was first depends on the seeded order; only one of these
    // two can be true, and both are correct outcomes.
    afterAnswering.includes('You were sure, and it was wrong') ||
      afterAnswering.includes('Correct'),
  );
  await shoot('questions-answered');

  await page.getByRole('button', { name: /Next question|Finish/ }).click();
  await page.waitForTimeout(300);
  const second = await page.textContent('body');
  check('moving on shows the next question', second.includes('Question 2 of'));

  // --- the attempt was recorded -------------------------------------------
  const bank = await call('GET', `/api/modules/${module.id}/questions`);
  const served = bank.questions.filter((question) => question.timesServed > 0);
  check('the attempt was counted against the question', served.length === 1);

  // --- revision ------------------------------------------------------------
  console.log('\nRevision');
  await page.goto(`${BASE}/modules/${module.id}/revision`, { waitUntil: 'networkidle' });
  const revision = await page.textContent('body');
  check('the revision view renders', revision.includes('Revision'));
  check('mastery is reported across every concept', revision.includes('across every concept'));
  check('untested concepts are counted, not hidden', revision.includes('never seen'));

  // Four concepts exist and one question was answered, so exactly one has been
  // seen and the other three are still due. Checked against the API rather
  // than by string-matching the page, because a number that happens to appear
  // in the markup proves nothing.
  const summary = await call('GET', `/api/modules/${module.id}/revision`);
  check('every concept is counted', summary.concepts === 4, `got ${summary.concepts}`);
  check('answering scheduled exactly one concept', summary.reviewed === 1, `got ${summary.reviewed}`);
  check('the other three are still due', summary.due === 3, `got ${summary.due}`);
  check(
    'mastery is diluted by what has never been tested',
    summary.mastery > 0 && summary.mastery < 0.3,
    `mastery ${summary.mastery}`,
  );
  await shoot('questions-revision');

  console.log('\nConsole errors during the run:', consoleErrors.length);
  for (const error of consoleErrors.slice(0, 5)) console.log(`  ${error}`);
  // React key warnings and the like would pass silently otherwise.
  check('no console errors', consoleErrors.length === 0, consoleErrors[0] ?? '');
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.error(error);
  await shoot('questions-failure');
} finally {
  await browser.close();
}

console.log(
  failures.length === 0
    ? '\nAll checks passed.'
    : `\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`,
);
process.exit(failures.length === 0 ? 0 : 1);
