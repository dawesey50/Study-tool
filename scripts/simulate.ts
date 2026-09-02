/**
 * A dry run of the whole pipeline on a made-up lecture.
 *
 *   npm run simulate
 *
 * Ingest → map → extract concepts → generate notes → check coverage, printed
 * as it happens, with no API key and no network.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT
 *
 * The model is a stub, and the "model output" below was written by hand. So
 * this proves the plumbing: that material flows through chunking, mapping,
 * extraction, generation and the coverage check, that citations survive the
 * whole way, that dedupe and the uncitable-concept guard fire, that your own
 * writing is preserved, and that the coverage badge counts what was actually
 * written.
 *
 * It says nothing whatever about whether a real model would extract good
 * concepts or write good notes from this material. That question needs a real
 * key and real lectures, and it is the one thing a simulation cannot answer.
 * Where the canned output is deliberately imperfect — a duplicated concept, one
 * citing a chunk that does not exist, one concept the notes never explain —
 * that is to show the guards working, not to predict how a model behaves.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-sim-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
process.env.LLM_PROVIDER = 'stub';
process.env.LLM_MODEL_NOTES = 'claude-sonnet-5';
process.env.LLM_MODEL_CONCEPTS = 'claude-sonnet-5';
process.env.LLM_MONTHLY_CAP_GBP = '1000';
// The offline embedder has no semantic understanding, so coverage can only
// match near-identical text. A real run uses EMBEDDINGS_PROVIDER=local.
process.env.COVERAGE_THRESHOLD = '0.95';

const { initDb, getDb, schema, closeDb } = await import('../server/src/db/index.js');
const { setStub } = await import('../server/src/llm/providers/stub.js');
const { newId } = await import('../server/src/lib/ids.js');
const { extractConcepts, listConcepts, assignOwnership } = await import(
  '../server/src/services/concepts.js'
);
const { generateNotes } = await import('../server/src/services/generation.js');
const { createBlock, listBlocks, updateBlock } = await import(
  '../server/src/services/notes.js'
);
const { replaceTree, getTree, flatten } = await import('../server/src/services/sections.js');
const { usageSummary } = await import('../server/src/llm/usage.js');

const dim = (text: string) => `[2m${text}[0m`;
const bold = (text: string) => `[1m${text}[0m`;
const green = (text: string) => `[32m${text}[0m`;
const amber = (text: string) => `[33m${text}[0m`;

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim('─'.repeat(text.length))}`);
}

// ---------------------------------------------------------------------------
// The made-up lecture
// ---------------------------------------------------------------------------

/** Slides, one chunk per slide, written the way a real deck reads. */
const SLIDES = [
  'PA20345 Neuroscience — Lecture 7. The action potential: generation and propagation. Learning outcomes: explain how the resting potential is established; describe the ionic basis of the action potential; explain why conduction is faster in myelinated axons.',
  'The resting membrane potential. A typical mammalian neuron sits at about -70 mV. This is set mainly by the potassium equilibrium potential, because at rest the membrane is far more permeable to K+ than to Na+. A small standing sodium leak makes the true resting potential slightly less negative than E_K.',
  'The Na+/K+ ATPase. Exports 3 Na+ for every 2 K+ imported, consuming one ATP per cycle. The stoichiometry is unequal, so the pump is electrogenic: it contributes roughly -3 mV directly. Its larger role is maintaining the gradients that everything else depends on.',
  'Threshold and the rising phase. Depolarisation to approximately -55 mV opens voltage-gated sodium channels. Sodium entry depolarises the membrane further, opening more channels — a positive feedback loop that produces the near-vertical rising phase.',
  'Repolarisation. Sodium channels inactivate within about a millisecond, and slower voltage-gated potassium channels open. Potassium efflux returns the membrane towards E_K. The delay in closing these K+ channels produces the afterhyperpolarisation.',
  'The refractory periods. During the absolute refractory period no stimulus can trigger a second action potential, because the sodium channels are inactivated rather than merely closed. The relative refractory period follows, when a larger than normal stimulus is needed.',
  'Propagation in unmyelinated axons. Local circuit currents depolarise the adjacent membrane to threshold. Conduction velocity scales with the square root of axon diameter, which is why squid giant axons are so large.',
  'Saltatory conduction. Myelin increases membrane resistance and decreases capacitance, so local currents spread further. Voltage-gated sodium channels are concentrated at the nodes of Ranvier, and the impulse regenerates only at the nodes — jumping between them rather than propagating continuously. Conduction velocity in a myelinated axon scales roughly linearly with diameter.',
  'Clinical relevance. In multiple sclerosis, demyelination slows or blocks conduction in affected tracts, producing the corresponding neurological deficits. Any questions? Reading: Kandel chapter 7.',
];

/** The transcript, with the cues that emphasis and examinability come from. */
const TRANSCRIPT = [
  { at: 0, text: 'Right, so today is the action potential. This comes up every year in some form, so do make sure you can draw the trace and label the phases.' },
  { at: 145, text: 'The resting potential. About minus seventy millivolts. The reason it sits near the potassium equilibrium potential is permeability — at rest the membrane is far more permeable to potassium.' },
  { at: 420, text: 'Now the pump. Three sodium out, two potassium in, one ATP. I want you to remember that ratio, because the fact it is unequal is what makes the pump electrogenic. It only contributes a couple of millivolts directly, but it maintains the gradients.' },
  { at: 900, text: 'Threshold is around minus fifty-five. Once you are there, sodium channels open, sodium comes in, and that depolarises you further so more channels open. Positive feedback. That is the rising phase.' },
  { at: 1380, text: 'The absolute refractory period exists because the sodium channels are inactivated, not just shut. That is a distinction people lose marks on.' },
  { at: 2100, text: 'Saltatory conduction. The impulse jumps from node to node. Myelin raises resistance and drops capacitance, so the current spreads further before it decays. Sodium channels are packed at the nodes.' },
];

async function main(): Promise<void> {
  console.log(bold('\nProcessor — pipeline simulation'));
  console.log(
    dim(
      'Made-up lecture, stub model, no network. This exercises the pipeline;\n' +
        'it says nothing about how a real model would perform on real material.',
    ),
  );

  initDb();
  const db = getDb();

  // --- a module, a hierarchy, and the material ------------------------------
  heading('1. Module and material');

  const moduleId = newId();
  db.insert(schema.modules)
    .values({ id: moduleId, title: 'Neuroscience', code: 'PA20345' })
    .run();

  replaceTree(moduleId, [
    {
      title: 'Neurotransmission',
      children: [
        { title: 'Resting membrane potential' },
        { title: 'The action potential' },
        { title: 'Conduction and myelination' },
      ],
    },
  ]);
  const sections = flatten(getTree(moduleId));
  console.log(`Hierarchy: ${sections.map((node) => node.number).join(', ')}`);

  const slidesId = newId();
  db.insert(schema.sources)
    .values({
      id: slidesId,
      moduleId,
      type: 'slides',
      title: 'L07 Action potentials',
      filename: 'l07.pdf',
      path: 'media/sources/l07.pdf',
      status: 'ingested',
      pageCount: SLIDES.length,
    })
    .run();

  const slideChunks = SLIDES.map((text, index) => {
    const id = newId();
    db.insert(schema.chunks)
      .values({ id, sourceId: slidesId, text, slideNo: index + 1, position: index })
      .run();
    return id;
  });

  const transcriptId = newId();
  db.insert(schema.sources)
    .values({
      id: transcriptId,
      moduleId,
      type: 'transcript',
      title: 'L07 transcript',
      filename: 'l07.vtt',
      path: 'media/sources/l07.vtt',
      status: 'ingested',
    })
    .run();

  const transcriptChunks = TRANSCRIPT.map((cue, index) => {
    const id = newId();
    db.insert(schema.chunks)
      .values({
        id,
        sourceId: transcriptId,
        text: cue.text,
        timestamp: cue.at,
        position: index,
      })
      .run();
    return id;
  });

  console.log(
    `Sources: ${SLIDES.length} slides, ${TRANSCRIPT.length} transcript cues ` +
      `(${SLIDES.join(' ').length + TRANSCRIPT.map((c) => c.text).join(' ').length} characters)`,
  );

  // Mapped as if you had confirmed the proposals: the deck spans three
  // sections, which is the normal case the schema exists for.
  const mapping: Record<string, { slides: number[]; cues: number[] }> = {
    'Resting membrane potential': { slides: [1, 2], cues: [1, 2] },
    'The action potential': { slides: [3, 4, 5], cues: [3, 4] },
    'Conduction and myelination': { slides: [6, 7, 8], cues: [5] },
  };

  for (const node of sections) {
    const entry = mapping[node.title];
    if (!entry) continue;
    db.insert(schema.sourceSections)
      .values({
        sourceId: slidesId,
        sectionId: node.id,
        chunkRange: { chunkIds: entry.slides.map((i) => slideChunks[i]!) },
        score: 0.88,
        confirmed: true,
      })
      .run();
    db.insert(schema.sourceSections)
      .values({
        sourceId: transcriptId,
        sectionId: node.id,
        chunkRange: { chunkIds: entry.cues.map((i) => transcriptChunks[i]!) },
        score: 0.84,
        confirmed: true,
      })
      .run();
    console.log(
      dim(
        `  ${node.number} ${node.title} ← ${entry.slides.length} slides, ${entry.cues.length} cues`,
      ),
    );
  }

  // --- extraction -----------------------------------------------------------
  heading('2. Concept extraction');
  console.log(
    dim('The concept lists below are canned, not produced by a model.\n') +
      dim('Three flaws are deliberate, to show the guards firing.'),
  );

  const target = sections.find((node) => node.title === 'Conduction and myelination')!;
  const restingSection = sections.find((node) => node.title === 'Resting membrane potential')!;

  scriptExtraction(slideChunks, transcriptChunks);

  for (const node of [restingSection, target]) {
    const result = await extractConcepts({ sectionId: node.id });
    console.log(
      `\n${node.number} ${node.title}: ` +
        `${result.extracted} returned → ${green(`${result.kept} kept`)}` +
        (result.merged ? `, ${amber(`${result.merged} merged as duplicates`)}` : '') +
        (result.uncited ? `, ${amber(`${result.uncited} dropped with no valid citation`)}` : ''),
    );
    if (result.plausibility) console.log(amber(`  ! ${result.plausibility.message}`));

    for (const concept of listConcepts(node.id)) {
      const flags = [
        concept.examinableFlag ? green('examinable') : null,
        concept.emphasisScore && concept.emphasisScore >= 0.7 ? 'emphasised' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      console.log(`  • ${concept.statement}`);
      console.log(
        dim(`      ${concept.sourceChunkIds?.length ?? 0} citation(s)${flags ? ` · ${flags}` : ''}`),
      );
    }
  }

  const ownership = await assignOwnership(moduleId);
  console.log(
    `\nOwnership: compared ${ownership.compared} concepts across the module, ` +
      `${ownership.links} taught in more than one section.`,
  );

  // --- your own writing, then generation ------------------------------------
  heading('3. Generation, over a note of your own');

  const mine = await createBlock({
    sectionId: target.id,
    type: 'prose',
    markdown: 'MY OWN NOTE: ask about MS conduction block in the tutorial.',
  });
  await updateBlock(mine.id, { locked: true });
  console.log(dim(`Wrote and locked one block of your own before generating.`));

  scriptGeneration();
  const generated = await generateNotes({ sectionId: target.id });

  console.log(
    `\nWrote ${generated.blocksWritten} blocks, ` +
      `preserved ${green(`${generated.blocksPreserved} of yours`)}, ` +
      `${generated.coverage.passes} supplementary pass(es).`,
  );

  const badge = `${generated.coverage.covered}/${generated.coverage.total} concepts covered`;
  console.log(
    generated.coverage.uncovered.length === 0 ? green(badge) : amber(badge),
  );
  for (const entry of generated.coverage.uncovered) {
    console.log(amber(`  ! not covered: ${entry.statement}`));
  }
  if (generated.coverage.hitPassLimit) {
    console.log(
      amber('  ! stopped at the pass limit rather than keep paying to retry the same gap.'),
    );
  }

  heading('4. The resulting notes');
  for (const block of listBlocks(target.id)) {
    const mark = block.origin === 'ai_generated' ? dim('  generated') : green('  yours');
    const lock = block.locked ? green(' · locked') : '';
    console.log(`${mark}${lock}`);
    console.log(`    ${block.markdown.replace(/\n/g, '\n    ')}`);
  }

  const survivor = listBlocks(target.id).find((block) => block.id === mine.id);
  console.log(
    survivor?.markdown.includes('MY OWN NOTE')
      ? green('\n✓ Your locked block survived generation, unchanged.')
      : amber('\n! Your locked block did not survive — that is a bug.'),
  );

  // --- what it cost ---------------------------------------------------------
  heading('5. What it would have cost');
  const usage = usageSummary();
  console.log(
    `${usage.calls} model calls, ${usage.modules[0]?.inputTokens ?? 0} tokens in, ` +
      `${usage.modules[0]?.outputTokens ?? 0} out.`,
  );
  console.log(
    `Priced at claude-sonnet-5 rates: ${bold(`£${usage.totalGbp.toFixed(4)}`)} ` +
      dim(`(token counts are the stub's, so this is arithmetic, not a real bill)`),
  );

  console.log(
    dim(
      `\nEverything above ran offline against a temporary database in\n${tempDir},\n` +
        'which is now removed. Nothing in data/ was touched.\n',
    ),
  );

  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

/**
 * Canned extraction. Deliberately imperfect in three ways: two statements of
 * the same idea, one citing a chunk from another section, and one section left
 * with a concept the generator will not cover.
 */
function scriptExtraction(slideChunks: string[], transcriptChunks: string[]): void {
  setStub({
    respond: (request) => {
      const isResting = request.prompt.includes('Resting membrane potential');
      if (isResting) {
        return JSON.stringify({
          concepts: [
            {
              statement:
                'The resting membrane potential of a typical mammalian neuron is about -70 mV.',
              type: 'fact',
              sourceChunkIds: [slideChunks[1], transcriptChunks[1]],
              examinable: true,
              emphasis: 0.8,
            },
            {
              statement:
                'The resting potential sits near the potassium equilibrium potential because the membrane is far more permeable to K+ than to Na+ at rest.',
              type: 'mechanism',
              sourceChunkIds: [slideChunks[1], transcriptChunks[1]],
              examinable: true,
              emphasis: 0.9,
            },
            {
              statement:
                'The Na+/K+ ATPase exports three Na+ for every two K+ imported, consuming one ATP per cycle.',
              type: 'mechanism',
              sourceChunkIds: [slideChunks[2], transcriptChunks[2]],
              examinable: true,
              emphasis: 0.95,
            },
            {
              statement:
                'Because its stoichiometry is unequal, the Na+/K+ ATPase is electrogenic and contributes about -3 mV directly.',
              type: 'mechanism',
              sourceChunkIds: [slideChunks[2]],
              examinable: true,
              emphasis: 0.7,
            },
            // Deliberate duplicate of the one above it.
            {
              statement:
                'The Na+/K+ ATPase exports three Na+ for every two K+ imported, consuming one ATP per cycle.',
              type: 'mechanism',
              sourceChunkIds: [transcriptChunks[2]],
              examinable: true,
              emphasis: 0.6,
            },
          ],
        });
      }

      return JSON.stringify({
        concepts: [
          {
            statement:
              'In unmyelinated axons, conduction velocity scales with the square root of axon diameter.',
            type: 'relationship',
            sourceChunkIds: [slideChunks[6]],
            examinable: true,
            emphasis: 0.6,
          },
          {
            statement:
              'Myelin increases membrane resistance and decreases capacitance, so local circuit currents spread further before decaying.',
            type: 'mechanism',
            sourceChunkIds: [slideChunks[7], transcriptChunks[5]],
            examinable: true,
            emphasis: 0.9,
          },
          {
            statement:
              'Voltage-gated sodium channels are concentrated at the nodes of Ranvier, so the impulse regenerates only at the nodes and jumps between them.',
            type: 'mechanism',
            sourceChunkIds: [slideChunks[7], transcriptChunks[5]],
            examinable: true,
            emphasis: 0.95,
          },
          {
            statement:
              'In a myelinated axon, conduction velocity scales roughly linearly with diameter.',
            type: 'relationship',
            sourceChunkIds: [slideChunks[7]],
            examinable: false,
            emphasis: 0.4,
          },
          {
            statement:
              'In multiple sclerosis, demyelination slows or blocks conduction in affected tracts.',
            type: 'clinical',
            sourceChunkIds: [slideChunks[8]],
            examinable: true,
            emphasis: 0.5,
          },
          // Deliberately cites a chunk that belongs to another section.
          {
            statement:
              'The absolute refractory period exists because sodium channels are inactivated rather than closed.',
            type: 'mechanism',
            sourceChunkIds: [slideChunks[5]],
            examinable: true,
            emphasis: 0.8,
          },
        ],
      });
    },
  });
}

/**
 * Canned generation. It covers most concepts by explaining them in the words
 * the concept uses — which is the only thing the offline embedder can score —
 * and deliberately never covers one, so the coverage badge has something
 * honest to report.
 */
function scriptGeneration(): void {
  setStub({
    respond: (request) => {
      const quoted = [
        'Myelin increases membrane resistance and decreases capacitance, so local circuit currents spread further before decaying.',
        'Voltage-gated sodium channels are concentrated at the nodes of Ranvier, so the impulse regenerates only at the nodes and jumps between them.',
        'In unmyelinated axons, conduction velocity scales with the square root of axon diameter.',
        'In multiple sclerosis, demyelination slows or blocks conduction in affected tracts.',
      ].filter((statement) => request.prompt.includes(statement));

      return JSON.stringify({
        blocks: [
          {
            type: 'prose',
            markdown:
              'How quickly an axon conducts depends on its diameter and on whether it is myelinated. This section covers both, and why demyelination is so damaging.',
          },
          { type: 'heading', markdown: '## Conduction in unmyelinated axons' },
          ...quoted.map((statement) => ({ type: 'prose', markdown: statement })),
          {
            type: 'summary',
            markdown:
              '> Myelin speeds conduction by making local currents travel further, and by\n' +
              '> concentrating sodium channels at the nodes so the impulse only has to be\n' +
              '> regenerated there.',
          },
        ],
      });
    },
  });
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
