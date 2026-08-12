import { asc, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { indexVector, removeVector } from '../db/vectorIndex.js';
import { embedSafely } from '../embeddings/index.js';
import { newId } from '../lib/ids.js';
import { toBlob } from '../lib/vector.js';

/**
 * Note blocks.
 *
 * Notes are stored as an ordered list of blocks rather than one markdown blob,
 * because Phase 2 needs to act on a single block — explain this further,
 * rewrite this, lock this — and a blob cannot be addressed that way. The
 * frontend renders them as one continuous document.
 *
 * Phase 1 has no generation, so every block here starts as user_written. The
 * origin and locked fields are still enforced now so that when generation
 * arrives it cannot walk over anything you wrote.
 */

export type NoteBlockRow = typeof schema.noteBlocks.$inferSelect;

export function listBlocks(sectionId: string): NoteBlockRow[] {
  return getDb()
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, sectionId))
    .orderBy(asc(schema.noteBlocks.position))
    .all();
}

export interface CreateBlockInput {
  sectionId: string;
  type: schema.NoteBlockType;
  markdown?: string;
  position?: number;
  figureId?: string | null;
  targetSectionId?: string | null;
  conceptIds?: string[];
  sourceRefs?: string[];
  origin?: schema.NoteBlockOrigin;
}

export async function createBlock(input: CreateBlockInput): Promise<NoteBlockRow> {
  const db = getDb();
  const id = newId();
  const position = input.position ?? nextPosition(input.sectionId);

  db.transaction((tx) => {
    if (input.position !== undefined) shiftFrom(tx, input.sectionId, input.position);
    tx.insert(schema.noteBlocks)
      .values({
        id,
        sectionId: input.sectionId,
        position,
        type: input.type,
        markdown: input.markdown ?? '',
        figureId: input.figureId ?? null,
        targetSectionId: input.targetSectionId ?? null,
        conceptIds: input.conceptIds ?? null,
        sourceRefs: input.sourceRefs ?? null,
        origin: input.origin ?? 'user_written',
      })
      .run();
  });

  await reembed(id, input.markdown ?? '');
  touchSection(input.sectionId);
  return db.select().from(schema.noteBlocks).where(eq(schema.noteBlocks.id, id)).get()!;
}

export interface UpdateBlockInput {
  markdown?: string;
  type?: schema.NoteBlockType;
  conceptIds?: string[];
  sourceRefs?: string[];
  locked?: boolean;
  figureId?: string | null;
  targetSectionId?: string | null;
}

export async function updateBlock(id: string, input: UpdateBlockInput): Promise<NoteBlockRow> {
  const db = getDb();
  const existing = db.select().from(schema.noteBlocks).where(eq(schema.noteBlocks.id, id)).get();
  if (!existing) throw new Error(`Note block not found: ${id}`);

  const patch: Partial<typeof schema.noteBlocks.$inferInsert> = {
    updatedAt: Math.floor(Date.now() / 1000),
  };
  if (input.markdown !== undefined) patch.markdown = input.markdown;
  if (input.type !== undefined) patch.type = input.type;
  if (input.conceptIds !== undefined) patch.conceptIds = input.conceptIds;
  if (input.sourceRefs !== undefined) patch.sourceRefs = input.sourceRefs;
  if (input.locked !== undefined) patch.locked = input.locked;
  if (input.figureId !== undefined) patch.figureId = input.figureId;
  if (input.targetSectionId !== undefined) patch.targetSectionId = input.targetSectionId;

  // Editing AI-generated text makes it yours, and regeneration must respect
  // that from this point on.
  if (input.markdown !== undefined && input.markdown !== existing.markdown) {
    if (existing.origin === 'ai_generated') patch.origin = 'user_edited';
  }

  db.update(schema.noteBlocks).set(patch).where(eq(schema.noteBlocks.id, id)).run();

  if (patch.markdown !== undefined) await reembed(id, patch.markdown);
  touchSection(existing.sectionId);
  return db.select().from(schema.noteBlocks).where(eq(schema.noteBlocks.id, id)).get()!;
}

export function deleteBlock(id: string): void {
  const db = getDb();
  const existing = db.select().from(schema.noteBlocks).where(eq(schema.noteBlocks.id, id)).get();
  if (!existing) return;

  db.transaction((tx) => {
    tx.delete(schema.noteBlocks).where(eq(schema.noteBlocks.id, id)).run();
    tx.update(schema.noteBlocks)
      .set({ position: sql`${schema.noteBlocks.position} - 1` })
      .where(
        sql`${schema.noteBlocks.sectionId} = ${existing.sectionId} and ${schema.noteBlocks.position} > ${existing.position}`,
      )
      .run();
  });

  removeVector('note_block', id);
  touchSection(existing.sectionId);
}

/** Apply an explicit block order — the drag-to-reorder path in the editor. */
export function reorderBlocks(sectionId: string, orderedIds: string[]): NoteBlockRow[] {
  const db = getDb();
  db.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      tx.update(schema.noteBlocks)
        .set({ position: index })
        .where(
          sql`${schema.noteBlocks.id} = ${id} and ${schema.noteBlocks.sectionId} = ${sectionId}`,
        )
        .run();
    });
  });
  return listBlocks(sectionId);
}

// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

function shiftFrom(tx: Tx, sectionId: string, from: number): void {
  tx.update(schema.noteBlocks)
    .set({ position: sql`${schema.noteBlocks.position} + 1` })
    .where(
      sql`${schema.noteBlocks.sectionId} = ${sectionId} and ${schema.noteBlocks.position} >= ${from}`,
    )
    .run();
}

function nextPosition(sectionId: string): number {
  const row = getDb()
    .select({ max: sql<number | null>`max(${schema.noteBlocks.position})` })
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, sectionId))
    .get();
  return (row?.max ?? -1) + 1;
}

/**
 * Note blocks are embedded so Phase 2's coverage check can ask "is this concept
 * covered by any block in this section?". Keeping the vector current on every
 * edit means that check never runs against stale text.
 */
async function reembed(id: string, markdown: string): Promise<void> {
  const text = markdown.trim();
  if (!text) {
    getDb().update(schema.noteBlocks).set({ embedding: null }).where(eq(schema.noteBlocks.id, id)).run();
    removeVector('note_block', id);
    return;
  }

  const [vector] = await embedSafely([text]);
  if (!vector) return;

  getDb()
    .update(schema.noteBlocks)
    .set({ embedding: toBlob(vector) })
    .where(eq(schema.noteBlocks.id, id))
    .run();
  indexVector('note_block', id, vector);
}

/** A section with blocks in it is no longer 'empty'. */
function touchSection(sectionId: string): void {
  const db = getDb();
  const section = db.select().from(schema.sections).where(eq(schema.sections.id, sectionId)).get();
  if (!section || section.status !== 'empty') return;
  const count = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, sectionId))
    .get();
  if ((count?.n ?? 0) > 0) {
    db.update(schema.sections).set({ status: 'edited' }).where(eq(schema.sections.id, sectionId)).run();
  }
}
