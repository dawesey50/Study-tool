/**
 * The novelty spike — plan v2, Step 7a.
 *
 *   npm run spike                          # the gate alone, on hand-written stems
 *   npm run spike -- --module <id> -n 30   # 30 real questions, gates on, examiner off
 *
 * WHY THIS EXISTS BEFORE THE ENGINE
 *
 * The whole question engine rests on one assumption: that filtering by
 * similarity produces questions that feel genuinely different to a person. If
 * it does not — if thirty questions past the gate still read as five questions
 * wearing hats — then no amount of prompt work downstream rescues it, and the
 * thresholds, or the approach, have to change. That is a day's finding, not a
 * week's, so it is worth having before six more days go on top of it.
 *
 * The examiner is deliberately off. This spike is about the gate, and an
 * examiner pass would hide a weak gate behind a second filter.
 *
 * WHAT THE TWO MODES ANSWER
 *
 * Mode A (no arguments) runs a set of stems written by hand for the purpose:
 * pairs that are the same question paraphrased, pairs that share wording but
 * ask different things, and questions that are properly distinct. You already
 * know which is which, so what the gate says about them tells you whether the
 * thresholds are anywhere near right — with no model, no key and no cost.
 *
 * Mode B needs a real key and a module with concepts. It generates N questions
 * for real and prints every survivor in full so you can read them and answer
 * the only question that matters: are these actually different questions?
 *
 * THE HONEST CAVEAT ON MODE A
 *
 * Cosine similarity is only meaningful with the real embedder. Under
 * EMBEDDINGS_PROVIDER=hash the vectors carry no meaning, so only the trigram
 * column is telling you anything, and the script says so rather than printing
 * numbers that look like evidence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    module: { type: 'string' },
    section: { type: 'string', multiple: true },
    n: { type: 'string', default: '30' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(
    [
      'npm run spike                        the gate alone, offline, on hand-written stems',
      'npm run spike -- --module <id>       generate real questions and print the survivors',
      '',
      '  --module <id>     module to generate for (needs concepts extracted)',
      '  --section <id>    restrict to a section; repeatable',
      '  -n <count>        how many to accept before stopping (default 30)',
    ].join('\n'),
  );
  process.exit(0);
}

const liveMode = Boolean(values.module);

// Mode A needs a database only to satisfy imports, and must never touch the
// real one: it writes scenario seeds and would otherwise pollute your data.
if (!liveMode) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-spike-'));
  process.env.DATA_DIR = tempDir;
}

const { initDb, closeDb } = await import('../server/src/db/index.js');
const { embedSafely, embedderStatus } = await import('../server/src/embeddings/index.js');
const { checkNovelty, trigramOverlap } = await import(
  '../server/src/services/questions/novelty.js'
);
const { config } = await import('../server/src/config.js');

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const amber = (text: string) => `\x1b[33m${text}\x1b[0m`;

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim('─'.repeat(text.length))}`);
}

initDb();

// ---------------------------------------------------------------------------
// Mode A — the gate on stems whose answer you already know
// ---------------------------------------------------------------------------

/**
 * `same` marks the ones the gate ought to reject. They are written to be hard
 * in both directions: the paraphrases share almost no wording, and two of the
 * distinct pairs share a great deal of it. A gate that only catches copied
 * words will fail the first group; one that only catches shared topics will
 * fail the second.
 */
interface Probe {
  stem: string;
  /** The stem this is a duplicate of, by index. Null means it should pass. */
  duplicateOf: number | null;
  note: string;
}

const PROBES: Probe[] = [
  {
    stem: 'Oligomycin is added to isolated mitochondria respiring on succinate. What happens to the rate of oxygen consumption, and why?',
    duplicateOf: null,
    note: 'the original',
  },
  {
    stem: 'Isolated mitochondria are given succinate and then treated with oligomycin. Explain the change you would expect in oxygen uptake.',
    duplicateOf: 0,
    note: 'same question, reworded — the case embeddings should catch and trigrams may not',
  },
  {
    stem: 'A patient with a mutation in ATP synthase presents with exercise intolerance. Why does their muscle produce lactate at a lower workload than normal?',
    duplicateOf: null,
    note: 'same enzyme, different reasoning — must pass',
  },
  {
    stem: 'Oligomycin is added to isolated mitochondria respiring on succinate. What happens to the proton motive force, and why?',
    duplicateOf: 0,
    note: 'one word changed — the case trigrams should catch outright',
  },
  {
    stem: 'In skeletal muscle during maximal exercise, why does the cell continue to regenerate NAD+ when oxygen is not limiting?',
    duplicateOf: null,
    note: 'different concept entirely — must pass',
  },
  {
    stem: 'During maximal exercise in skeletal muscle, explain why NAD+ regeneration continues even though oxygen supply is adequate.',
    duplicateOf: 4,
    note: 'reordered clauses, identical question',
  },
  {
    stem: 'A Lineweaver-Burk plot shows two lines meeting on the y-axis. What kind of inhibition is this, and what does it tell you about the binding site?',
    duplicateOf: null,
    note: 'different topic — must pass',
  },
  {
    stem: 'Two lines on a Lineweaver-Burk plot intersect on the x-axis instead. Which parameter is unchanged, and why does that follow from the mechanism?',
    duplicateOf: null,
    note: 'shares wording with 6 but tests the opposite case — must pass',
  },
];

async function runGateProbe(): Promise<void> {
  heading('Mode A — the novelty gate on stems written to test it');

  const status = embedderStatus();
  const semantic = config.embeddings.provider === 'local';
  console.log(
    `Embedder: ${status.provider}${status.model ? ` (${status.model})` : ''}` +
      (semantic
        ? ''
        : amber(
            '\n  Hash embeddings carry no meaning, so the cosine column below is noise.' +
              '\n  Only the trigram column is evidence. Re-run with EMBEDDINGS_PROVIDER=local.',
          )),
  );
  console.log(
    dim(
      `Thresholds: cosine ≥ ${config.questions.cosineLimit} or trigram ≥ ${config.questions.trigramLimit} rejects.`,
    ),
  );

  const vectors = await embedSafely(PROBES.map((probe) => probe.stem));
  const bank: Array<{ id: string; stem: string; embedding: Float32Array | null; source: 'generated' }> =
    [];

  let correct = 0;
  const misses: string[] = [];

  for (const [index, probe] of PROBES.entries()) {
    const verdict = checkNovelty({
      stem: probe.stem,
      embedding: vectors[index] ?? null,
      signature: `probe-${index}`,
      existing: bank,
      usedSignatures: new Set(),
    });

    const shouldReject = probe.duplicateOf !== null;
    const right = verdict.accepted !== shouldReject;
    if (right) correct += 1;
    else {
      misses.push(
        shouldReject
          ? `#${index} let through, but it repeats #${probe.duplicateOf}`
          : `#${index} rejected, but it is a genuinely different question`,
      );
    }

    console.log(
      `\n${bold(`#${index}`)} ${dim(probe.note)}\n  ${probe.stem}\n  ` +
        (verdict.accepted ? green('accepted') : red(`rejected — ${verdict.reason}`)) +
        dim(
          `  cosine ${verdict.cosine.toFixed(2)}  trigram ${verdict.trigram.toFixed(2)}` +
            `  ${right ? 'as expected' : 'NOT AS EXPECTED'}`,
        ),
    );

    // Only accepted stems enter the bank, exactly as in a real run: a rejected
    // question is never stored, so it never becomes something to compare to.
    if (verdict.accepted) {
      bank.push({
        id: `probe-${index}`,
        stem: probe.stem,
        embedding: vectors[index] ?? null,
        source: 'generated',
      });
    }
  }

  heading('What the gate got right');
  console.log(`${correct}/${PROBES.length} verdicts matched what a person would say.`);
  for (const miss of misses) console.log(`  ${amber('·')} ${miss}`);

  if (!semantic || vectors.every((vector) => vector === null)) {
    console.log(
      amber(
        '\nNo usable embeddings, so only the trigram check ran. Every miss above is a\n' +
          'paraphrase, and that is the finding rather than an excuse: trigrams catch\n' +
          'copy-paste and nothing subtler, so a run without the embedder is close to\n' +
          'no novelty gate at all. Generation reports this as admittedWithoutEmbeddings\n' +
          'rather than letting it pass quietly. The cosine half needs\n' +
          'EMBEDDINGS_PROVIDER=local and a machine that can fetch the model.',
      ),
    );
  }

  // The pairwise trigram table is the part that is meaningful offline, and it
  // is what you would tune QUESTION_TRIGRAM_LIMIT from.
  heading('Pairwise wording overlap');
  console.log(dim('Rows against columns. Pairs marked * are the same question.'));
  const header = PROBES.map((_, index) => `  #${index}`).join('');
  console.log(dim(`    ${header}`));
  for (const [row, probe] of PROBES.entries()) {
    const cells = PROBES.map((other, column) => {
      if (row === column) return '   ·';
      const overlap = trigramOverlap(probe.stem, other.stem);
      const same = probe.duplicateOf === column || other.duplicateOf === row;
      const text = overlap.toFixed(2).slice(1); // ".42"
      return same ? bold(` ${text}*`) : ` ${text} `;
    }).join('');
    console.log(`${dim(`#${row}`)}  ${cells}`);
  }

  console.log(
    '\nThe judgement to make: are the starred cells consistently above the limit,\n' +
      'and the unstarred ones consistently below it? If they overlap, no single\n' +
      'threshold separates them and the gate needs a different signal, not a\n' +
      'different number.',
  );
}

// ---------------------------------------------------------------------------
// Mode B — generate for real and read what survives
// ---------------------------------------------------------------------------

async function runLive(moduleId: string, count: number): Promise<void> {
  const { getDb, schema } = await import('../server/src/db/index.js');
  const { eq } = await import('drizzle-orm');
  const { generateQuestions } = await import('../server/src/services/questions/generate.js');
  const { routingTable } = await import('../server/src/llm/routing.js');

  const db = getDb();
  const module = db.select().from(schema.modules).where(eq(schema.modules.id, moduleId)).get();
  if (!module) {
    console.error(red(`No module with id ${moduleId}.`));
    process.exitCode = 1;
    return;
  }

  const routing = routingTable().find((row) => row.task === 'question_generation');
  heading(`Mode B — ${count} questions for "${module.title}"`);
  console.log(
    `Model: ${routing?.effectiveModel ?? 'unknown'} via ${routing?.effectiveProvider ?? 'unknown'}` +
      (routing?.substituted ? amber(' (substituted — the configured model is unavailable)') : ''),
  );
  console.log(dim('Examiner: off. This spike is about the gate.\n'));

  const before = db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all().length;

  const result = await generateQuestions({
    moduleId,
    count,
    skipExaminer: true,
    ...(values.section?.length ? { sectionIds: values.section } : {}),
    onProgress: (done, total, stem) => {
      console.log(`${green(`${done}/${total}`)} ${stem}`);
    },
  });

  heading('Survivors');
  const stored = db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all()
    .filter((row) => result.questionIds.includes(row.id));

  for (const [index, question] of stored.entries()) {
    const blueprint = question.blueprintJson as Record<string, unknown> | null;
    console.log(
      `\n${bold(`${index + 1}. ${question.stem}`)}\n` +
        dim(
          `   ${String(blueprint?.archetype ?? '?')} · ${question.format} · ${question.bloomLevel ?? '?'}`,
        ),
    );
    for (const option of question.optionsJson ?? []) {
      console.log(
        `   ${option.correct ? green('✓') : dim('·')} ${option.text}` +
          (option.whyWrong ? dim(`\n       ${option.whyWrong}`) : ''),
      );
    }
  }

  heading('Rejections');
  const byReason = new Map<string, number>();
  for (const rejection of result.rejected) {
    byReason.set(rejection.reason ?? 'unknown', (byReason.get(rejection.reason ?? 'unknown') ?? 0) + 1);
  }
  if (byReason.size === 0) console.log(dim('None — every generated question passed the gate.'));
  for (const [reason, tally] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(tally).padStart(3)}  ${reason.replace(/_/g, ' ')}`);
  }
  for (const rejection of result.rejected.slice(0, 8)) {
    if (rejection.detail) console.log(dim(`\n  "${rejection.stem}"\n    ${rejection.detail}`));
  }

  heading('The numbers');
  const attempted = result.accepted + result.rejected.length;
  console.log(`  accepted            ${result.accepted} of ${count} asked for`);
  console.log(`  model calls         ${attempted}`);
  console.log(
    `  acceptance rate     ${attempted ? Math.round((result.accepted / attempted) * 100) : 0}%`,
  );
  console.log(`  blueprints dropped  ${result.blueprintsResampled}`);
  if (result.admittedWithoutEmbeddings > 0) {
    console.log(
      amber(
        `  no embedding        ${result.admittedWithoutEmbeddings} admitted on wording alone — ` +
          'the gate was barely running for these',
      ),
    );
  }
  console.log(`  cost                $${result.costUsd.toFixed(4)}`);
  console.log(`  bank size           ${before} → ${before + result.accepted}`);

  console.log(
    '\n' +
      bold('Now read them.') +
      ' The numbers above cannot answer the question this spike\n' +
      'exists for. Read the survivors as a set and ask whether they are genuinely\n' +
      'different questions or the same few questions in different clothes. If it is\n' +
      'the latter, raising the thresholds will only shrink the bank — the fix is in\n' +
      'the blueprint sampling, not the gate.',
  );
}

try {
  if (liveMode) await runLive(values.module!, Number(values.n) || 30);
  else await runGateProbe();
} finally {
  closeDb();
}
