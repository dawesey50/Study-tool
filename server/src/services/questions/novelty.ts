import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { getDb, schema } from '../../db/index.js';
import { fromBlob } from '../../lib/vector.js';

/**
 * The novelty gate — §7.3.
 *
 * The single assumption the whole question engine rests on: that filtering by
 * similarity produces questions that feel genuinely different to a person, not
 * twenty versions of one question wearing hats. Plan v2 makes testing that a
 * one-day spike before the six days of engine, which is why this file is
 * separable and runs without a model.
 *
 * Four checks, each catching something the others miss:
 *   - cosine on the stem embedding catches paraphrase;
 *   - trigram overlap catches verbatim reuse;
 *   - the blueprint signature catches the same concepts asked the same way
 *     with the same scenario, even when the words differ;
 *   - past papers, because a generated question that reproduces a real one is
 *     worse than useless — it teaches the paper rather than the concept.
 *
 * WHAT `npm run spike` MEASURED, AND WHY IT CHANGED THIS FILE
 *
 * The word-trigram check was written expecting it to catch "the same sentence
 * lightly reworded". It does not. On the spike's hand-written pairs it scored
 * a one-word edit at 0.69 — caught easily — but a genuine paraphrase of the
 * same question at 0.00, and a clause-reordered duplicate at 0.13. Both are
 * far below any threshold that would not also reject unrelated questions.
 *
 * So trigrams catch copy-paste and nothing subtler, and the entire burden of
 * catching paraphrase falls on the embedding. That makes a missing embedding
 * not a degraded gate but very nearly no gate at all, which is why every
 * verdict now reports whether one was available: a silent fallback to
 * trigram-only would let near-duplicates through while still looking like the
 * gate was running.
 */

export const COSINE_LIMIT = config.questions.cosineLimit;
export const TRIGRAM_LIMIT = config.questions.trigramLimit;

export type RejectionReason =
  | 'too_similar_by_meaning'
  | 'too_similar_by_wording'
  | 'blueprint_already_used'
  | 'reproduces_a_past_paper'
  | 'empty';

export interface NoveltyVerdict {
  accepted: boolean;
  reason?: RejectionReason;
  /** The closest thing already in the bank, so a rejection can be explained. */
  nearest?: { stem: string; score: number; source: string };
  cosine: number;
  trigram: number;
  /**
   * False when this stem, or everything it was compared against, had no
   * embedding. The verdict is then trigram-only, which the spike showed
   * catches copy-paste and little else — so an `accepted` with this false is
   * much weaker than an `accepted` with it true, and the caller must say so
   * rather than presenting the two as the same result.
   */
  embeddingsUsed: boolean;
}

export interface ExistingStem {
  id: string;
  stem: string;
  embedding: Float32Array | null;
  source: 'generated' | 'past_paper';
}

export function existingStems(moduleId: string): ExistingStem[] {
  return getDb()
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all()
    .map((row) => ({
      id: row.id,
      stem: row.stem,
      embedding: fromBlob(row.embedding as Buffer | null),
      source: row.source,
    }));
}

/**
 * Word trigrams rather than character trigrams: character n-grams score two
 * questions about the same enzyme as similar because they share the enzyme's
 * name, which is not the kind of sameness worth rejecting.
 */
export function trigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return grams;
}

/** Overlap as a share of the smaller set, so a long stem cannot hide a copy. */
export function trigramOverlap(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

export function cosine(a: Float32Array, b: Float32Array): number {
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

export interface CheckOptions {
  stem: string;
  embedding: Float32Array | null;
  signature: string;
  existing: ExistingStem[];
  usedSignatures: Set<string>;
}

export function checkNovelty(options: CheckOptions): NoveltyVerdict {
  if (!options.stem.trim()) {
    return { accepted: false, reason: 'empty', cosine: 0, trigram: 0, embeddingsUsed: false };
  }

  if (options.usedSignatures.has(options.signature)) {
    return {
      accepted: false,
      reason: 'blueprint_already_used',
      cosine: 0,
      trigram: 0,
      // The signature check needs no vectors, so it is as strong either way.
      embeddingsUsed: true,
    };
  }

  let worstCosine = 0;
  let worstTrigram = 0;
  let nearest: NoveltyVerdict['nearest'];
  let reason: RejectionReason | undefined;
  // An empty bank is compared against nothing, so nothing was missed: the
  // first question of a run is novel by definition.
  let comparisons = 0;
  let comparisonsWithVectors = 0;

  for (const other of options.existing) {
    comparisons += 1;
    if (options.embedding && other.embedding) comparisonsWithVectors += 1;
    const similarity =
      options.embedding && other.embedding ? cosine(options.embedding, other.embedding) : 0;
    const overlap = trigramOverlap(options.stem, other.stem);

    if (similarity > worstCosine) {
      worstCosine = similarity;
      if (similarity >= COSINE_LIMIT) {
        reason ??= 'too_similar_by_meaning';
        nearest = { stem: other.stem, score: similarity, source: other.source };
      }
    }
    if (overlap > worstTrigram) {
      worstTrigram = overlap;
      if (overlap >= TRIGRAM_LIMIT && !reason) {
        reason = 'too_similar_by_wording';
        nearest = { stem: other.stem, score: overlap, source: other.source };
      }
    }

    // A generated question that reproduces a real exam question is the worst
    // outcome of all: it teaches the paper instead of the concept, and it
    // looks like success.
    const isPastPaper = other.source === 'past_paper';
    if (isPastPaper && (similarity >= config.questions.pastPaperLimit || overlap >= 0.3)) {
      return {
        accepted: false,
        reason: 'reproduces_a_past_paper',
        nearest: { stem: other.stem, score: Math.max(similarity, overlap), source: other.source },
        cosine: Math.max(worstCosine, similarity),
        trigram: Math.max(worstTrigram, overlap),
        embeddingsUsed: comparisonsWithVectors === comparisons,
      };
    }
  }

  const embeddingsUsed = comparisons === 0 || comparisonsWithVectors === comparisons;

  return reason
    ? {
        accepted: false,
        reason,
        ...(nearest ? { nearest } : {}),
        cosine: worstCosine,
        trigram: worstTrigram,
        embeddingsUsed,
      }
    : { accepted: true, cosine: worstCosine, trigram: worstTrigram, embeddingsUsed };
}

/**
 * The stems §7.2 puts in front of the generator: the ten nearest already in
 * the bank, so it is told what not to write again rather than only judged
 * afterwards.
 */
export function nearestStems(
  embedding: Float32Array | null,
  existing: ExistingStem[],
  limit = 10,
): string[] {
  if (existing.length === 0) return [];
  if (!embedding) return existing.slice(-limit).map((row) => row.stem);

  return existing
    .map((row) => ({
      stem: row.stem,
      score: row.embedding ? cosine(embedding, row.embedding) : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.stem);
}
