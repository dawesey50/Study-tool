import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';

/**
 * The section tree.
 *
 * The rule that shapes this file: identity is the UUID, and the number you see
 * ("1.2.1") is computed from tree position every time it is read. Nothing
 * stores a section number, so dragging a branch to a new place renumbers the
 * display without touching a single link, note block or concept.
 */

export interface SectionNode {
  id: string;
  moduleId: string;
  parentId: string | null;
  title: string;
  position: number;
  /** Derived from position: [1, 2, 1] renders as "1.2.1". */
  path: number[];
  number: string;
  depth: number;
  status: schema.SectionStatus;
  learningOutcomes: string[] | null;
  children: SectionNode[];
}

type SectionRow = typeof schema.sections.$inferSelect;

export function buildTree(rows: SectionRow[]): SectionNode[] {
  const byParent = new Map<string | null, SectionRow[]>();
  for (const row of rows) {
    const key = row.parentId ?? null;
    const siblings = byParent.get(key) ?? [];
    siblings.push(row);
    byParent.set(key, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  }

  // Top-level sections are numbered 1.0, 2.0 in the spec's example, but the
  // numbering itself is just "position within parent, one-indexed" at every
  // depth; the display style is the renderer's business.
  const visit = (parentId: string | null, prefix: number[], seen: Set<string>): SectionNode[] => {
    const siblings = byParent.get(parentId) ?? [];
    return siblings.flatMap((row, index) => {
      // A corrupt parent chain would otherwise recurse forever.
      if (seen.has(row.id)) return [];
      seen.add(row.id);

      const path = [...prefix, index + 1];
      return [
        {
          id: row.id,
          moduleId: row.moduleId,
          parentId: row.parentId,
          title: row.title,
          position: row.position,
          path,
          number: formatNumber(path),
          depth: path.length,
          status: row.status,
          learningOutcomes: row.learningOutcomes ?? null,
          children: visit(row.id, path, seen),
        },
      ];
    });
  };

  return visit(null, [], new Set());
}

/** Top-level sections read as "1.0"; deeper ones as "1.2.1". */
export function formatNumber(path: number[]): string {
  return path.length === 1 ? `${path[0]}.0` : path.join('.');
}

export function getTree(moduleId: string): SectionNode[] {
  const rows = getDb()
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.moduleId, moduleId))
    .orderBy(asc(schema.sections.position))
    .all();
  return buildTree(rows);
}

export function flatten(nodes: SectionNode[]): SectionNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export interface CreateSectionInput {
  moduleId: string;
  title: string;
  parentId?: string | null;
  learningOutcomes?: string[];
  /** Defaults to the end of the sibling list. */
  position?: number;
}

export function createSection(input: CreateSectionInput): SectionRow {
  const db = getDb();
  const parentId = input.parentId ?? null;

  if (parentId) assertSameModule(parentId, input.moduleId);

  const position = input.position ?? nextPosition(input.moduleId, parentId);
  const row: typeof schema.sections.$inferInsert = {
    id: newId(),
    moduleId: input.moduleId,
    parentId,
    title: input.title,
    position,
    learningOutcomes: input.learningOutcomes ?? null,
    status: 'empty',
  };

  db.transaction((tx) => {
    if (input.position !== undefined) {
      shiftSiblings(tx, input.moduleId, parentId, input.position);
    }
    tx.insert(schema.sections).values(row).run();
  });

  return db.select().from(schema.sections).where(eq(schema.sections.id, row.id)).get()!;
}

/**
 * Move a section to a new parent and/or position — the drag-and-drop path.
 *
 * The one thing that must not be allowed is dropping a section inside its own
 * subtree, which would detach that whole branch from the root.
 */
export function moveSection(id: string, parentId: string | null, position: number): SectionNode[] {
  const db = getDb();
  const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
  if (!section) throw new Error(`Section not found: ${id}`);

  if (parentId) {
    assertSameModule(parentId, section.moduleId);
    if (parentId === id || isDescendant(parentId, id)) {
      throw new Error('A section cannot be moved inside itself');
    }
  }

  db.transaction((tx) => {
    // Close the gap left behind, then open one at the destination.
    tx.update(schema.sections)
      .set({ position: sql`${schema.sections.position} - 1` })
      .where(
        and(
          eq(schema.sections.moduleId, section.moduleId),
          parentClause(section.parentId),
          sql`${schema.sections.position} > ${section.position}`,
        ),
      )
      .run();

    shiftSiblings(tx, section.moduleId, parentId, position);

    tx.update(schema.sections)
      .set({ parentId, position })
      .where(eq(schema.sections.id, id))
      .run();
  });

  normalisePositions(section.moduleId);
  return getTree(section.moduleId);
}

export function deleteSection(id: string): void {
  const db = getDb();
  const section = db.select().from(schema.sections).where(eq(schema.sections.id, id)).get();
  if (!section) return;
  // Children are removed by the self-referencing cascade in the migration.
  db.delete(schema.sections).where(eq(schema.sections.id, id)).run();
  normalisePositions(section.moduleId);
}

/**
 * Rewrite sibling positions to a dense 0..n-1 sequence. Runs after any move so
 * repeated reordering cannot drift into sparse or duplicated positions.
 */
export function normalisePositions(moduleId: string): void {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.moduleId, moduleId))
    .orderBy(asc(schema.sections.position))
    .all();

  const byParent = new Map<string | null, SectionRow[]>();
  for (const row of rows) {
    const key = row.parentId ?? null;
    const siblings = byParent.get(key) ?? [];
    siblings.push(row);
    byParent.set(key, siblings);
  }

  db.transaction((tx) => {
    for (const siblings of byParent.values()) {
      siblings.forEach((row, index) => {
        if (row.position === index) return;
        tx.update(schema.sections)
          .set({ position: index })
          .where(eq(schema.sections.id, row.id))
          .run();
      });
    }
  });
}

/**
 * Replace a module's tree wholesale. This is how a proposed hierarchy gets
 * committed after you have edited it, and how a hand-typed tree is saved.
 */
export interface TreeInput {
  id?: string;
  title: string;
  learningOutcomes?: string[];
  children?: TreeInput[];
}

export function replaceTree(moduleId: string, tree: TreeInput[]): SectionNode[] {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.moduleId, moduleId))
    .all();
  const existingIds = new Set(existing.map((row) => row.id));
  const keptIds = new Set<string>();

  db.transaction((tx) => {
    const walk = (nodes: TreeInput[], parentId: string | null) => {
      nodes.forEach((node, index) => {
        // Reusing the id where the caller supplied one is what preserves the
        // notes, concepts and questions already attached to that section.
        const id = node.id && existingIds.has(node.id) ? node.id : newId();
        keptIds.add(id);

        if (existingIds.has(id)) {
          tx.update(schema.sections)
            .set({
              title: node.title,
              parentId,
              position: index,
              learningOutcomes: node.learningOutcomes ?? null,
            })
            .where(eq(schema.sections.id, id))
            .run();
        } else {
          tx.insert(schema.sections)
            .values({
              id,
              moduleId,
              parentId,
              title: node.title,
              position: index,
              learningOutcomes: node.learningOutcomes ?? null,
              status: 'empty',
            })
            .run();
        }

        if (node.children?.length) walk(node.children, id);
      });
    };

    walk(tree, null);

    for (const row of existing) {
      if (!keptIds.has(row.id)) {
        tx.delete(schema.sections).where(eq(schema.sections.id, row.id)).run();
      }
    }
  });

  return getTree(moduleId);
}

// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

const parentClause = (parentId: string | null) =>
  parentId === null ? sql`${schema.sections.parentId} is null` : eq(schema.sections.parentId, parentId);

function shiftSiblings(tx: Tx, moduleId: string, parentId: string | null, from: number): void {
  tx.update(schema.sections)
    .set({ position: sql`${schema.sections.position} + 1` })
    .where(
      and(
        eq(schema.sections.moduleId, moduleId),
        parentClause(parentId),
        sql`${schema.sections.position} >= ${from}`,
      ),
    )
    .run();
}

function nextPosition(moduleId: string, parentId: string | null): number {
  const row = getDb()
    .select({ max: sql<number | null>`max(${schema.sections.position})` })
    .from(schema.sections)
    .where(and(eq(schema.sections.moduleId, moduleId), parentClause(parentId)))
    .get();
  return (row?.max ?? -1) + 1;
}

function assertSameModule(parentId: string, moduleId: string): void {
  const parent = getDb()
    .select({ moduleId: schema.sections.moduleId })
    .from(schema.sections)
    .where(eq(schema.sections.id, parentId))
    .get();
  if (!parent) throw new Error(`Parent section not found: ${parentId}`);
  if (parent.moduleId !== moduleId) {
    throw new Error('Cannot nest a section under a parent from a different module');
  }
}

function isDescendant(candidateId: string, ancestorId: string): boolean {
  const db = getDb();
  let current: string | null = candidateId;
  const seen = new Set<string>();

  while (current) {
    if (seen.has(current)) return false;
    seen.add(current);
    const row: { parentId: string | null } | undefined = db
      .select({ parentId: schema.sections.parentId })
      .from(schema.sections)
      .where(eq(schema.sections.id, current))
      .get();
    if (!row?.parentId) return false;
    if (row.parentId === ancestorId) return true;
    current = row.parentId;
  }
  return false;
}
