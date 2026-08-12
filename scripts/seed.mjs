/**
 * Populate a running server with a realistic demo module, so there is
 * something to click around in without hunting for your own lecture files.
 *
 *   npm run dev        # in one terminal
 *   npm run seed       # in another
 *
 * Safe to re-run: it creates a fresh module each time rather than editing
 * anything you have already built.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const FIXTURES = path.join(repoRoot, 'server/test/fixtures');

const BASE = process.env.SEED_BASE_URL ?? 'http://127.0.0.1:5174';

async function call(method, url, body) {
  const isForm = body instanceof FormData;
  const response = await fetch(`${BASE}${url}`, {
    method,
    ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
    ...(body === undefined || isForm
      ? {}
      : { headers: { 'content-type': 'application/json' } }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${method} ${url} → ${response.status}\n${detail.slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

async function upload(moduleId, { file, title, type }) {
  const form = new FormData();
  form.append('title', title);
  form.append('type', type);
  form.append(
    'file',
    new Blob([fs.readFileSync(path.join(FIXTURES, file))]),
    file,
  );
  const source = await call('POST', `/api/modules/${moduleId}/sources`, form);
  const result = await call('POST', `/api/sources/${source.id}/ingest`);
  return { source, result };
}

const TREE = [
  {
    title: 'The Brain',
    children: [
      { title: 'Gross anatomy and organisation' },
      {
        title: 'The cerebral cortex',
        children: [{ title: 'Cortical layers' }, { title: 'Functional areas' }],
      },
      { title: 'Blood supply and the blood-brain barrier' },
    ],
  },
  {
    title: 'The Spinal Cord',
    children: [{ title: 'Structure and tracts' }, { title: 'Reflex arcs' }],
  },
  {
    title: 'Neurotransmission',
    children: [
      {
        title: 'Resting membrane potential',
        learningOutcomes: [
          'Explain how the Na+/K+ ATPase and differential ion permeability establish the resting potential',
          'State the approximate resting potential of a typical neurone',
        ],
      },
      {
        title: 'Action potential propagation',
        learningOutcomes: [
          'Describe saltatory conduction and the role of myelination',
          'Compare conduction velocity in myelinated and unmyelinated fibres',
        ],
      },
    ],
  },
];

async function main() {
  try {
    const health = await call('GET', '/api/health');
    if (health.embeddings.state !== 'ready') {
      console.log(
        `note: embeddings are ${health.embeddings.state} — content will still ingest, ` +
          'but section matching will be weak until you backfill.\n',
      );
    }
  } catch {
    console.error(
      `Could not reach the server at ${BASE}.\n` +
        'Start it first with `npm run dev`, then run this again.',
    );
    process.exit(1);
  }

  const stamp = new Date().toISOString().slice(11, 19);
  const module = await call('POST', '/api/modules', {
    title: `Neuroscience (demo ${stamp})`,
    code: 'PA20345',
    year: 2,
  });
  console.log(`module   ${module.title}`);

  const tree = await call('PUT', `/api/modules/${module.id}/sections`, { tree: TREE });
  const count = (nodes) => nodes.reduce((n, node) => n + 1 + count(node.children), 0);
  console.log(`sections ${count(tree)} created`);

  for (const spec of [
    { file: 'lecture-07-action-potentials.pdf', title: 'L07 Action Potentials', type: 'slides' },
    { file: 'lecture-07-transcript.vtt', title: 'L07 transcript', type: 'transcript' },
  ]) {
    const { result } = await upload(module.id, spec);
    console.log(
      `source   ${spec.title} — ${result.chunks} chunks, ${result.figures} figures, ` +
        `${result.proposedSections} section(s) proposed`,
    );
    for (const warning of result.warnings) console.log(`         warning: ${warning}`);
  }

  // A note, so the Notes tab and search have something in them from the start.
  const flat = [];
  const walk = (nodes) => nodes.forEach((n) => (flat.push(n), walk(n.children)));
  walk(tree);
  const restingPotential = flat.find((node) => node.title === 'Resting membrane potential');

  if (restingPotential) {
    await call('POST', `/api/sections/${restingPotential.id}/notes`, {
      type: 'heading',
      markdown: 'Establishing the resting potential',
    });
    await call('POST', `/api/sections/${restingPotential.id}/notes`, {
      type: 'prose',
      markdown:
        'The Na+/K+ ATPase exports three sodium ions for every two potassium ions imported. ' +
        'Because the exchange is unequal it is electrogenic, and together with the membrane’s ' +
        'much higher permeability to potassium at rest this holds the interior at about −70 mV.',
    });
    await call('POST', `/api/sections/${restingPotential.id}/notes`, {
      type: 'callout',
      markdown:
        'The pump accounts for only a few millivolts directly. Most of the resting potential ' +
        'comes from potassium leak channels, which is why the measured value sits close to ' +
        'the potassium equilibrium potential.',
    });
    console.log('notes    3 blocks written to 3.1 Resting membrane potential');
  }

  console.log(`\nDone. Open ${BASE.replace('5174', '5173')} (or ${BASE} if running the build).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
