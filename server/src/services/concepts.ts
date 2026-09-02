import { and, asc, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { indexVector, removeVector, searchVectors } from '../db/vectorIndex.js';
import { embedSafely } from '../embeddings/index.js';
import { newId } from '../lib/ids.js';
import { fromBlob, toBlob } from '../lib/vector.js';
import { complete, startRun, type LlmRun } from '../llm/index.js';
import {
  CONCEPT_EXTRACTION_SCHEMA,
  CONCEPT_EXTRACTION_SYSTEM,
  conceptExtractionPrompt,
} from '../llm/prompts.js';
import { describeLocation } from './search.js';
import { getTree, flatten } from './sections.js';

/**
 * Concepts: the atomic unit everything downstream references.
 *
 * Notes are generated against a concept list, coverage is measured against it,
 * questions are sampled from it, and scheduling tracks mastery of it. So the
 * quality of everything later is bounded by the quality of this, which is why
 * the concept list is something you read and correct rather than a hidden
 * intermediate.
 *
 * Two guarantees hold whatever the model does:
 *   - Every concept cites chunks that actually exist in the section. One that
 *     cites nothing was invented, and is dropped rather than stored.
 *   - Near-identical concepts are merged. Over-splitting is what makes the
 *     coverage badge lie: five restatements of one idea all get "covered" by
 *     the sentence that says it once, and the badge reads 47/47 either way.
 */

export type ConceptRow = typeof schema.concepts.$inferSelect;

/**
 * Above this cosine, two concepts in the same section are the same concept.
 *
 * Deliberately high. Merging two genuinely different concepts loses one
 * permanently; leaving two restatements in costs a duplicate you can see and
 * delete in the list view. Untuned against real embeddings — this is one of
 * the numbers to revisit after the first real extraction.
 */
export const DUPLICATE_THRESHOLD = 0.94;

/** Above this, a concept in another section is the same one, and one owns it. */
export const OWNERSHIP_THRESHOLD = 0.9;

/**
 * Roughly how much material one concept is expected to come from. Only ever
 * used to flag a count that looks wrong, never to change the count.
 *
 * This is a guess, and a weak one: a slide deck is terse and dense in claims,
 * a transcript is verbose and sparse in them, so no single ratio fits both.
 * The band is therefore wide enough to catch only the extremes — a section
 * with plenty of material and almost nothing extracted, or a count that could
 * only come from splitting one idea into ten. A check that fired on ordinary
 * variation would be worse than none, because you would learn to ignore it.
 *
 * All three are settable, because tuning them against your own material is
 * exactly the kind of thing that should not need a code change.
 */
const CHARS_PER_CONCEPT = config.concepts.charsPerConcept;
const PLAUSIBLE_RANGE = { low: config.concepts.plausibleLow, high: config.concepts.plausibleHigh };
/** Below this much material the ratio means nothing, so nothing is said. */
const MIN_CHARS_TO_JUDGE = config.concepts.minCharsToJudge;

export function listConcepts(sectionId: string): ConceptRow[] {
  return getDb()
    .select()
    .from(schema.concepts)
    .where(eq(schema.concepts.sectionId, sectionId))
    .orderBy(asc(schema.concepts.createdAt))
    .all();
}

/** Chunks mapped to this section, in reading order, with a citable location. */
export function chunksForSection(sectionId: string): Array<{
  id: string;
  text: string;
  location: string;
}> {
  const db = getDb();
  const mappings = db
    .select()
    .from(schema.sourceSections)
    .where(eq(schema.sourceSections.sectionId, sectionId))
    .all();

  const chunkIds = mappings.flatMap((row) => row.chunkRange?.chunkIds ?? []);
  if (chunkIds.length === 0) return [];

  const rows = db
    .select({
      id: schema.chunks.id,
      text: schema.chunks.text,
      pageNo: schema.chunks.pageNo,
      slideNo: schema.chunks.slideNo,
      timestamp: schema.chunks.timestamp,
      position: schema.chunks.position,
      sourceTitle: schema.sources.title,
      sourceType: schema.sources.type,
    })
    .from(schema.chunks)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.chunks.sourceId))
    .where(inArray(schema.chunks.id, chunkIds))
    .all();

  return rows
    .sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle) || a.position - b.position)
    .map((row) => ({ id: row.id, text: row.text, location: describeLocation(row) }));
}

export interface ExtractionResult {
  sectionId: string;
  extracted: number;
  merged: number;
  uncited: number;
  kept: number;
  /** Null when there is nothing to compare against. */
  plausibility: PlausibilityWarning | null;
}

export interface PlausibilityWarning {
  concepts: number;
  sourceChars: number;
  expected: number;
  verdict: 'too_few' | 'too_many';
  message: string;
}

/**
 * What the count says about itself.
 *
 * The coverage badge in §6.2 proves notes cover concepts. It cannot prove
 * concepts cover the lecture — under-extract by a third and it still reads
 * 47/47. This does not fix that, but it is the cheap signal that something is
 * wrong, and it is shown next to the list rather than buried.
 */
export function assessPlausibility(
  conceptCount: number,
  sourceChars: number,
): PlausibilityWarning | null {
  if (sourceChars < MIN_CHARS_TO_JUDGE) return null;
  const expected = Math.max(1, Math.round(sourceChars / CHARS_PER_CONCEPT));
  const ratio = conceptCount / expected;
  if (ratio >= PLAUSIBLE_RANGE.low && ratio <= PLAUSIBLE_RANGE.high) return null;

  const tooFew = ratio < PLAUSIBLE_RANGE.low;
  return {
    concepts: conceptCount,
    sourceChars,
    expected,
    verdict: tooFew ? 'too_few' : 'too_many',
    message: tooFew
      ? `Only ${conceptCount} concepts from ${Math.round(sourceChars / 1000)}k characters of ` +
        `material. That is thin enough to be worth checking — nearer ${expected} would be usual ` +
        'for this much text. Read the list against the source before trusting a coverage badge ' +
        'built on it.'
      : `${conceptCount} concepts from ${Math.round(sourceChars / 1000)}k characters of material ` +
        `looks like one idea split several ways — nearer ${expected} would be usual. ` +
        'Near-identical concepts make a coverage badge read higher than the notes deserve.',
  };
}

interface ExtractedConcept {
  statement: string;
  type: schema.ConceptType;
  sourceChunkIds: string[];
  bloomCeiling?: string;
  difficulty?: number;
  examinable?: boolean;
  emphasis?: number;
}

export interface ExtractOptions {
  sectionId: string;
  run?: LlmRun;
  signal?: AbortSignal;
  /** Pay for a new answer even if this exact material was extracted before. */
  fresh?: boolean;
}

export async function extractConcepts(options: ExtractOptions): Promise<ExtractionResult> {
  const db = getDb();
  const section = db
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.id, options.sectionId))
    .get();
  if (!section) throw new Error('Section not found');

  const chunks = chunksForSection(options.sectionId);
  if (chunks.length === 0) {
    throw new Error(
      'No sources are mapped to this section yet. Upload the material and confirm its ' +
        'mapping first — there is nothing here to extract from.',
    );
  }

  const module = db
    .select()
    .from(schema.modules)
    .where(eq(schema.modules.id, section.moduleId))
    .get();
  const tree = flatten(getTree(section.moduleId));
  const node = tree.find((row) => row.id === section.id);
  const sectionPath = node ? `${node.number} ${node.title}` : section.title;

  const run =
    options.run ??
    startRun({ label: `Concepts for ${sectionPath}`, moduleId: section.moduleId });

  const response = await complete({
    task: 'concept_extraction',
    system: CONCEPT_EXTRACTION_SYSTEM,
    prompt: conceptExtractionPrompt({
      moduleTitle: module?.title ?? 'Unknown module',
      sectionPath,
      learningOutcomes: section.learningOutcomes,
      chunks,
    }),
    jsonSchema: CONCEPT_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
    moduleId: section.moduleId,
    run,
    ...(options.fresh ? { fresh: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const parsed = (response.json ?? {}) as { concepts?: ExtractedConcept[] };
  const raw = Array.isArray(parsed.concepts) ? parsed.concepts : [];

  // A citation to a chunk that is not in this section is a hallucinated one,
  // and a concept with no valid citation cannot be traced back to anything.
  const validChunkIds = new Set(chunks.map((chunk) => chunk.id));
  const cited: ExtractedConcept[] = [];
  let uncited = 0;
  for (const concept of raw) {
    if (!concept?.statement?.trim()) continue;
    const ids = (concept.sourceChunkIds ?? []).filter((id) => validChunkIds.has(id));
    if (ids.length === 0) {
      uncited += 1;
      continue;
    }
    cited.push({ ...concept, sourceChunkIds: ids });
  }

  // Replacing rather than appending: extracting twice should not double the
  // list. Anything you edited by hand is preserved by the merge below.
  const existing = listConcepts(options.sectionId);
  const written = await writeConcepts(options.sectionId, cited, existing);

  const sourceChars = chunks.reduce((total, chunk) => total + chunk.text.length, 0);
  return {
    sectionId: options.sectionId,
    extracted: raw.length,
    uncited,
    merged: cited.length - written.length,
    kept: written.length,
    plausibility: assessPlausibility(written.length, sourceChars),
  };
}

/**
 * Store the extraction, merging near-identical statements as it goes.
 *
 * Deduping here rather than in a second pass means the list you read has
 * already been through it, and the count the plausibility check sees is the
 * real one.
 */
async function writeConcepts(
  sectionId: string,
  incoming: ExtractedConcept[],
  existing: ConceptRow[],
): Promise<ConceptRow[]> {
  const db = getDb();
  const vectors = await embedSafely(incoming.map((concept) => concept.statement));

  const kept: Array<{ concept: ExtractedConcept; vector: Float32Array | null }> = [];
  for (const [index, concept] of incoming.entries()) {
    const vector = vectors[index] ?? null;
    const duplicate = kept.find((other) => isSameConcept(other, { concept, vector }));
    if (duplicate) {
      // Merged concepts keep both citations: the idea really was in both places.
      duplicate.concept.sourceChunkIds = [
        ...new Set([...duplicate.concept.sourceChunkIds, ...concept.sourceChunkIds]),
      ];
      duplicate.concept.emphasis = Math.max(
        duplicate.concept.emphasis ?? 0,
        concept.emphasis ?? 0,
      );
      duplicate.concept.examinable = duplicate.concept.examinable || concept.examinable;
      continue;
    }
    kept.push({ concept, vector });
  }

  // Ids are reused where a statement is unchanged, so anything pointing at a
  // concept — a note block, a question, a review record — survives a re-run.
  const byStatement = new Map(existing.map((row) => [normalise(row.statement), row]));

  db.transaction((tx) => {
    for (const row of existing) {
      tx.delete(schema.concepts).where(eq(schema.concepts.id, row.id)).run();
    }
  });
  for (const row of existing) {
    if (!byStatement.has(normalise(row.statement))) removeVector('concept', row.id);
  }

  const written: ConceptRow[] = [];
  for (const { concept, vector } of kept) {
    const previous = byStatement.get(normalise(concept.statement));
    const id = previous?.id ?? newId();

    const values: typeof schema.concepts.$inferInsert = {
      id,
      sectionId,
      statement: concept.statement.trim(),
      type: concept.type,
      bloomCeiling: concept.bloomCeiling ?? null,
      difficulty: concept.difficulty ?? null,
      examinableFlag: concept.examinable ?? false,
      emphasisScore: concept.emphasis ?? null,
      sourceChunkIds: concept.sourceChunkIds,
      embedding: vector ? toBlob(vector) : null,
      ...(previous ? { createdAt: previous.createdAt } : {}),
    };

    db.insert(schema.concepts).values(values).run();
    if (vector) indexVector('concept', id, vector);
    written.push(
      db.select().from(schema.concepts).where(eq(schema.concepts.id, id)).get() as ConceptRow,
    );
  }

  return written;
}

function normalise(statement: string): string {
  return statement.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.;:]$/, '');
}

function isSameConcept(
  a: { concept: ExtractedConcept; vector: Float32Array | null },
  b: { concept: ExtractedConcept; vector: Float32Array | null },
): boolean {
  if (normalise(a.concept.statement) === normalise(b.concept.statement)) return true;
  // With no embeddings available, exact text is all there is to go on. Merging
  // on a guess would be worse than leaving a duplicate you can see.
  if (!a.vector || !b.vector) return false;
  return cosine(a.vector, b.vector) >= DUPLICATE_THRESHOLD;
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

// ---------------------------------------------------------------------------
// Ownership across the module
// ---------------------------------------------------------------------------

export interface OwnershipResult {
  moduleId: string;
  compared: number;
  links: number;
  duplicates: number;
}

/**
 * Decide which section owns each concept, and record what the others are.
 *
 * §6.5's answer to notes repeating themselves: the same idea taught in three
 * lectures should be written once and pointed at twice. Ownership goes to the
 * section that teaches it in most depth, approximated by which one has the
 * most material citing it — with ties broken by tree position, so the earliest
 * section wins and later ones refer back rather than forward.
 */
export async function assignOwnership(moduleId: string): Promise<OwnershipResult> {
  const db = getDb();
  const sections = flatten(getTree(moduleId));
  const order = new Map(sections.map((node, index) => [node.id, index]));
  if (sections.length === 0) return { moduleId, compared: 0, links: 0, duplicates: 0 };

  const rows = db
    .select()
    .from(schema.concepts)
    .where(
      inArray(
        schema.concepts.sectionId,
        sections.map((node) => node.id),
      ),
    )
    .all();

  const ids = new Set(rows.map((row) => row.id));
  db.delete(schema.conceptLinks)
    .where(inArray(schema.conceptLinks.fromConceptId, [...ids]))
    .run();

  let links = 0;
  let duplicates = 0;
  const seen = new Set<string>();

  for (const row of rows) {
    const vector = fromBlob(row.embedding as Buffer | null);
    if (!vector) continue;
    const matches = searchVectors('concept', vector, {
      limit: 8,
      entityIds: [...ids],
      minScore: OWNERSHIP_THRESHOLD,
    });

    for (const match of matches) {
      if (match.entityId === row.id) continue;
      const other = rows.find((candidate) => candidate.id === match.entityId);
      if (!other || other.sectionId === row.sectionId) continue;

      // One link per pair, written from the section that does not own it.
      const pair = [row.id, other.id].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);

      const owner = decideOwner(row, other, order);
      const borrower = owner.id === row.id ? other : row;
      db.insert(schema.conceptLinks)
        .values({
          fromConceptId: borrower.id,
          toConceptId: owner.id,
          type: 'duplicate',
          note: `${Math.round(match.score * 100)}% match`,
        })
        .onConflictDoNothing()
        .run();
      links += 1;
      duplicates += 1;
    }
  }

  return { moduleId, compared: rows.length, links, duplicates };
}

function decideOwner(
  a: ConceptRow,
  b: ConceptRow,
  order: Map<string, number>,
): ConceptRow {
  const depth = (row: ConceptRow) => (row.sourceChunkIds?.length ?? 0);
  if (depth(a) !== depth(b)) return depth(a) > depth(b) ? a : b;
  const positionA = order.get(a.sectionId) ?? Number.MAX_SAFE_INTEGER;
  const positionB = order.get(b.sectionId) ?? Number.MAX_SAFE_INTEGER;
  return positionA <= positionB ? a : b;
}

/** Links pointing at or away from a concept, for the list view and backlinks. */
export function conceptLinks(conceptId: string) {
  const db = getDb();
  const outgoing = db
    .select()
    .from(schema.conceptLinks)
    .where(eq(schema.conceptLinks.fromConceptId, conceptId))
    .all();
  const incoming = db
    .select()
    .from(schema.conceptLinks)
    .where(eq(schema.conceptLinks.toConceptId, conceptId))
    .all();
  return { outgoing, incoming };
}

/**
 * Move ownership by hand. Extraction proposes; you decide — the same shape as
 * section mapping, where a proposal is never mistaken for a confirmation.
 */
export function setOwner(borrowerId: string, ownerId: string): void {
  const db = getDb();
  db.delete(schema.conceptLinks)
    .where(
      and(
        eq(schema.conceptLinks.fromConceptId, ownerId),
        eq(schema.conceptLinks.toConceptId, borrowerId),
      ),
    )
    .run();
  db.insert(schema.conceptLinks)
    .values({ fromConceptId: borrowerId, toConceptId: ownerId, type: 'duplicate', note: 'by hand' })
    .onConflictDoNothing()
    .run();
}
