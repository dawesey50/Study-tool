/**
 * End-to-end smoke test: drives a real browser against a running server and
 * walks the whole Phase 1 journey.
 *
 *   npm run build && npm start     # in one terminal
 *   npm run test:e2e               # in another
 *
 * This is deliberately a single flowing journey rather than isolated cases.
 * The unit and API suites cover behaviour in detail; what this checks is that
 * the pieces are actually wired together in the browser — which is where the
 * bugs that matter tend to hide.
 *
 * Playwright is not a dependency of the project, since most work does not need
 * it. Install it when you want to run this:  npm install -D playwright
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const PDF = path.join(repoRoot, 'server/test/fixtures/lecture-07-action-potentials.pdf');

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5174';
const HEADED = process.env.E2E_HEADED === '1';
const SHOTS = process.env.E2E_SCREENSHOT_DIR;

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

try {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  if (!health.ok) throw new Error('unhealthy');
} catch {
  console.error(
    `No server responding at ${BASE}.\n\n` +
      '  npm run build && npm start\n\n' +
      'then run this again.',
  );
  process.exit(1);
}

const failures = [];
const consoleErrors = [];

const browser = await chromium.launch({
  headless: !HEADED,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`));

async function step(name, fn) {
  process.stdout.write(`  ${name} … `);
  try {
    await fn();
    console.log('ok');
  } catch (error) {
    console.log('FAILED');
    failures.push({ name, error: error.message.split('\n')[0] });
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `fail-${slug(name)}.png`) });
    }
  }
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// A distinct name per run keeps repeated runs from colliding in the sidebar.
const moduleName = `E2E Neuroscience ${Date.now().toString().slice(-6)}`;

console.log(`\nRunning the Phase 1 journey against ${BASE}\n`);

await step('the app loads', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // Scoped to the main column: "Modules" also labels a sidebar region.
  await page.locator('main').getByRole('heading', { name: 'Modules', exact: true }).waitFor();
});

await step('a module can be created', async () => {
  await page.getByPlaceholder('PA20345').fill('PA20345');
  await page.getByPlaceholder('Neuroscience').fill(moduleName);
  await page.getByRole('button', { name: 'Add module' }).click();
  // Creating a module navigates into it and lists it in the sidebar.
  await page.locator('aside').getByText(moduleName).waitFor();
});

await step('the sidebar lists modules', async () => {
  const inSidebar = page.locator('aside').getByText(moduleName);
  if ((await inSidebar.count()) === 0) throw new Error('module missing from the sidebar');
});

await step('a pasted outline becomes a numbered hierarchy', async () => {
  await page.getByRole('button', { name: 'Paste an outline' }).first().click();
  await page.locator('#outline').fill(
    [
      'The Brain',
      '  Gross anatomy and organisation',
      '  The cerebral cortex',
      '    Cortical layers',
      '    Functional areas',
      'Neurotransmission',
      '  Resting membrane potential',
      '  Action potential propagation',
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Replace hierarchy' }).click();

  const sidebar = page.locator('aside');
  for (const number of ['1.0', '1.1', '1.2', '1.2.1', '1.2.2', '2.0', '2.1', '2.2']) {
    await sidebar.getByText(number, { exact: true }).first().waitFor({ timeout: 8000 });
  }
});

await step('slides upload and ingest through the queue', async () => {
  await page.getByRole('link', { name: /Sources for this module|Add sources/ }).first().click();
  await page.getByRole('heading', { name: 'Sources' }).waitFor();
  // Files are titled from their filenames now, and several can go in at once.
  await page.locator('input[type=file]').first().setInputFiles(PDF);
  // The queue reports the result once the background job has finished.
  await page.getByText(/\d+ chunks · \d+ figures/).first().waitFor({ timeout: 90_000 });
});

await step('the deck can be mapped to sections by hand', async () => {
  await page.getByRole('button', { name: 'Edit' }).first().click();
  for (const title of ['Resting membrane potential', 'Action potential propagation']) {
    await page.locator('label', { hasText: title }).locator('input').check();
  }
  await page.getByRole('button', { name: 'Confirm mapping' }).click();
  const chip = page.locator('main').getByTitle('Confirmed by you');
  await chip.first().waitFor({ timeout: 10_000 });
  const labels = await chip.evaluateAll((els) => els.map((e) => e.textContent.trim()));
  if (labels.length !== 2) throw new Error(`expected 2 confirmed chips, got ${labels.length}`);
  if (!labels.some((text) => text.includes('Action potential propagation'))) {
    throw new Error(`missing the expected mapping, got ${JSON.stringify(labels)}`);
  }
});

await step('a section shows its chunks with slide citations', async () => {
  await page.locator('aside').getByText('Action potential propagation').click();
  await page.getByRole('button', { name: /^Sources/ }).click();
  await page.getByRole('button', { name: 'Show extract' }).first().click();
  await page.getByText(/slide \d/).first().waitFor({ timeout: 10_000 });
});

await step('extracted figures render, not just link', async () => {
  await page.getByText(/Figures from this section/).waitFor({ timeout: 10_000 });
  const image = page.locator('figure img').first();
  await image.waitFor();
  const loaded = await image.evaluate((el) => el.naturalWidth > 0);
  if (!loaded) throw new Error('figure image did not load');
});

await step('notes are written as one continuous document', async () => {
  await page.getByRole('button', { name: 'Notes' }).click();
  const editor = page.locator('.prose-notes');
  await editor.waitFor();
  // The document always ends in an empty paragraph, so there is somewhere to type.
  await page.locator('.prose-notes > p').last().click();
  await page.keyboard.type('Myelination increases conduction velocity via saltatory conduction.');
  await page.waitForTimeout(1600); // let the debounced save land
  // The editor's own status line, not any other text containing "Saved".
  await page.locator('span[aria-live="polite"]').filter({ hasText: /^Saved$/ }).waitFor({
    timeout: 10_000,
  });
});

await step('markdown shortcuts create real structure', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Saltatory conduction');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- Nodes of Ranvier');
  await page.waitForTimeout(1800);

  if ((await page.locator('.prose-notes h2', { hasText: 'Saltatory conduction' }).count()) !== 1) {
    throw new Error('"## " did not become a heading');
  }
  if ((await page.locator('.prose-notes ul li').count()) < 1) {
    throw new Error('"- " did not become a list');
  }
});

await step('the document survives a reload, structure intact', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.prose-notes').waitFor();
  await page.getByText(/Myelination increases conduction velocity/).waitFor({ timeout: 10_000 });
  if ((await page.locator('.prose-notes h2', { hasText: 'Saltatory conduction' }).count()) !== 1) {
    throw new Error('the heading did not survive the round trip through storage');
  }
  if ((await page.locator('.prose-notes ul li').count()) < 1) {
    throw new Error('the list did not survive the round trip through storage');
  }
});

await step('free typing still produces addressable blocks', async () => {
  // The point of the whole design: one document to write in, real blocks
  // underneath for locking and, later, targeted regeneration.
  const sectionId = page.url().split('/sections/')[1];
  const blocks = await page.evaluate(
    (id) => fetch(`/api/sections/${id}/notes`).then((r) => r.json()),
    sectionId,
  );
  const types = blocks.map((block) => block.type);
  if (!types.includes('heading')) throw new Error(`no heading block stored: ${types.join(', ')}`);
  if (!types.includes('list')) throw new Error(`no list block stored: ${types.join(', ')}`);
  if (!blocks.every((block) => block.id)) throw new Error('a block has no id');
});

await step('locking a block makes it read-only', async () => {
  await page.getByText(/Myelination increases conduction velocity/).click();
  await page.getByRole('button', { name: /Lock this block/ }).click();
  await page.getByText('locked', { exact: true }).first().waitFor({ timeout: 10_000 });
  // The document as a whole stays editable — only the locked block rejects
  // edits — so prove it by trying to type into it and checking nothing changed.
  const before = await page.locator('.prose-notes').innerText();
  await page.getByText(/Myelination increases conduction velocity/).click();
  await page.keyboard.type('XXX');
  await page.waitForTimeout(400);
  const after = await page.locator('.prose-notes').innerText();
  if (before !== after) throw new Error('a locked block accepted an edit');
});

await step('search finds the note and the slide behind it', async () => {
  await page.getByPlaceholder(/Search everything/).fill('saltatory');
  await page.waitForTimeout(900);
  const results = page.locator('aside button', { hasText: /saltatory/i });
  if ((await results.count()) === 0) throw new Error('no search results');
});

await step('dragging a section renumbers the tree', async () => {
  await page.keyboard.press('Escape');
  const before = await sidebarNumbers(page);

  // Native HTML5 drag is not produced by synthetic mouse movement, so the
  // drag events are dispatched directly at the same handlers a real drag hits.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('aside [draggable="true"]')];
    const find = (text) => rows.find((row) => row.textContent.includes(text));
    const source = find('Neurotransmission');
    const target = find('The Brain');
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    const box = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      dataTransfer,
      clientX: box.left + 10,
      clientY: box.top + box.height * 0.1,
    };
    target.dispatchEvent(new DragEvent('dragover', init));
    target.dispatchEvent(new DragEvent('drop', init));
  });

  await page.waitForTimeout(1500);
  const after = await sidebarNumbers(page);

  if (!after[0]?.includes('Neurotransmission') || !after[0]?.startsWith('1.0')) {
    throw new Error(`expected Neurotransmission at 1.0, got "${after[0]}" (was "${before[0]}")`);
  }
  // Its children must have come with it.
  if (!after[1]?.startsWith('1.1')) throw new Error('children did not follow the moved parent');
});

if (SHOTS) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'final.png'), fullPage: true });
}

await browser.close();

const unique = [...new Set(consoleErrors)];
if (unique.length) {
  console.log('\nBrowser console errors:');
  for (const error of unique) console.log(`  ${error}`);
}

if (failures.length || unique.length) {
  console.log(`\n${failures.length} step(s) failed:`);
  for (const failure of failures) console.log(`  ${failure.name}: ${failure.error}`);
  if (SHOTS) console.log(`\nScreenshots in ${SHOTS}`);
  process.exit(1);
}

console.log('\nAll steps passed, no console errors.\n');

function sidebarNumbers(page) {
  return page
    .locator('aside a[href*="/sections/"]')
    .evaluateAll((els) => els.map((el) => el.textContent.trim().replace(/\s+/g, ' ')));
}
