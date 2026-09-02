import { asc, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { indexVector, removeVector } from '../db/vectorIndex.js';
import { embedSafely } from '../embeddings/index.js';
import { newId } from '../lib/ids.js';
import { toBlob } from '../lib/vector.js';
import { complete, startRun, type LlmRun } from '../llm/index.js';
import {
  coverageGapPrompt,
  DEFAULT_NOTE_FORMAT,
  NOTE_GENERATION_SCHEMA,
  NOTE_GENERATION_SYSTEM,
  noteGenerationPrompt,
  type ConceptForPrompt,
} from '../llm/prompts.js';
import { chunksForSection, listConcepts } from './concepts.js';
import { flatten, getTree } from './sections.js';
import { takeSnapshot } from './snapshots.js';

/**
 * Note generation, and the coverage check that makes it trustworthy.
 *
 * Two promises are kept here that the rest of the system has only ever made in
 * comments. Anything you wrote, and anything you locked, survives a generation
 * run untouched — the run replaces generated blocks in place and nothing else.
 * And the notes are checked against the concept list rather than assumed to
 * cover it: every concept is matched against what was actually written, and
 * what is still missing is reported.
 *
 * The coverage loop is capped. A supplementary pass that has not closed the
 * gap in three attempts is not going to close it in thirty, and the failure
 * mode of not capping it is a bill arriving for a section that was never going
 * to converge. What is still uncovered is surfaced instead, because a badge
 * reading 44/47 with the three named is worth more than one reading 47/47
 * because the loop was allowed to keep trying.
 */

export type NoteBlockRow = typeof schema.noteBlocks.$inferSelect;

/**
 * Cosine above which a note block counts as explaining a concept.
 *
 * Untuned, like every other threshold here, and this one deserves particular
 * suspicion: it decides whether the coverage badge tells the truth. Set it too
 * low and the badge reads full while concepts are only mentioned in passing.
 */
const COVERAGE_THRESHOLD = config.generation.coverageThreshold;
/** Cosine above which a figure's caption is about a block's content. */
const FIGURE_MATCH_THRESHOLD = config.generation.figureThreshold;

export interface CoverageEntry {
  conceptId: string;
  statement: string;
  examinable: boolean;
  score: number;
  covered: boolean;
}

export interface Coverage {
  total: number;
  covered: number;
  /** Empty when everything is covered. Named, so it can be acted on. */
  uncovered: CoverageEntry[];
  /** How many supplementary passes ran, and why the loop ended. */
  passes: number;
  /** The cap stopped it — there were more attempts available in principle. */
  hitPassLimit: boolean;
  /** A pass stopped making progress, so continuing would only have cost money. */
  stoppedEarly: boolean;
  /** False when embeddings were unavailable, so coverage could not be measured. */
  measured: boolean;
}

export interface GenerationResult {
  sectionId: string;
  blocksWritten: number;
  blocksPreserved: number;
  figuresPlaced: number;
  coverage: Coverage;
  snapshotId: string;
  costUsd: number;
}

interface GeneratedBlock {
  type: schema.NoteBlockType;
  markdown: string;
  conceptIds?: string[];
}

export interface GenerateOptions {
  sectionId: string;
  run?: LlmRun;
  signal?: AbortSignal;
  fresh?: boolean;
}

export async function generateNotes(options: GenerateOptions): Promise<GenerationResult> {
  const db = getDb();
  const section = db
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.id, options.sectionId))
    .get();
  if (!section) throw new Error('Section not found');

  const concepts = listConcepts(options.sectionId);
  if (concepts.length === 0) {
    throw new Error(
      'This section has no concepts yet. Extract them first — notes are written against the ' +
        'concept list, and without one there is nothing to write against or to check coverage ' +
        'of.',
    );
  }

  const chunks = chunksForSection(options.sectionId);
  const tree = flatten(getTree(section.moduleId));
  const node = tree.find((row) => row.id === section.id);
  const sectionPath = node ? `${node.number} ${node.title}` : section.title;

  const module = db
    .select()
    .from(schema.modules)
    .where(eq(schema.modules.id, section.moduleId))
    .get();

  // Before anything is written. Lock and user_written have never been tested
  // against a real generator, and this is the first time they will be.
  const snapshot = takeSnapshot({
    moduleId: section.moduleId,
    sectionId: options.sectionId,
    label: `Before generating notes for ${sectionPath}`,
    reason: 'before_generation',
  });

  const run =
    options.run ?? startRun({ label: `Notes for ${sectionPath}`, moduleId: section.moduleId });

  const forPrompt: ConceptForPrompt[] = concepts.map((concept) => ({
    id: concept.id,
    statement: concept.statement,
    examinable: concept.examinableFlag,
  }));

  const elsewhere = ownedElsewhere(concepts, tree);

  const response = await complete({
    task: 'note_generation',
    system: NOTE_GENERATION_SYSTEM,
    prompt: noteGenerationPrompt({
      moduleTitle: module?.title ?? 'Unknown module',
      sectionPath,
      format: config.generation.noteFormat || DEFAULT_NOTE_FORMAT,
      concepts: forPrompt,
      chunks,
      elsewhere,
    }),
    jsonSchema: NOTE_GENERATION_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: config.generation.maxOutputTokens,
    moduleId: section.moduleId,
    run,
    ...(options.fresh ? { fresh: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  let blocks = validBlocks(response.json);

  // --- coverage, and the supplementary passes -------------------------------
  let coverage = await measureCoverage(blocks, concepts);
  let passes = 0;
  let hitPassLimit = false;
  /** A pass stopped helping, which is a different thing from running out. */
  let stoppedEarly = false;

  while (coverage.uncovered.length > 0 && coverage.measured) {
    if (passes >= config.llm.maxIterations) {
      hitPassLimit = true;
      break;
    }
    passes += 1;

    const missing = coverage.uncovered.map((entry) => ({
      id: entry.conceptId,
      statement: entry.statement,
      examinable: entry.examinable,
    }));

    const supplement = await complete({
      task: 'note_generation',
      system: NOTE_GENERATION_SYSTEM,
      prompt: coverageGapPrompt({
        sectionPath,
        format: config.generation.noteFormat || DEFAULT_NOTE_FORMAT,
        missing,
        chunks,
        existing: blocks.map((block) => block.markdown).join('\n\n'),
      }),
      jsonSchema: NOTE_GENERATION_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: config.generation.maxOutputTokens,
      moduleId: section.moduleId,
      run,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    // A supplement is told not to repeat the existing notes. Trusting it to
    // obey is not the same as checking: the first run of this loop duplicated
    // an entire section because the model returned its previous answer again,
    // and the notes doubled in length while covering nothing new.
    const seen = new Set(blocks.map((block) => normalise(block.markdown)));
    const added = validBlocks(supplement.json).filter(
      (block) => !seen.has(normalise(block.markdown)),
    );

    // A pass that added nothing new will not add anything next time either.
    if (added.length === 0) {
      stoppedEarly = true;
      break;
    }

    const next = await measureCoverage([...blocks, ...added], concepts);
    // Nor will one that wrote something without closing any gap.
    if (next.covered <= coverage.covered) {
      stoppedEarly = true;
      break;
    }

    blocks = [...blocks, ...added];
    coverage = next;
  }

  coverage.passes = passes;
  coverage.hitPassLimit = hitPassLimit;
  coverage.stoppedEarly = stoppedEarly;

  // --- write, preserving anything of yours ----------------------------------
  const written = await writeBlocks(options.sectionId, blocks);
  const figuresPlaced = await placeFigures(options.sectionId);

  db.update(schema.sections)
    .set({ status: coverage.uncovered.length === 0 ? 'complete' : 'drafted' })
    .where(eq(schema.sections.id, options.sectionId))
    .run();

  return {
    sectionId: options.sectionId,
    blocksWritten: written.written,
    blocksPreserved: written.preserved,
    figuresPlaced,
    coverage,
    snapshotId: snapshot.id,
    costUsd: run.costUsd,
  };
}

const ALLOWED_TYPES = new Set<schema.NoteBlockType>([
  'heading',
  'prose',
  'list',
  'table',
  'callout',
  'summary',
  'diagram',
]);

function validBlocks(json: unknown): GeneratedBlock[] {
  const parsed = (json ?? {}) as { blocks?: GeneratedBlock[] };
  if (!Array.isArray(parsed.blocks)) return [];
  return parsed.blocks
    .filter((block) => block?.markdown?.trim())
    .map((block) => ({
      type: ALLOWED_TYPES.has(block.type) ? block.type : ('prose' as schema.NoteBlockType),
      markdown: block.markdown.trim(),
      ...(block.conceptIds?.length ? { conceptIds: block.conceptIds } : {}),
    }));
}

/**
 * Is each concept actually explained by something that was written?
 *
 * Measured against the note text rather than against the model's own claim to
 * have covered it — a model asked to cite the concepts it explained will
 * cheerfully cite all of them.
 */
async function measureCoverage(
  blocks: GeneratedBlock[],
  concepts: Array<typeof schema.concepts.$inferSelect>,
): Promise<Coverage> {
  const blockVectors = await embedSafely(blocks.map((block) => block.markdown));
  const conceptVectors = await embedSafely(concepts.map((concept) => concept.statement));

  const usable = blockVectors.filter((vector): vector is Float32Array => vector !== null);
  if (usable.length === 0 || conceptVectors.every((vector) => vector === null)) {
    // Without embeddings there is no honest way to say anything about coverage,
    // and claiming full coverage would be the worst possible default.
    return {
      total: concepts.length,
      covered: 0,
      uncovered: [],
      passes: 0,
      hitPassLimit: false,
      stoppedEarly: false,
      measured: false,
    };
  }

  const entries: CoverageEntry[] = concepts.map((concept, index) => {
    const conceptVector = conceptVectors[index];
    let best = 0;
    if (conceptVector) {
      for (const blockVector of usable) {
        const score = cosine(conceptVector, blockVector);
        if (score > best) best = score;
      }
    }
    return {
      conceptId: concept.id,
      statement: concept.statement,
      examinable: concept.examinableFlag,
      score: best,
      covered: best >= COVERAGE_THRESHOLD,
    };
  });

  return {
    total: entries.length,
    covered: entries.filter((entry) => entry.covered).length,
    uncovered: entries.filter((entry) => !entry.covered),
    passes: 0,
    hitPassLimit: false,
    stoppedEarly: false,
    measured: true,
  };
}

/**
 * Replace the generated blocks; leave everything else exactly as it was.
 *
 * The rule is deliberately simple enough to state in one line, because a rule
 * about not destroying your work is worth being able to predict: your writing
 * and anything you locked stays where it is, and generated notes are replaced
 * in place — at the position the previous generated run occupied, or at the end
 * if there was none.
 */
async function writeBlocks(
  sectionId: string,
  blocks: GeneratedBlock[],
): Promise<{ written: number; preserved: number }> {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, sectionId))
    .orderBy(asc(schema.noteBlocks.position))
    .all();

  const isPreserved = (row: NoteBlockRow) => row.locked || row.origin !== 'ai_generated';
  const preserved = existing.filter(isPreserved);
  const replaceable = existing.filter((row) => !isPreserved(row));

  const firstGeneratedAt = existing.findIndex((row) => !isPreserved(row));
  const insertAt = firstGeneratedAt === -1 ? preserved.length : firstGeneratedAt;

  const vectors = await embedSafely(blocks.map((block) => block.markdown));
  const now = Math.floor(Date.now() / 1000);

  db.transaction((tx) => {
    for (const row of replaceable) {
      tx.delete(schema.noteBlocks).where(eq(schema.noteBlocks.id, row.id)).run();
    }

    // Reposition the survivors around the gap the new blocks will fill.
    preserved.forEach((row, index) => {
      const position = index < insertAt ? index : index + blocks.length;
      tx.update(schema.noteBlocks)
        .set({ position })
        .where(eq(schema.noteBlocks.id, row.id))
        .run();
    });

    blocks.forEach((block, index) => {
      const vector = vectors[index];
      tx.insert(schema.noteBlocks)
        .values({
          id: newId(),
          sectionId,
          position: insertAt + index,
          type: block.type,
          markdown: block.markdown,
          conceptIds: block.conceptIds ?? null,
          origin: 'ai_generated',
          locked: false,
          embedding: vector ? toBlob(vector) : null,
          generatedAt: now,
        })
        .run();
    });
  });

  for (const row of replaceable) removeVector('note_block', row.id);

  const fresh = db
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, sectionId))
    .orderBy(asc(schema.noteBlocks.position))
    .all();
  for (const row of fresh) {
    if (row.origin !== 'ai_generated' || !row.embedding) continue;
    const vector = vectors[fresh.indexOf(row)];
    if (vector) indexVector('note_block', row.id, vector);
  }

  return { written: blocks.length, preserved: preserved.length };
}

/**
 * §6.4: put each figure beside the thing it illustrates.
 *
 * Matched on the caption, because that is what says what the figure shows. A
 * figure with no caption and no match is left out of the notes rather than
 * dropped somewhere arbitrary — the spec is explicit that figures are there to
 * carry meaning, not decoration.
 */
async function placeFigures(sectionId: string): Promise<number> {
  const db = getDb();
  const chunkIds = chunksForSection(sectionId).map((chunk) => chunk.id);
  if (chunkIds.length === 0) return 0;

  const sourceIds = [
    ...new Set(
      db
        .select({ sourceId: schema.chunks.sourceId })
        .from(schema.chunks)
        .where(inArray(schema.chunks.id, chunkIds))
        .all()
        .map((row) => row.sourceId),
    ),
  ];
  if (sourceIds.length === 0) return 0;

  const figures = db
    .select()
    .from(schema.figures)
    .where(inArray(schema.figures.sourceId, sourceIds))
    .all()
    .filter((figure) => (figure.captionExtracted ?? figure.captionAi ?? '').trim().length > 0);
  if (figures.length === 0) return 0;

  const blocks = db
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, sectionId))
    .orderBy(asc(schema.noteBlocks.position))
    .all()
    .filter((row) => row.origin === 'ai_generated' && row.type !== 'figure');
  if (blocks.length === 0) return 0;

  const captions = figures.map((figure) => figure.captionExtracted ?? figure.captionAi ?? '');
  const captionVectors = await embedSafely(captions);
  const blockVectors = await embedSafely(blocks.map((row) => row.markdown));

  const placements: Array<{ afterBlockId: string; figure: (typeof figures)[number] }> = [];
  const used = new Set<string>();

  figures.forEach((figure, index) => {
    const captionVector = captionVectors[index];
    if (!captionVector) return;

    let bestId: string | null = null;
    let bestScore = -1;
    blocks.forEach((block, blockIndex) => {
      const blockVector = blockVectors[blockIndex];
      if (!blockVector || used.has(block.id)) return;
      const score = cosine(captionVector, blockVector);
      if (score > bestScore) {
        bestScore = score;
        bestId = block.id;
      }
    });

    if (bestId === null || bestScore < FIGURE_MATCH_THRESHOLD) return;
    used.add(bestId);
    placements.push({ afterBlockId: bestId, figure });
  });

  if (placements.length === 0) return 0;

  const all = db
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, sectionId))
    .orderBy(asc(schema.noteBlocks.position))
    .all();

  const ordered: Array<{ id?: string; insert?: (typeof placements)[number] }> = [];
  for (const row of all) {
    ordered.push({ id: row.id });
    const placement = placements.find((entry) => entry.afterBlockId === row.id);
    if (placement) ordered.push({ insert: placement });
  }

  db.transaction((tx) => {
    ordered.forEach((entry, position) => {
      if (entry.id) {
        tx.update(schema.noteBlocks)
          .set({ position })
          .where(eq(schema.noteBlocks.id, entry.id))
          .run();
        return;
      }
      const { figure } = entry.insert!;
      const caption = figure.captionExtracted ?? figure.captionAi ?? '';
      tx.insert(schema.noteBlocks)
        .values({
          id: newId(),
          sectionId,
          position,
          type: 'figure',
          markdown: `![${figure.altText ?? ''}](${toFigureUrl(figure.path)} "${caption.replace(/"/g, '\\"')}")`,
          figureId: figure.id,
          origin: 'ai_generated',
          generatedAt: Math.floor(Date.now() / 1000),
        })
        .run();
    });
  });

  return placements.length;
}

function toFigureUrl(storedPath: string): string {
  const normalised = storedPath.split(/[\\/]/).join('/');
  return `/${normalised.replace(/^media\//, 'media/')}`;
}

/** Concepts this section repeats that another section owns, for §6.5. */
function ownedElsewhere(
  concepts: Array<typeof schema.concepts.$inferSelect>,
  tree: Array<{ id: string; number: string; title: string }>,
): Array<{ statement: string; sectionPath: string }> {
  const db = getDb();
  if (concepts.length === 0) return [];

  const links = db
    .select()
    .from(schema.conceptLinks)
    .where(
      inArray(
        schema.conceptLinks.fromConceptId,
        concepts.map((concept) => concept.id),
      ),
    )
    .all();
  if (links.length === 0) return [];

  const owners = db
    .select()
    .from(schema.concepts)
    .where(
      inArray(
        schema.concepts.id,
        links.map((link) => link.toConceptId),
      ),
    )
    .all();

  return links.flatMap((link) => {
    const owner = owners.find((row) => row.id === link.toConceptId);
    const node = owner ? tree.find((row) => row.id === owner.sectionId) : undefined;
    if (!owner || !node) return [];
    return [{ statement: owner.statement, sectionPath: `${node.number} ${node.title}` }];
  });
}

/** Whitespace and case are not differences worth paying to re-generate. */
function normalise(markdown: string): string {
  return markdown.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dot / magnitude;
}
