import { eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { fromBlob } from '../lib/vector.js';
import { describeLocation } from './search.js';
import { flatten, getTree } from './sections.js';

/**
 * What the past papers say is examinable.
 *
 * The cheapest useful thing a past paper can do, and it needs no model at all:
 * every question in it is, by definition, something that was examined. Matching
 * those questions against the concept list marks the concepts that have
 * actually come up, which then weights note generation and question sampling
 * towards the things that matter.
 *
 * Every flag carries its evidence — which paper, which page, and the words that
 * matched — because this flag propagates into everything downstream, and a
 * wrong one that cannot be checked is worse than no flag at all. Nothing here
 * ever clears a flag you set by hand: this proposes, it does not overrule.
 */

/** Above this cosine, a past-paper question is about a concept. */
const MATCH_THRESHOLD = config.pastPapers.matchThreshold;
/** Keep at most this many pieces of evidence per concept, best first. */
const MAX_EVIDENCE = 4;

export interface ExaminableResult {
  moduleId: string;
  papers: number;
  questions: number;
  conceptsConsidered: number;
  flagged: number;
  alreadyFlagged: number;
  /** True when nothing could be compared, so nothing was concluded. */
  unmeasured: boolean;
}

export interface ExaminableOptions {
  moduleId: string;
  /** Limit to specific past papers. Omitted means every one in the module. */
  sourceIds?: string[];
}

export function markExaminableFromPastPapers(options: ExaminableOptions): ExaminableResult {
  const db = getDb();

  const papers = db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.moduleId, options.moduleId))
    .all()
    .filter(
      (source) =>
        source.type === 'past_paper' &&
        (!options.sourceIds?.length || options.sourceIds.includes(source.id)),
    );

  const sections = flatten(getTree(options.moduleId));
  const concepts = sections.length
    ? db
        .select()
        .from(schema.concepts)
        .where(
          inArray(
            schema.concepts.sectionId,
            sections.map((node) => node.id),
          ),
        )
        .all()
    : [];

  const base: ExaminableResult = {
    moduleId: options.moduleId,
    papers: papers.length,
    questions: 0,
    conceptsConsidered: concepts.length,
    flagged: 0,
    alreadyFlagged: concepts.filter((concept) => concept.examinableFlag).length,
    unmeasured: false,
  };

  if (papers.length === 0 || concepts.length === 0) return base;

  const chunks = db
    .select({
      id: schema.chunks.id,
      text: schema.chunks.text,
      embedding: schema.chunks.embedding,
      pageNo: schema.chunks.pageNo,
      slideNo: schema.chunks.slideNo,
      timestamp: schema.chunks.timestamp,
      sourceTitle: schema.sources.title,
      sourceType: schema.sources.type,
    })
    .from(schema.chunks)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.chunks.sourceId))
    .where(
      inArray(
        schema.chunks.sourceId,
        papers.map((paper) => paper.id),
      ),
    )
    .all();

  base.questions = chunks.length;

  const paperVectors = chunks
    .map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      location: describeLocation(chunk),
      vector: fromBlob(chunk.embedding as Buffer | null),
    }))
    .filter(
      (entry): entry is { id: string; text: string; location: string; vector: Float32Array } =>
        entry.vector !== null,
    );

  // Without vectors on both sides there is nothing to compare, and guessing
  // would put an unearned flag on work that then inherits it.
  if (paperVectors.length === 0 || concepts.every((concept) => !concept.embedding)) {
    return { ...base, unmeasured: true };
  }

  let flagged = 0;
  for (const concept of concepts) {
    const conceptVector = fromBlob(concept.embedding as Buffer | null);
    if (!conceptVector) continue;

    const hits = paperVectors
      .map((entry) => ({ entry, score: cosine(conceptVector, entry.vector) }))
      .filter((hit) => hit.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_EVIDENCE);

    if (hits.length === 0) continue;

    const evidence = hits.map((hit) => ({
      chunkId: hit.entry.id,
      location: hit.entry.location,
      score: Math.round(hit.score * 100) / 100,
      excerpt: excerpt(hit.entry.text),
    }));

    if (!concept.examinableFlag) flagged += 1;
    db.update(schema.concepts)
      .set({ examinableFlag: true, examinableEvidence: evidence })
      .where(eq(schema.concepts.id, concept.id))
      .run();
  }

  return { ...base, flagged };
}

/** Enough of the question to recognise it, without pasting the whole paper. */
function excerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= 220 ? clean : `${clean.slice(0, 217)}…`;
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
