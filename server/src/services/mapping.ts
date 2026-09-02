import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { embedSafely } from '../embeddings/index.js';
import { cosine, fromBlob } from '../lib/vector.js';
import { flatten, getTree, type SectionNode } from './sections.js';

/**
 * Which sections does this source belong to?
 *
 * A lecture normally spills across several sections, so this is a many-to-many
 * question, not a filing decision. Each chunk is matched against a text profile
 * of every section — its title, its ancestors' titles and its learning outcomes
 * — and a section claims the source when enough of its chunks land there.
 *
 * The output is always a proposal. Nothing is marked confirmed until you say so,
 * because an embedding match on a section title is a decent guess and no more.
 */

export interface SectionProposal {
  sectionId: string;
  sectionNumber: string;
  sectionTitle: string;
  score: number;
  chunkIds: string[];
  confirmed: boolean;
}

/** A chunk must beat this to count as belonging to a section at all. */
const CHUNK_MATCH_THRESHOLD = 0.25;
/** And a section needs either this share of the source's chunks, or the best average. */
const SECTION_SHARE_THRESHOLD = 0.06;

export async function proposeSectionsForSource(sourceId: string): Promise<SectionProposal[]> {
  const db = getDb();
  const source = db.select().from(schema.sources).where(eq(schema.sources.id, sourceId)).get();
  if (!source) throw new Error(`Source not found: ${sourceId}`);

  const sections = flatten(getTree(source.moduleId));
  if (sections.length === 0) return [];

  const chunks = db
    .select({ id: schema.chunks.id, embedding: schema.chunks.embedding })
    .from(schema.chunks)
    .where(eq(schema.chunks.sourceId, sourceId))
    .all();

  const chunkVectors = chunks
    .map((chunk) => ({ id: chunk.id, vector: fromBlob(chunk.embedding as Buffer | null) }))
    .filter((c): c is { id: string; vector: Float32Array } => c.vector !== null);

  // Without embeddings there is nothing to match on. Leave existing mappings
  // alone rather than clearing them on the basis of no evidence.
  if (chunkVectors.length === 0) return existingProposals(sourceId, sections);

  const sectionVectors = await embedSafely(sections.map((section) => profileOf(section, sections)));

  const scores = new Map<string, { total: number; chunkIds: string[] }>();
  for (const chunk of chunkVectors) {
    let best: { sectionId: string; score: number } | null = null;
    for (const [i, sectionVector] of sectionVectors.entries()) {
      if (!sectionVector) continue;
      const score = cosine(chunk.vector, sectionVector);
      if (!best || score > best.score) best = { sectionId: sections[i]!.id, score };
    }
    if (!best || best.score < CHUNK_MATCH_THRESHOLD) continue;

    const entry = scores.get(best.sectionId) ?? { total: 0, chunkIds: [] };
    entry.total += best.score;
    entry.chunkIds.push(chunk.id);
    scores.set(best.sectionId, entry);
  }

  if (scores.size === 0) return existingProposals(sourceId, sections);

  const minChunks = Math.max(1, Math.floor(chunkVectors.length * SECTION_SHARE_THRESHOLD));
  const byId = new Map(sections.map((section) => [section.id, section]));

  const proposals: SectionProposal[] = [...scores.entries()]
    .filter(([, entry]) => entry.chunkIds.length >= minChunks)
    .map(([sectionId, entry]) => ({
      sectionId,
      sectionNumber: byId.get(sectionId)?.number ?? '',
      sectionTitle: byId.get(sectionId)?.title ?? '',
      score: entry.total / entry.chunkIds.length,
      chunkIds: entry.chunkIds,
      confirmed: false,
    }))
    .sort((a, b) => b.chunkIds.length - a.chunkIds.length);

  // A source that matched nothing strongly still belongs somewhere; keep the
  // single best section so it is never stranded with no home at all.
  if (proposals.length === 0) {
    const [bestId, best] = [...scores.entries()].sort(
      (a, b) => b[1].chunkIds.length - a[1].chunkIds.length,
    )[0]!;
    proposals.push({
      sectionId: bestId,
      sectionNumber: byId.get(bestId)?.number ?? '',
      sectionTitle: byId.get(bestId)?.title ?? '',
      score: best.total / best.chunkIds.length,
      chunkIds: best.chunkIds,
      confirmed: false,
    });
  }

  return persist(sourceId, proposals);
}

/**
 * Write proposals, preserving anything already confirmed. A confirmed mapping
 * is a decision you made; re-running the matcher must not quietly undo it.
 */
function persist(sourceId: string, proposals: SectionProposal[]): SectionProposal[] {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.sourceSections)
    .where(eq(schema.sourceSections.sourceId, sourceId))
    .all();
  const confirmed = new Set(existing.filter((row) => row.confirmed).map((row) => row.sectionId));

  db.transaction((tx) => {
    // Clear stale proposals, but never a mapping you confirmed.
    for (const row of existing) {
      if (row.confirmed) continue;
      tx.delete(schema.sourceSections)
        .where(
          and(
            eq(schema.sourceSections.sourceId, sourceId),
            eq(schema.sourceSections.sectionId, row.sectionId),
          ),
        )
        .run();
    }

    for (const proposal of proposals) {
      if (confirmed.has(proposal.sectionId)) continue;
      tx.insert(schema.sourceSections)
        .values({
          sourceId,
          sectionId: proposal.sectionId,
          chunkRange: { chunkIds: proposal.chunkIds },
          score: proposal.score,
          confirmed: false,
        })
        .onConflictDoUpdate({
          target: [schema.sourceSections.sourceId, schema.sourceSections.sectionId],
          set: { chunkRange: { chunkIds: proposal.chunkIds }, score: proposal.score },
        })
        .run();
    }
  });

  return listMappings(sourceId);
}

/**
 * Which of a source's chunks belong to a section you picked by hand.
 *
 * Confirming a section the matcher never proposed used to attach no chunks at
 * all: the mapping showed as "confirmed by you" and the section was silently
 * empty, so extraction found nothing and notes would have been generated from
 * nothing. Nothing in the interface said so.
 *
 * Rather than attaching the whole source — which would give every section the
 * whole lecture — this scores its chunks against that one section and keeps
 * the ones that actually match, falling back to all of them when there is
 * nothing to score with. A section you chose deliberately gets a lower bar
 * than one the matcher had to propose on its own.
 */
export async function chunksForConfirmedSection(
  sourceId: string,
  sectionId: string,
): Promise<string[]> {
  const db = getDb();
  const source = db.select().from(schema.sources).where(eq(schema.sources.id, sourceId)).get();
  if (!source) return [];

  const chunks = db
    .select({ id: schema.chunks.id, embedding: schema.chunks.embedding })
    .from(schema.chunks)
    .where(eq(schema.chunks.sourceId, sourceId))
    .all();
  if (chunks.length === 0) return [];

  const sections = flatten(getTree(source.moduleId));
  const section = sections.find((node) => node.id === sectionId);
  if (!section) return [];

  const [sectionVector] = await embedSafely([profileOf(section, sections)]);
  if (!sectionVector) return chunks.map((chunk) => chunk.id);

  const scored = chunks
    .map((chunk) => ({ id: chunk.id, vector: fromBlob(chunk.embedding as Buffer | null) }))
    .filter((entry): entry is { id: string; vector: Float32Array } => entry.vector !== null)
    .map((entry) => ({ id: entry.id, score: cosine(entry.vector, sectionVector) }));

  if (scored.length === 0) return chunks.map((chunk) => chunk.id);

  const matched = scored
    .filter((entry) => entry.score >= CHUNK_MATCH_THRESHOLD)
    .map((entry) => entry.id);

  // You said this source belongs here. If nothing clears the bar, that is a
  // statement about the threshold, not a reason to attach nothing.
  return matched.length > 0 ? matched : chunks.map((chunk) => chunk.id);
}

export function listMappings(sourceId: string): SectionProposal[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.sourceSections)
    .where(eq(schema.sourceSections.sourceId, sourceId))
    .all();
  if (rows.length === 0) return [];

  const sections = db
    .select()
    .from(schema.sections)
    .where(
      inArray(
        schema.sections.id,
        rows.map((row) => row.sectionId),
      ),
    )
    .all();
  if (sections.length === 0) return [];

  const numbers = new Map(
    flatten(getTree(sections[0]!.moduleId)).map((node) => [node.id, node]),
  );

  return rows
    .map((row) => ({
      sectionId: row.sectionId,
      sectionNumber: numbers.get(row.sectionId)?.number ?? '',
      sectionTitle: numbers.get(row.sectionId)?.title ?? '',
      score: row.score ?? 0,
      chunkIds: row.chunkRange?.chunkIds ?? [],
      confirmed: row.confirmed,
    }))
    .sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber, undefined, { numeric: true }));
}

function existingProposals(sourceId: string, _sections: SectionNode[]): SectionProposal[] {
  return listMappings(sourceId);
}

/**
 * What a section "is about", as text to embed. Ancestor titles are included
 * because "Cortical layers" alone is ambiguous, while "The Brain > The cerebral
 * cortex > Cortical layers" is not.
 */
function profileOf(section: SectionNode, all: SectionNode[]): string {
  const byId = new Map(all.map((node) => [node.id, node]));
  const trail: string[] = [];
  let current: SectionNode | undefined = section;
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  const outcomes = section.learningOutcomes?.join('. ') ?? '';
  return [trail.join(' > '), outcomes].filter(Boolean).join('. ');
}
