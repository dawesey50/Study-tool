/**
 * A report on what actually happened, written for someone who cannot see your
 * screen.
 *
 *   npm run report              # everything, with short excerpts
 *   npm run report -- --full    # longer excerpts, for judging writing quality
 *   npm run report -- --quiet   # counts and warnings only, no material at all
 *
 * WHY THIS EXISTS
 *
 * Every threshold in this system is a guess, no real lecture has been through
 * it, and no real model has written anything. The only way to find out whether
 * any of it works is for you to put your own material through — and then the
 * findings live on your machine, in a database nobody else can see.
 *
 * So this writes one file you can read, then paste or send. It is deliberately
 * a diagnostic rather than a dashboard: it reports the numbers that would
 * reveal a threshold set wrongly, the places where a stage produced nothing,
 * and a handful of actual concepts, notes and questions — because counts can
 * look perfect while the writing is useless, and only the writing answers the
 * question this project exists to ask.
 *
 * WHAT IT DOES NOT INCLUDE
 *
 * Never your API keys — only whether one is set. Never whole documents; the
 * excerpts are capped and counted. `--quiet` drops the material entirely if
 * you would rather show the shape without the substance.
 *
 * READ IT BEFORE YOU SEND IT. It contains your own coursework, which is yours
 * to share or not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    full: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    module: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(
    [
      'npm run report                 everything, with short excerpts',
      'npm run report -- --full       longer excerpts, for judging the writing',
      'npm run report -- --quiet      counts and warnings only, no material',
      '',
      '  --module <id>   just one module',
      '  --out <path>    where to write it (default: data/report-<date>.md)',
    ].join('\n'),
  );
  process.exit(0);
}

const { config, repoRoot } = await import('../server/src/config.js');
const { initDb, getDb, schema, closeDb, isVecAvailable } = await import('../server/src/db/index.js');
const { embedderStatus } = await import('../server/src/embeddings/index.js');
const { routingTable } = await import('../server/src/llm/routing.js');
const { flatten, getTree } = await import('../server/src/services/sections.js');
const { revisionSummary } = await import('../server/src/services/schedule.js');
const { conceptMap } = await import('../server/src/services/conceptMap.js');
const { keyDistribution, longestRun } = await import(
  '../server/src/services/questions/balance.js'
);
const { eq, inArray, desc } = await import('drizzle-orm');

const EXCERPT = values.full ? 400 : 160;
const SAMPLES = values.full ? 8 : 4;

const out: string[] = [];

/**
 * Warnings are collected by message rather than as a flat list.
 *
 * The first version pushed one line per module and a database with nine
 * modules in it produced nine copies of "the answer keys are skewed", which
 * buries the one warning that only fired once. Grouping keeps the rare finding
 * visible, which is the whole reason to have a warnings section.
 */
const warnings = new Map<string, Set<string>>();
/** Set while walking a module, so a warning knows what it is about. */
let scope = '';

const line = (text = '') => out.push(text);
const heading = (text: string) => {
  line();
  line(`## ${text}`);
  line();
};
const sub = (text: string) => {
  line();
  line(`### ${text}`);
  line();
};
const warn = (text: string) => {
  const where = warnings.get(text) ?? new Set<string>();
  if (scope) where.add(scope);
  warnings.set(text, where);
};
const excerpt = (text: string | null | undefined, limit = EXCERPT): string => {
  if (values.quiet) return '(hidden — run without --quiet to include)';
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '(empty)';
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
};
const pct = (value: number) => `${Math.round(value * 100)}%`;

initDb();
const db = getDb();

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

line('# Processor — diagnostic report');
line();
line(`Generated ${new Date().toISOString()}`);
line();
line(
  values.quiet
    ? '**Mode: quiet.** Counts and warnings only — no text from your material.'
    : values.full
      ? '**Mode: full.** Longer excerpts, so the writing can be judged.'
      : '**Mode: normal.** Short excerpts.',
);
line();
line(
  '> Read this before sending it. It contains excerpts of your own coursework. ' +
    'It never contains API keys.',
);

// ---------------------------------------------------------------------------
// Environment — the things that silently change what the system can do
// ---------------------------------------------------------------------------

heading('Environment');

const embedder = embedderStatus();
line(`- Node: ${process.version}`);
line(`- Data directory: ${config.dataDir}`);
line(
  `- Embeddings: **${embedder.provider}** (${embedder.state})` +
    (embedder.state === 'unavailable' ? ` — ${(embedder as { reason?: string }).reason}` : ''),
);
line(`- Vector index: ${isVecAvailable() ? 'sqlite-vec' : 'brute force'}`);

if (config.embeddings.provider === 'hash') {
  warn(
    'The embedder is set to `hash`, which has no semantic understanding. Section mapping, ' +
      'the coverage check, concept dedupe and half the novelty gate are all meaningless in ' +
      'this state. Set EMBEDDINGS_PROVIDER=local in .env.',
  );
}
if (embedder.state === 'unavailable') {
  warn(
    'The embedder failed to load, so anything needing a vector silently degraded. The ' +
      'novelty gate in particular falls back to word overlap, which catches copy-paste and ' +
      'very little else.',
  );
}

sub('Model routing');
// Collected rather than warned per row: with no key at all, every task is
// unavailable for the same reason, and eight identical lines bury the
// warnings that are actually specific to your setup.
const unavailableTasks: string[] = [];
line('| Task | Configured | Will actually run | Note |');
line('|---|---|---|---|');
for (const row of routingTable()) {
  line(
    `| ${row.task} | ${row.configuredModel} | ${row.effectiveModel ?? '—'}` +
      `${row.effectiveProvider ? ` (${row.effectiveProvider})` : ''} | ` +
      `${!row.available ? '**no provider configured**' : row.substituted ? 'substituted' : ''} |`,
  );
  if (!row.available) unavailableTasks.push(row.task);
  else if (row.substituted) {
    warn(
      `\`${row.task}\` is configured for ${row.configuredModel} but will run on ` +
        `${row.effectiveModel} — the configured provider has no key.`,
    );
  }
}

const noKeys = Object.values(config.llm.keys).every((key) => !key) && !config.llm.forceProvider;
if (unavailableTasks.length > 0 && !noKeys) {
  warn(
    `No provider is configured for: ${unavailableTasks.join(', ')}. Those steps cannot run.`,
  );
}

// Keys: whether, never what.
sub('Keys');
for (const [name, key] of Object.entries(config.llm.keys)) {
  line(`- ${name}: ${key ? 'set' : '**not set**'}`);
}
if (noKeys) {
  warn(
    'No API key is set, so nothing that needs a model can run at all — that is the single ' +
      'reason every task above shows no provider. Put ANTHROPIC_API_KEY in .env.',
  );
}

sub('Thresholds in force');
line('Every one of these is an untuned guess. This is what they were set to for this run.');
line();
line('```');
for (const [group, values_] of [
  ['concepts', config.concepts],
  ['generation', config.generation],
  ['pastPapers', config.pastPapers],
  ['questions', config.questions],
  ['schedule', config.schedule],
  ['ingest', config.ingest],
] as const) {
  for (const [key, value] of Object.entries(values_)) {
    if (typeof value === 'number') line(`${group}.${key} = ${value}`);
  }
}
line('```');

// ---------------------------------------------------------------------------
// Per module
// ---------------------------------------------------------------------------

const modules = db
  .select()
  .from(schema.modules)
  .all()
  .filter((module) => !values.module || module.id === values.module);

if (modules.length === 0) {
  heading('Modules');
  line('None. Nothing has been put through the system yet.');
}

for (const module of modules) {
  scope = module.title;
  heading(`Module: ${module.title}`);
  line(`\`${module.id}\``);

  const nodes = flatten(getTree(module.id));
  const sources = db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.moduleId, module.id))
    .all();

  // --- ingestion ----------------------------------------------------------
  sub('Sources');
  if (sources.length === 0) {
    line('None uploaded.');
  } else {
    line('| Title | Type | Status | Pages | Chunks | Figures | Mapped to |');
    line('|---|---|---|---|---|---|---|');
    for (const source of sources) {
      const chunks = db
        .select()
        .from(schema.chunks)
        .where(eq(schema.chunks.sourceId, source.id))
        .all();
      const figures = db
        .select()
        .from(schema.figures)
        .where(eq(schema.figures.sourceId, source.id))
        .all();
      const mappings = db
        .select()
        .from(schema.sourceSections)
        .where(eq(schema.sourceSections.sourceId, source.id))
        .all();

      line(
        `| ${source.title} | ${source.type} | ${source.status} | ${source.pageCount ?? '—'} | ` +
          `${chunks.length} | ${figures.length} | ${mappings.length} sections |`,
      );

      if (source.status === 'failed') warn(`Source "${source.title}" failed: ${source.error}`);
      if (source.status === 'ingested' && chunks.length === 0) {
        warn(
          `"${source.title}" ingested but produced no chunks — almost always a scanned PDF ` +
            'with no text layer.',
        );
      }
      if (source.status === 'ingested' && chunks.length > 0 && mappings.length === 0) {
        warn(
          `"${source.title}" has ${chunks.length} chunks but mapped to no section. ` +
            'CHUNK_MATCH_THRESHOLD (0.25, in mapping.ts) may be too high for this material.',
        );
      }

      // The mapping scores are the number to tune from, so they are printed
      // rather than summarised.
      if (mappings.length > 0) {
        const scores = mappings
          .map((mapping) => mapping.score)
          .filter((score): score is number => score !== null)
          .sort((a, b) => b - a);
        if (scores.length > 0) {
          line();
          line(
            `  Mapping scores: ${scores.map((score) => score.toFixed(2)).join(', ')} ` +
              `(${mappings.filter((mapping) => mapping.confirmed).length} confirmed by hand)`,
          );
          line();
        }
      }
    }

    // Chunk sizes reveal whether the chunker suits your material.
    const allChunks = db
      .select({ text: schema.chunks.text, sourceId: schema.chunks.sourceId })
      .from(schema.chunks)
      .where(
        inArray(
          schema.chunks.sourceId,
          sources.map((source) => source.id),
        ),
      )
      .all();
    if (allChunks.length > 0) {
      const lengths = allChunks.map((chunk) => chunk.text.length).sort((a, b) => a - b);
      const median = lengths[Math.floor(lengths.length / 2)]!;
      line();
      line(
        `Chunks: ${lengths.length}, median ${median} chars ` +
          `(target ${config.ingest.chunkTargetChars}), shortest ${lengths[0]}, ` +
          `longest ${lengths[lengths.length - 1]}`,
      );
      const tiny = lengths.filter((length) => length < 120).length;
      if (tiny > lengths.length * 0.3) {
        warn(
          `${tiny} of ${lengths.length} chunks are under 120 characters. Slide decks with ` +
            'very sparse text chunk badly, and everything downstream inherits it.',
        );
      }
    }
  }

  // --- sections and concepts ----------------------------------------------
  sub('Sections and concepts');
  if (nodes.length === 0) {
    line('No sections.');
    if (sources.length > 0) warn(`"${module.title}" has material but no section hierarchy.`);
  } else {
    const concepts = db
      .select()
      .from(schema.concepts)
      .where(
        inArray(
          schema.concepts.sectionId,
          nodes.map((node) => node.id),
        ),
      )
      .all();

    const blocks = db
      .select()
      .from(schema.noteBlocks)
      .where(
        inArray(
          schema.noteBlocks.sectionId,
          nodes.map((node) => node.id),
        ),
      )
      .all();

    line('| Section | Concepts | Examinable | Note blocks | Yours |');
    line('|---|---|---|---|---|');
    for (const node of nodes) {
      const mine = concepts.filter((concept) => concept.sectionId === node.id);
      const myBlocks = blocks.filter((block) => block.sectionId === node.id);
      line(
        `| ${node.number} ${node.title} | ${mine.length} | ` +
          `${mine.filter((concept) => concept.examinableFlag).length} | ${myBlocks.length} | ` +
          `${myBlocks.filter((block) => block.origin !== 'ai_generated').length} |`,
      );
    }

    const withMaterial = nodes.filter((node) =>
      db
        .select()
        .from(schema.sourceSections)
        .where(eq(schema.sourceSections.sectionId, node.id))
        .all().length > 0,
    );
    const emptyWithMaterial = withMaterial.filter(
      (node) => concepts.filter((concept) => concept.sectionId === node.id).length === 0,
    );
    if (emptyWithMaterial.length > 0) {
      warn(
        `${emptyWithMaterial.length} section(s) have material mapped but no concepts ` +
          'extracted yet — everything downstream is empty for them.',
      );
    }

    const uncited = concepts.filter((concept) => (concept.sourceChunkIds ?? []).length === 0);
    if (uncited.length > 0) {
      warn(
        `${uncited.length} concept(s) cite no source chunk. Those cannot be traced back to ` +
          'the material, which is the guarantee the whole system rests on.',
      );
    }

    if (concepts.length > 0 && !values.quiet) {
      line();
      line(`**A sample of the concepts** — read these, they drive everything downstream:`);
      line();
      for (const concept of concepts.slice(0, SAMPLES)) {
        const section = nodes.find((node) => node.id === concept.sectionId);
        line(
          `- [${concept.type}${concept.examinableFlag ? ', examinable' : ''}] ` +
            `${excerpt(concept.statement)}  \n  _${section?.number} ${section?.title}, ` +
            `${(concept.sourceChunkIds ?? []).length} citation(s)_`,
        );
      }
    }

    // --- notes -------------------------------------------------------------
    if (blocks.length > 0 && !values.quiet) {
      sub('A sample of the notes');
      line('The thing to judge: would you revise from this?');
      line();
      for (const block of blocks.slice(0, SAMPLES)) {
        line(`- **[${block.type}, ${block.origin}]** ${excerpt(block.markdown)}`);
      }
    }
  }

  // --- questions -----------------------------------------------------------
  sub('Questions');
  const questions = db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, module.id))
    .orderBy(desc(schema.questions.createdAt))
    .all();

  if (questions.length === 0) {
    line('None.');
  } else {
    const generated = questions.filter((question) => question.source === 'generated');
    const papers = questions.filter((question) => question.source === 'past_paper');
    line(`- Generated: ${generated.length}`);
    line(`- From real papers: ${papers.length}`);

    const byFormat = new Map<string, number>();
    const byArchetype = new Map<string, number>();
    const byBloom = new Map<string, number>();
    for (const question of generated) {
      byFormat.set(question.format, (byFormat.get(question.format) ?? 0) + 1);
      const archetype = String(
        (question.blueprintJson as { archetype?: string } | null)?.archetype ?? 'unknown',
      );
      byArchetype.set(archetype, (byArchetype.get(archetype) ?? 0) + 1);
      const bloom = question.bloomLevel ?? 'unknown';
      byBloom.set(bloom, (byBloom.get(bloom) ?? 0) + 1);
    }

    if (generated.length > 0) {
      line();
      line(`- Formats: ${[...byFormat].map(([key, n]) => `${key} ${n}`).join(', ')}`);
      line(`- Archetypes: ${[...byArchetype].map(([key, n]) => `${key} ${n}`).join(', ')}`);
      line(`- Bloom: ${[...byBloom].map(([key, n]) => `${key} ${n}`).join(', ')}`);

      // The single most useful number about a bank: how many different shapes
      // it actually contains.
      if (byArchetype.size <= 3 && generated.length >= 10) {
        warn(
          `Only ${byArchetype.size} archetype(s) across ${generated.length} generated ` +
            'questions. Blueprint sampling is supposed to produce far more variety than ' +
            'that — this is the failure the whole engine exists to prevent.',
        );
      }

      const mcqs = generated
        .filter((question) => (question.optionsJson ?? []).length > 0)
        .map((question) => ({ id: question.id, options: question.optionsJson ?? [] }));
      if (mcqs.length > 1) {
        const distribution = keyDistribution(mcqs);
        const run = longestRun(mcqs);
        line(
          `- Answer keys across ${mcqs.length} MCQs: ` +
            `${distribution.map((n, i) => `${String.fromCharCode(65 + i)}=${n}`).join(' ')}` +
            `, longest run ${run}`,
        );
        const even = mcqs.length / Math.max(1, distribution.length);
        if (distribution.some((count) => Math.abs(count - even) > even * 0.6)) {
          warn(
            'The answer keys are badly skewed towards one position, which means the bank is ' +
              'scoreable above chance without knowing the material.',
          );
        }
        if (run > 2) warn(`${run} questions in a row share the same answer letter.`);
      }

      const scored = generated.filter((question) => question.criticScore !== null);
      if (scored.length > 0) {
        const mean =
          scored.reduce((sum, question) => sum + (question.criticScore ?? 0), 0) / scored.length;
        line(`- Examiner score: mean ${mean.toFixed(2)}/5 across ${scored.length} questions`);
        if (mean > 4.8) {
          warn(
            `The examiner's mean score is ${mean.toFixed(2)}/5. It was told a 5 across the ` +
              'board should be rare, so a mean this high suggests it is rubber-stamping ' +
              'rather than marking.',
          );
        }
      }

      const orphans = generated.filter((question) => (question.conceptIds ?? []).length === 0);
      if (orphans.length > 0) {
        warn(`${orphans.length} generated question(s) are tied to no concept.`);
      }
    }

    if (papers.length > 0 && !values.quiet) {
      line();
      line('**Extracted from real papers** — check these are actually questions:');
      line();
      for (const question of papers.slice(0, SAMPLES)) {
        const blueprint = (question.blueprintJson ?? {}) as { number?: string; marks?: number };
        line(
          `- **${blueprint.number ?? '?'}** ${excerpt(question.stem)}` +
            (blueprint.marks ? ` _[${blueprint.marks} marks]_` : ''),
        );
      }
    }

    if (generated.length > 0 && !values.quiet) {
      line();
      line('**Generated questions** — the ones to actually read:');
      line();
      for (const question of generated.slice(0, SAMPLES)) {
        const blueprint = (question.blueprintJson ?? {}) as { archetype?: string };
        line(`- _${blueprint.archetype ?? '?'} · ${question.format}_ — ${excerpt(question.stem)}`);
        for (const option of question.optionsJson ?? []) {
          line(`    - ${option.correct ? '**✓**' : '·'} ${excerpt(option.text, 90)}`);
        }
      }
    }
  }

  // --- revision ------------------------------------------------------------
  sub('Revision');
  const summary = revisionSummary(module.id);
  line(`- Concepts: ${summary.concepts}, ever tested: ${summary.reviewed}`);
  line(`- Due now: ${summary.due} (${summary.dueOverdue} overdue, ${summary.dueNew} never seen)`);
  line(`- Mastery across every concept: ${pct(summary.mastery)}`);
  if (summary.misconceptions.length > 0) {
    line(`- Answered wrongly while certain: ${summary.misconceptions.length} concept(s)`);
  }

  const attempts = questions.length
    ? db
        .select()
        .from(schema.attempts)
        .where(
          inArray(
            schema.attempts.questionId,
            questions.map((question) => question.id),
          ),
        )
        .all()
    : [];
  line(`- Attempts recorded: ${attempts.length}`);
  const noConfidence = attempts.filter((attempt) => attempt.confidenceRating === null).length;
  if (attempts.length > 0 && noConfidence === attempts.length) {
    warn(
      'No attempt has a confidence rating. The confident-and-wrong signal — the most useful ' +
        'thing the scheduler learns — is not being collected.',
    );
  }

  // --- the map -------------------------------------------------------------
  const map = conceptMap(module.id);
  if (map.nodes.length > 0) {
    sub('Concept map');
    line(`- ${map.nodes.length} concepts, ${map.edges.length} links`);
    line(`- Cross-section links: ${map.edges.filter((edge) => edge.crossSection).length}`);
    if (map.isolatedSections.length > 0) {
      line(`- Sections connecting to nothing: ${map.isolatedSections.join(', ')}`);
    }
    if (map.edges.length === 0 && map.nodes.length > 20) {
      warn(
        'No concept links at all across ' +
          `${map.nodes.length} concepts. Ownership assignment runs at the end of a ` +
          'module-wide extraction — if you only extracted one section, that is expected.',
      );
    }
  }

  // --- exams ---------------------------------------------------------------
  const exams = db.select().from(schema.exams).where(eq(schema.exams.moduleId, module.id)).all();
  if (exams.length > 0) {
    sub('Mock exams');
    for (const exam of exams) {
      line(
        `- ${exam.title}: ${(exam.questionIds ?? []).length} questions, ` +
          (exam.submittedAt
            ? exam.score !== null
              ? `scored ${pct(exam.score)} of what could be marked`
              : 'submitted, nothing auto-markable'
            : 'not submitted'),
      );
    }
  }
}

scope = '';

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

heading('Model calls');

const calls = db.select().from(schema.llmCalls).all();
if (calls.length === 0) {
  line('None. Nothing has run against a model.');
} else {
  const failed = calls.filter((call) => call.status === 'error');
  const cached = calls.filter((call) => call.status === 'cached');
  const costUsd = calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);

  line(`- Calls: ${calls.length} (${cached.length} served from cache, ${failed.length} failed)`);
  line(`- Cost so far: $${costUsd.toFixed(4)} ≈ £${(costUsd * config.llm.usdToGbp).toFixed(4)}`);

  const unpriced = calls.filter((call) => call.costUsd === null && call.status === 'ok').length;
  if (unpriced > 0) {
    line(`- ${unpriced} call(s) had no price on file, so the cost above is an underestimate.`);
  }

  const byTask = new Map<string, { calls: number; tokens: number }>();
  for (const call of calls) {
    const entry = byTask.get(call.task) ?? { calls: 0, tokens: 0 };
    entry.calls += 1;
    entry.tokens += (call.inputTokens ?? 0) + (call.outputTokens ?? 0);
    byTask.set(call.task, entry);
  }
  line();
  line('| Task | Calls | Tokens |');
  line('|---|---|---|');
  for (const [task, entry] of byTask) line(`| ${task} | ${entry.calls} | ${entry.tokens} |`);

  if (failed.length > 0) {
    line();
    line('**Failures** — these are the ones to look at:');
    line();
    for (const call of failed.slice(0, 10)) {
      line(`- ${call.task} on ${call.model}: ${excerpt(call.error, 200)}`);
    }
    warn(`${failed.length} model call(s) failed.`);
  }
}

// ---------------------------------------------------------------------------
// Warnings last, so they are the thing you read
// ---------------------------------------------------------------------------

const body = out.join('\n');
const header: string[] = [];

header.push('');
header.push('## What looks wrong');
header.push('');
if (warnings.size === 0) {
  header.push('Nothing obviously broken. That is not the same as it being any good — ' +
    'the counts can be perfect while the writing is useless, which is why the excerpts ' +
    'above matter more than the numbers.');
} else {
  for (const [text, where] of warnings) {
    const modules_ =
      where.size === 0
        ? ''
        : where.size <= 3
          ? ` _(${[...where].join(', ')})_`
          : ` _(${where.size} modules)_`;
    header.push(`- ${text}${modules_}`);
  }
}
header.push('');
header.push('---');

const target = values.out
  ? path.resolve(values.out)
  : path.join(config.dataDir, `report-${new Date().toISOString().slice(0, 10)}.md`);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${body.split('\n').slice(0, 8).join('\n')}\n${header.join('\n')}\n${body.split('\n').slice(8).join('\n')}\n`);

closeDb();

// What the person running it sees.
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const amber = (text: string) => `\x1b[33m${text}\x1b[0m`;

console.log(`\n${bold('Report written to')} ${target}`);
console.log(dim(`${(fs.statSync(target).size / 1024).toFixed(1)} KB`));

if (warnings.size > 0) {
  console.log(`\n${bold(`${warnings.size} thing(s) look wrong:`)}`);
  for (const [text, where] of warnings) {
    const suffix = where.size > 1 ? dim(` (${where.size} modules)`) : '';
    console.log(`  ${amber('·')} ${text.replace(/`/g, '')}${suffix}`);
  }
} else {
  console.log(`\n${dim('Nothing obviously broken.')}`);
}

console.log(
  `\n${dim(
    'Read it before you send it — it contains excerpts of your own material.\n' +
      'It never contains API keys. Use --quiet to leave the material out entirely.',
  )}\n`,
);

void repoRoot;
