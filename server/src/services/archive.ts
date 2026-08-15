import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { unzipSync, zipSync } from 'fflate';
import { getDb, schema } from '../db/index.js';
import { indexVector } from '../db/vectorIndex.js';
import { newId, slugify } from '../lib/ids.js';
import { fromStoredPath, storedPath } from '../lib/paths.js';
import { fromBlob } from '../lib/vector.js';

/**
 * Export and restore a module as a single file.
 *
 * The spec's central promise is that your material is yours and portable, and
 * a folder you are told to copy is not the same as the app helping you keep
 * your work. This produces one ordinary .zip — openable in Explorer or Finder,
 * readable without this program — containing the module's rows and every file
 * they point at.
 *
 * Embeddings travel with it as base64. They are derived data and could be
 * rebuilt, but only by a machine that can reach the model, and a restore is
 * exactly the moment you cannot count on that.
 */

const FORMAT_VERSION = 1;
const MANIFEST = 'module.json';

interface Manifest {
  format: number;
  exportedAt: string;
  module: unknown;
  sections: unknown[];
  sources: unknown[];
  sourceSections: unknown[];
  chunks: unknown[];
  figures: unknown[];
  noteBlocks: unknown[];
  concepts: unknown[];
  conceptLinks: unknown[];
  questions: unknown[];
}

/** BLOB columns cannot go into JSON, so they travel base64-encoded. */
function encodeBlobs<T extends Record<string, unknown>>(rows: T[], fields: string[]): unknown[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const field of fields) {
      const value = copy[field];
      copy[field] = value ? Buffer.from(value as Buffer).toString('base64') : null;
    }
    return copy;
  });
}

function decodeBlobs(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const copy = { ...row };
  for (const field of fields) {
    const value = copy[field];
    copy[field] = typeof value === 'string' ? Buffer.from(value, 'base64') : null;
  }
  return copy;
}

export interface ExportResult {
  filename: string;
  zip: Buffer;
}

export function exportModule(moduleId: string): ExportResult {
  const db = getDb();
  const module = db.select().from(schema.modules).where(eq(schema.modules.id, moduleId)).get();
  if (!module) throw new Error(`Module not found: ${moduleId}`);

  const sections = db
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.moduleId, moduleId))
    .all();
  const sources = db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.moduleId, moduleId))
    .all();

  const sectionIds = sections.map((row) => row.id);
  const sourceIds = sources.map((row) => row.id);

  const chunks = sourceIds.length
    ? db.select().from(schema.chunks).where(inArray(schema.chunks.sourceId, sourceIds)).all()
    : [];
  const figures = sourceIds.length
    ? db.select().from(schema.figures).where(inArray(schema.figures.sourceId, sourceIds)).all()
    : [];
  const sourceSections = sourceIds.length
    ? db
        .select()
        .from(schema.sourceSections)
        .where(inArray(schema.sourceSections.sourceId, sourceIds))
        .all()
    : [];
  const noteBlocks = sectionIds.length
    ? db
        .select()
        .from(schema.noteBlocks)
        .where(inArray(schema.noteBlocks.sectionId, sectionIds))
        .all()
    : [];
  const concepts = sectionIds.length
    ? db.select().from(schema.concepts).where(inArray(schema.concepts.sectionId, sectionIds)).all()
    : [];
  const conceptIds = concepts.map((row) => row.id);
  const conceptLinks = conceptIds.length
    ? db
        .select()
        .from(schema.conceptLinks)
        .where(inArray(schema.conceptLinks.fromConceptId, conceptIds))
        .all()
    : [];
  const questions = db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all();

  const manifest: Manifest = {
    format: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    module,
    sections,
    sources,
    sourceSections,
    chunks: encodeBlobs(chunks, ['embedding']),
    figures: encodeBlobs(figures, ['embedding']),
    noteBlocks: encodeBlobs(noteBlocks, ['embedding']),
    concepts: encodeBlobs(concepts, ['embedding']),
    conceptLinks,
    questions: encodeBlobs(questions, ['embedding']),
  };

  const files: Record<string, Uint8Array> = {
    [MANIFEST]: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };

  // Every file the rows point at, stored under the same relative path so a
  // restore can put them back exactly where they were.
  for (const source of sources) addFile(files, source.path);
  for (const figure of figures) addFile(files, figure.path);

  const zip = Buffer.from(
    zipSync(files, {
      // Media is already compressed; spending CPU on it again buys nothing.
      level: 6,
      mtime: new Date(),
    }),
  );

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    filename: `${slugify(module.code ?? module.title, 40)}-${stamp}.processor.zip`,
    zip,
  };
}

function addFile(files: Record<string, Uint8Array>, storedRelativePath: string): void {
  try {
    const absolute = fromStoredPath(storedRelativePath);
    if (fs.existsSync(absolute)) files[storedRelativePath] = fs.readFileSync(absolute);
  } catch {
    // A missing file should not stop the rest of the export. The manifest still
    // records the row, and the restore reports what could not be found.
  }
}

export interface ImportResult {
  moduleId: string;
  title: string;
  sections: number;
  sources: number;
  chunks: number;
  figures: number;
  noteBlocks: number;
  missingFiles: string[];
  remapped: boolean;
}

/**
 * Restore a module from an exported archive.
 *
 * Identifiers are preserved when nothing in the database would collide, so a
 * restore onto a clean install reproduces the original exactly. If the module
 * is already present the whole archive is remapped to fresh ids instead, which
 * turns a would-be conflict into a duplicate — an outcome you can look at and
 * delete, rather than a merge that silently overwrites work.
 */
export function importModule(zipBuffer: Buffer): ImportResult {
  const db = getDb();

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(zipBuffer));
  } catch {
    throw new Error('That file is not a readable Processor export (it is not a valid zip).');
  }

  const manifestBytes = files[MANIFEST];
  if (!manifestBytes) {
    throw new Error(`That zip has no ${MANIFEST}, so it is not a Processor export.`);
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  } catch {
    throw new Error(`The ${MANIFEST} in that archive is corrupt.`);
  }
  if (manifest.format !== FORMAT_VERSION) {
    throw new Error(
      `That export is format ${manifest.format}; this version reads format ${FORMAT_VERSION}.`,
    );
  }

  const original = manifest.module as typeof schema.modules.$inferSelect;
  const clash = db.select().from(schema.modules).where(eq(schema.modules.id, original.id)).get();
  const remapped = Boolean(clash);

  // One map for every identifier in the archive; identity when not remapping.
  const ids = new Map<string, string>();
  const map = (id: string): string => {
    if (!remapped) return id;
    let next = ids.get(id);
    if (!next) {
      next = newId();
      ids.set(id, next);
    }
    return next;
  };

  const moduleId = map(original.id);
  const missingFiles: string[] = [];

  // Restore media first: if the disk write fails, nothing has been committed.
  const writeMedia = (storedRelativePath: string, remappedPath: string): boolean => {
    const bytes = files[storedRelativePath];
    if (!bytes) {
      missingFiles.push(storedRelativePath);
      return false;
    }
    const absolute = fromStoredPath(remappedPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
    return true;
  };

  const sources = manifest.sources as Array<typeof schema.sources.$inferSelect>;
  const figures = manifest.figures as Array<Record<string, unknown>>;

  const sourcePaths = new Map<string, string>();
  for (const source of sources) {
    const newSourceId = map(source.id);
    const extension = path.extname(source.path);
    const newPath = remapped
      ? storedPath('media', 'sources', moduleId, `${newSourceId}${extension}`)
      : source.path;
    sourcePaths.set(source.id, newPath);
    writeMedia(source.path, newPath);
  }

  const figurePaths = new Map<string, string>();
  for (const figure of figures) {
    const figureId = figure.id as string;
    const oldPath = figure.path as string;
    const newFigureId = map(figureId);
    const newPath = remapped
      ? storedPath('media', 'figures', map(figure.sourceId as string), `${newFigureId}.png`)
      : oldPath;
    figurePaths.set(figureId, newPath);
    writeMedia(oldPath, newPath);
  }

  db.transaction((tx) => {
    tx.insert(schema.modules)
      .values({
        ...original,
        id: moduleId,
        title: remapped ? `${original.title} (restored)` : original.title,
      })
      .run();

    // Parents before children, so the self-referencing foreign key holds.
    const sections = manifest.sections as Array<typeof schema.sections.$inferSelect>;
    const ordered = [...sections].sort(
      (a, b) => depthOf(a, sections) - depthOf(b, sections) || a.position - b.position,
    );
    for (const section of ordered) {
      tx.insert(schema.sections)
        .values({
          ...section,
          id: map(section.id),
          moduleId,
          parentId: section.parentId ? map(section.parentId) : null,
        })
        .run();
    }

    for (const source of sources) {
      tx.insert(schema.sources)
        .values({ ...source, id: map(source.id), moduleId, path: sourcePaths.get(source.id)! })
        .run();
    }

    for (const row of manifest.sourceSections as Array<typeof schema.sourceSections.$inferSelect>) {
      tx.insert(schema.sourceSections)
        .values({ ...row, sourceId: map(row.sourceId), sectionId: map(row.sectionId) })
        .run();
    }

    for (const raw of manifest.chunks as Array<Record<string, unknown>>) {
      const row = decodeBlobs(raw, ['embedding']);
      tx.insert(schema.chunks)
        .values({
          ...(row as typeof schema.chunks.$inferInsert),
          id: map(raw.id as string),
          sourceId: map(raw.sourceId as string),
        })
        .run();
    }

    for (const raw of figures) {
      const row = decodeBlobs(raw, ['embedding']);
      tx.insert(schema.figures)
        .values({
          ...(row as typeof schema.figures.$inferInsert),
          id: map(raw.id as string),
          sourceId: map(raw.sourceId as string),
          path: figurePaths.get(raw.id as string)!,
        })
        .run();
    }

    for (const raw of manifest.noteBlocks as Array<Record<string, unknown>>) {
      const row = decodeBlobs(raw, ['embedding']);
      tx.insert(schema.noteBlocks)
        .values({
          ...(row as typeof schema.noteBlocks.$inferInsert),
          id: map(raw.id as string),
          sectionId: map(raw.sectionId as string),
          figureId: raw.figureId ? map(raw.figureId as string) : null,
          targetSectionId: raw.targetSectionId ? map(raw.targetSectionId as string) : null,
        })
        .run();
    }

    for (const raw of manifest.concepts as Array<Record<string, unknown>>) {
      const row = decodeBlobs(raw, ['embedding']);
      tx.insert(schema.concepts)
        .values({
          ...(row as typeof schema.concepts.$inferInsert),
          id: map(raw.id as string),
          sectionId: map(raw.sectionId as string),
        })
        .run();
    }

    for (const row of manifest.conceptLinks as Array<typeof schema.conceptLinks.$inferSelect>) {
      tx.insert(schema.conceptLinks)
        .values({
          ...row,
          fromConceptId: map(row.fromConceptId),
          toConceptId: map(row.toConceptId),
        })
        .run();
    }

    for (const raw of (manifest.questions ?? []) as Array<Record<string, unknown>>) {
      const row = decodeBlobs(raw, ['embedding']);
      tx.insert(schema.questions)
        .values({
          ...(row as typeof schema.questions.$inferInsert),
          id: map(raw.id as string),
          moduleId,
        })
        .run();
    }
  });

  // The KNN index is derived and lives outside the transaction, so it is
  // rebuilt for the restored rows rather than exported.
  reindexImported(moduleId);

  return {
    moduleId,
    title: original.title,
    sections: manifest.sections.length,
    sources: sources.length,
    chunks: manifest.chunks.length,
    figures: figures.length,
    noteBlocks: manifest.noteBlocks.length,
    missingFiles,
    remapped,
  };
}

function depthOf(
  section: typeof schema.sections.$inferSelect,
  all: Array<typeof schema.sections.$inferSelect>,
): number {
  let depth = 0;
  let current = section;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = all.find((row) => row.id === current.parentId);
    if (!parent) break;
    current = parent;
    depth++;
  }
  return depth;
}

function reindexImported(moduleId: string): void {
  const db = getDb();
  const sectionIds = db
    .select({ id: schema.sections.id })
    .from(schema.sections)
    .where(eq(schema.sections.moduleId, moduleId))
    .all()
    .map((row) => row.id);
  const sourceIds = db
    .select({ id: schema.sources.id })
    .from(schema.sources)
    .where(eq(schema.sources.moduleId, moduleId))
    .all()
    .map((row) => row.id);

  if (sourceIds.length) {
    for (const row of db
      .select({ id: schema.chunks.id, embedding: schema.chunks.embedding })
      .from(schema.chunks)
      .where(inArray(schema.chunks.sourceId, sourceIds))
      .all()) {
      const vector = fromBlob(row.embedding as Buffer | null);
      if (vector) indexVector('chunk', row.id, vector);
    }
  }

  if (sectionIds.length) {
    for (const row of db
      .select({ id: schema.noteBlocks.id, embedding: schema.noteBlocks.embedding })
      .from(schema.noteBlocks)
      .where(inArray(schema.noteBlocks.sectionId, sectionIds))
      .all()) {
      const vector = fromBlob(row.embedding as Buffer | null);
      if (vector) indexVector('note_block', row.id, vector);
    }
  }
}
