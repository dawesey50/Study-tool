import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { indexVector } from '../db/vectorIndex.js';
import { embedSafely } from '../embeddings/index.js';
import { newId, slugify } from '../lib/ids.js';
import { toBlob } from '../lib/vector.js';
import { fromStoredPath, toStoredPath } from '../lib/paths.js';
import { proposeSectionsForSource } from '../services/mapping.js';
import { chunkBlocks } from './chunk.js';
import { parseDocx } from './docx.js';
import { IngestCancelled, parsePdf } from './pdf.js';
import { parseTranscript } from './transcript.js';
import type { ParseResult } from './types.js';

export interface IngestResult {
  sourceId: string;
  chunks: number;
  figures: number;
  embedded: boolean;
  proposedSections: number;
  warnings: string[];
  /** The document was a scan, so almost no text could be read from it. */
  likelyScanned: boolean;
}

/**
 * Parse a stored source, chunk it, embed it and record everything with full
 * provenance, then propose which sections it belongs to.
 *
 * Ingestion is idempotent: re-ingesting replaces the source's chunks and
 * figures rather than accumulating duplicates. That matters because the most
 * common reason to re-run is a parser fix.
 */
export type IngestProgress = (
  phase: 'parsing' | 'embedding' | 'mapping',
  done: number,
  total: number,
) => void;

export async function ingestSource(
  sourceId: string,
  onProgress?: IngestProgress,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const db = getDb();
  const source = db.select().from(schema.sources).where(eq(schema.sources.id, sourceId)).get();
  if (!source) throw new Error(`Source not found: ${sourceId}`);

  db.update(schema.sources)
    .set({ status: 'ingesting', error: null })
    .where(eq(schema.sources.id, sourceId))
    .run();

  try {
    const absolutePath = fromStoredPath(source.path);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Stored file is missing at ${source.path}`);
    }

    const figureDir = path.join(config.mediaDir, 'figures', sourceId);
    const parsed = await parseFile(absolutePath, source.type, {
      figureDir,
      figurePrefix: slugify(source.title, 40),
      onProgress: (page, total) => onProgress?.('parsing', page, total),
      ...(signal ? { signal } : {}),
    });

    // Clear any previous run before writing the new one.
    db.delete(schema.chunks).where(eq(schema.chunks.sourceId, sourceId)).run();
    db.delete(schema.figures).where(eq(schema.figures.sourceId, sourceId)).run();

    const chunks = chunkBlocks(parsed.blocks);
    const chunkVectors = await embedSafely(
      chunks.map((c) => c.text),
      (done, total) => onProgress?.('embedding', done, total),
      signal,
    );
    const embedded = chunkVectors.some((v) => v !== null);

    const chunkIds = chunks.map(() => newId());
    const figureIds = parsed.figures.map(() => newId());

    // Figures are embedded on whatever caption text exists. Without a caption
    // there is nothing meaningful to embed yet — Phase 2's vision captioning
    // fills that gap, and the row is ready for it.
    const figureTexts = parsed.figures.map((f) => f.captionExtracted ?? '');
    const figureVectors = await embedSafely(figureTexts.map((t) => t || 'untitled figure'));

    db.transaction((tx) => {
      for (const [i, chunk] of chunks.entries()) {
        const vector = chunkVectors[i] ?? null;
        tx.insert(schema.chunks)
          .values({
            id: chunkIds[i]!,
            sourceId,
            text: chunk.text,
            embedding: vector ? toBlob(vector) : null,
            pageNo: chunk.pageNo ?? null,
            slideNo: chunk.slideNo ?? null,
            timestamp: chunk.timestamp ?? null,
            position: chunk.position,
          })
          .run();
      }

      for (const [i, figure] of parsed.figures.entries()) {
        const vector = figureTexts[i] ? figureVectors[i] ?? null : null;
        tx.insert(schema.figures)
          .values({
            id: figureIds[i]!,
            sourceId,
            path: toStoredPath(figure.absolutePath),
            pageNo: figure.pageNo ?? null,
            width: figure.width || null,
            height: figure.height || null,
            captionExtracted: figure.captionExtracted ?? null,
            embedding: vector ? toBlob(vector) : null,
          })
          .run();
      }

      tx.update(schema.sources)
        .set({
          status: 'ingested',
          ingestedAt: Math.floor(Date.now() / 1000),
          pageCount: parsed.pageCount ?? null,
          error: null,
        })
        .where(eq(schema.sources.id, sourceId))
        .run();
    });

    // The KNN index sits outside the transaction because vec0 virtual tables
    // do not participate in rollback the way ordinary tables do. It is derived
    // data and can be rebuilt with /api/embeddings/reindex if it drifts.
    for (const [i, vector] of chunkVectors.entries()) {
      if (vector) indexVector('chunk', chunkIds[i]!, vector);
    }
    for (const [i, vector] of figureVectors.entries()) {
      if (vector && figureTexts[i]) indexVector('figure', figureIds[i]!, vector);
    }

    onProgress?.('mapping', 0, 1);
    const proposed = await proposeSectionsForSource(sourceId);

    return {
      sourceId,
      chunks: chunks.length,
      figures: parsed.figures.length,
      embedded,
      proposedSections: proposed.length,
      warnings: parsed.warnings,
      likelyScanned: parsed.likelyScanned ?? false,
    };
  } catch (error) {
    // Cancelling is a decision, not a fault. Clear the partial work and put the
    // source back to "uploaded" so it reads as ready to try again rather than
    // as something that went wrong.
    if (error instanceof IngestCancelled || (error as Error)?.name === 'AbortError') {
      db.delete(schema.chunks).where(eq(schema.chunks.sourceId, sourceId)).run();
      db.delete(schema.figures).where(eq(schema.figures.sourceId, sourceId)).run();
      fs.rmSync(path.join(config.mediaDir, 'figures', sourceId), {
        recursive: true,
        force: true,
      });
      db.update(schema.sources)
        .set({ status: 'uploaded', error: null })
        .where(eq(schema.sources.id, sourceId))
        .run();
      throw new IngestCancelled();
    }

    const message = (error as Error).message;
    db.update(schema.sources)
      .set({ status: 'failed', error: message })
      .where(eq(schema.sources.id, sourceId))
      .run();
    throw error;
  }
}

async function parseFile(
  absolutePath: string,
  type: schema.SourceType,
  options: {
    figureDir: string;
    figurePrefix: string;
    onProgress?: (page: number, total: number) => void;
  },
): Promise<ParseResult> {
  const extension = path.extname(absolutePath).toLowerCase();

  if (extension === '.pdf') {
    return parsePdf(absolutePath, {
      ...options,
      // Slide decks get a slide number as well as a page number; for a textbook
      // scan the two would mean different things, so only pages are recorded.
      treatPagesAsSlides: type === 'slides',
    });
  }

  if (extension === '.docx') {
    return parseDocx(absolutePath, options);
  }

  if (['.txt', '.md', '.vtt', '.srt'].includes(extension)) {
    return parseTranscript(absolutePath);
  }

  throw new Error(
    `Unsupported file type "${extension}". Supported: .pdf, .docx, .txt, .md, .vtt, .srt`,
  );
}
