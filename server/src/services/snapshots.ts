import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { indexVector, removeVector } from '../db/vectorIndex.js';
import { embedSafely } from '../embeddings/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { toBlob } from '../lib/vector.js';

/**
 * Restore points.
 *
 * Everything else in this system is careful about your own writing: a block
 * carries an origin, a lock rejects edits, and a save never deletes a locked
 * block as a side effect. All of that is a promise about what generation will
 * do, and none of it has ever been tested against a real generator.
 *
 * A restore point is what makes that promise survivable the first time it is
 * tested. One is taken automatically before any run that rewrites notes in
 * bulk, and restoring takes one first, so the undo is itself undoable.
 *
 * Notes only, deliberately. Sources, chunks and figures are not at risk from a
 * generation run, and copying them would make a restore point as expensive as
 * a backup — which is a different feature, already built, and the right tool
 * for a different problem.
 */

const PAYLOAD_VERSION = 1;

export type SnapshotRow = typeof schema.noteSnapshots.$inferSelect;
type NoteBlockRow = typeof schema.noteBlocks.$inferSelect;

export interface SnapshotScope {
  moduleId: string;
  /** Omitted for a whole-module snapshot. */
  sectionId?: string;
}

/** Section ids covered by a scope, in tree order. */
function sectionIdsFor(scope: SnapshotScope): string[] {
  if (scope.sectionId) return [scope.sectionId];
  return getDb()
    .select({ id: schema.sections.id })
    .from(schema.sections)
    .where(eq(schema.sections.moduleId, scope.moduleId))
    .all()
    .map((row) => row.id);
}

function blocksIn(sectionIds: string[]): NoteBlockRow[] {
  if (sectionIds.length === 0) return [];
  return getDb()
    .select()
    .from(schema.noteBlocks)
    .where(inArray(schema.noteBlocks.sectionId, sectionIds))
    .orderBy(asc(schema.noteBlocks.sectionId), asc(schema.noteBlocks.position))
    .all();
}

/**
 * The embedding is derived and is by far the largest column; leaving it out
 * keeps a restore point small enough to take before every run without thinking
 * about it. Restoring re-embeds, and falls back to keyword search in the
 * meantime exactly as ingestion does.
 */
function withoutEmbedding(block: NoteBlockRow): Omit<NoteBlockRow, 'embedding'> {
  const { embedding: _embedding, ...rest } = block;
  return rest;
}

export interface TakeSnapshotInput extends SnapshotScope {
  label: string;
  reason: schema.SnapshotReason;
}

export function takeSnapshot(input: TakeSnapshotInput): SnapshotRow {
  const db = getDb();
  const blocks = blocksIn(sectionIdsFor(input));

  const id = newId();

  // Read the counter and write the row in one transaction, so two snapshots
  // can never be handed the same sequence number — which is the only thing
  // making "most recent" mean anything.
  db.transaction((tx) => {
    const highest =
      tx
        .select({ seq: schema.noteSnapshots.seq })
        .from(schema.noteSnapshots)
        .orderBy(desc(schema.noteSnapshots.seq))
        .limit(1)
        .get()?.seq ?? 0;

    tx.insert(schema.noteSnapshots)
      .values({
        id,
        moduleId: input.moduleId,
        sectionId: input.sectionId ?? null,
        label: input.label,
        reason: input.reason,
        blockCount: blocks.length,
        payload: { version: PAYLOAD_VERSION, noteBlocks: blocks.map(withoutEmbedding) },
        seq: highest + 1,
      })
      .run();
  });

  prune(input.moduleId);
  return db
    .select()
    .from(schema.noteSnapshots)
    .where(eq(schema.noteSnapshots.id, id))
    .get() as SnapshotRow;
}

/**
 * Keep the most recent few per module. Unbounded history would grow with every
 * generation run, and a restore point from six weeks and forty runs ago is not
 * something anyone reaches for.
 */
function prune(moduleId: string): void {
  const db = getDb();
  const keep = config.snapshotsKept;
  if (keep <= 0) return;

  const stale = db
    .select({ id: schema.noteSnapshots.id })
    .from(schema.noteSnapshots)
    .where(eq(schema.noteSnapshots.moduleId, moduleId))
    .orderBy(desc(schema.noteSnapshots.seq))
    .all()
    .slice(keep)
    .map((row) => row.id);

  if (stale.length) {
    db.delete(schema.noteSnapshots).where(inArray(schema.noteSnapshots.id, stale)).run();
  }
}

export function listSnapshots(moduleId: string): Array<Omit<SnapshotRow, 'payload'>> {
  return getDb()
    .select({
      id: schema.noteSnapshots.id,
      moduleId: schema.noteSnapshots.moduleId,
      sectionId: schema.noteSnapshots.sectionId,
      label: schema.noteSnapshots.label,
      reason: schema.noteSnapshots.reason,
      blockCount: schema.noteSnapshots.blockCount,
      seq: schema.noteSnapshots.seq,
      createdAt: schema.noteSnapshots.createdAt,
    })
    .from(schema.noteSnapshots)
    .where(eq(schema.noteSnapshots.moduleId, moduleId))
    .orderBy(desc(schema.noteSnapshots.seq))
    .all();
}

export function deleteSnapshot(id: string): void {
  getDb().delete(schema.noteSnapshots).where(eq(schema.noteSnapshots.id, id)).run();
}

export interface RestorePreview {
  /** Blocks that exist now and are not in the snapshot: restoring removes these. */
  removed: number;
  /** Of those, how many you wrote yourself. */
  removedUserWritten: number;
  /** Of those, how many are locked. */
  removedLocked: number;
  /** Blocks in the snapshot whose current text differs. */
  changed: number;
  /** Blocks in the snapshot that are no longer present. */
  restored: number;
}

/**
 * What a restore would do, before it does it.
 *
 * A restore is exact — it puts the scope back as it was — which means it can
 * delete work done since. That is the point of a restore point, but it must
 * never be a surprise, so the counts below are what the confirmation says.
 */
export function previewRestore(id: string): RestorePreview | null {
  const snapshot = getDb()
    .select()
    .from(schema.noteSnapshots)
    .where(eq(schema.noteSnapshots.id, id))
    .get();
  if (!snapshot) return null;

  const saved = (snapshot.payload?.noteBlocks ?? []) as NoteBlockRow[];
  const savedById = new Map(saved.map((block) => [block.id, block]));
  const current = blocksIn(
    sectionIdsFor({
      moduleId: snapshot.moduleId,
      ...(snapshot.sectionId ? { sectionId: snapshot.sectionId } : {}),
    }),
  );

  const gone = current.filter((block) => !savedById.has(block.id));
  return {
    removed: gone.length,
    removedUserWritten: gone.filter((block) => block.origin === 'user_written').length,
    removedLocked: gone.filter((block) => block.locked).length,
    changed: current.filter((block) => {
      const was = savedById.get(block.id);
      return was && was.markdown !== block.markdown;
    }).length,
    restored: saved.filter((block) => !current.some((row) => row.id === block.id)).length,
  };
}

export interface RestoreResult {
  moduleId: string;
  sectionId: string | null;
  blocks: number;
  /** The restore point taken of the state being replaced, so this is undoable. */
  undoSnapshotId: string;
}

export async function restoreSnapshot(id: string): Promise<RestoreResult> {
  const db = getDb();
  const snapshot = db
    .select()
    .from(schema.noteSnapshots)
    .where(eq(schema.noteSnapshots.id, id))
    .get();
  if (!snapshot) throw new Error('That restore point no longer exists');

  const scope: SnapshotScope = {
    moduleId: snapshot.moduleId,
    ...(snapshot.sectionId ? { sectionId: snapshot.sectionId } : {}),
  };

  // Before undoing anything, record what is being undone. Without this a
  // mistaken restore would be the one action in the system with no way back.
  // The label deliberately does not name the point being restored: undoing an
  // undo would then nest that name inside itself, and the list already shows
  // the time, scope and size, which is what you actually choose on.
  const undo = takeSnapshot({
    ...scope,
    label: 'Before an undo',
    reason: 'before_restore',
  });

  const saved = (snapshot.payload?.noteBlocks ?? []) as Array<Omit<NoteBlockRow, 'embedding'>>;
  const sectionIds = sectionIdsFor(scope);
  const existing = blocksIn(sectionIds);

  // A section deleted since the snapshot cannot take its blocks back.
  const liveSections = new Set(sectionIds);
  const restorable = saved.filter((block) => liveSections.has(block.sectionId));

  db.transaction((tx) => {
    for (const block of existing) {
      tx.delete(schema.noteBlocks).where(eq(schema.noteBlocks.id, block.id)).run();
    }
    for (const block of restorable) {
      tx.insert(schema.noteBlocks)
        .values({ ...(block as typeof schema.noteBlocks.$inferInsert), embedding: null })
        .run();
    }
  });

  for (const block of existing) removeVector('note_block', block.id);

  // Re-embed outside the transaction, in one batch: it can be slow, and it
  // must not be able to roll the restore back if the model cannot be reached.
  // A restore with no vectors is still a restore — search falls back to
  // keywords, exactly as it does for anything ingested offline.
  const vectors = await embedSafely(restorable.map((block) => block.markdown));
  restorable.forEach((block, index) => {
    const vector = vectors[index];
    if (!vector) return;
    db.update(schema.noteBlocks)
      .set({ embedding: toBlob(vector) })
      .where(eq(schema.noteBlocks.id, block.id))
      .run();
    indexVector('note_block', block.id, vector);
  });

  return {
    moduleId: snapshot.moduleId,
    sectionId: snapshot.sectionId,
    blocks: restorable.length,
    undoSnapshotId: undo.id,
  };
}

/**
 * The seam every bulk run goes through.
 *
 * Generation calls this rather than remembering to snapshot first, because
 * "remember to" is exactly the guarantee that fails on the run that needed it.
 * The snapshot is kept whether the work succeeds or fails: a run that threw
 * half way through is the most likely reason to want one.
 */
export async function withSnapshot<T>(
  scope: SnapshotScope & { label: string },
  work: (snapshot: SnapshotRow) => Promise<T>,
): Promise<T> {
  const snapshot = takeSnapshot({ ...scope, reason: 'before_generation' });
  return work(snapshot);
}

/** Whether a scope currently holds anything worth protecting. */
export function hasNotes(scope: SnapshotScope): boolean {
  const sectionIds = sectionIdsFor(scope);
  if (sectionIds.length === 0) return false;
  return (
    getDb()
      .select({ id: schema.noteBlocks.id })
      .from(schema.noteBlocks)
      .where(
        scope.sectionId
          ? and(eq(schema.noteBlocks.sectionId, scope.sectionId))
          : inArray(schema.noteBlocks.sectionId, sectionIds),
      )
      .limit(1)
      .all().length > 0
  );
}
