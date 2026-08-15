import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { config } from '../config.js';
import type { ExtractedFigure, ParsedBlock, ParseResult } from './types.js';

/**
 * PDF parsing for slides and textbook pages.
 *
 * Text keeps its page number, because a citation that cannot say "slide 14" is
 * not worth storing. Figures are pulled out of the PDF's own image objects
 * rather than by rasterising the page, so a diagram arrives at its original
 * resolution with no surrounding text baked into the bitmap. That avoids a
 * poppler dependency entirely — pdfjs already decodes these images to walk them.
 */

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

let pdfjsPromise: Promise<PdfjsModule> | null = null;
function loadPdfjs(): Promise<PdfjsModule> {
  // The legacy build is the one that runs outside a browser.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/** Thrown when the user cancels; handled rather than reported as a failure. */
export class IngestCancelled extends Error {
  constructor() {
    super('Ingestion cancelled');
    this.name = 'IngestCancelled';
  }
}

export interface PdfParseOptions {
  /** Where extracted figures are written. */
  figureDir: string;
  /** Filename prefix for extracted figures. */
  figurePrefix: string;
  /** Slides get slideNo set as well as pageNo. */
  treatPagesAsSlides: boolean;
  /** Reports page-by-page progress, so a long textbook is not a silent wait. */
  onProgress?: (page: number, total: number) => void;
  /** Checked between pages, so a cancelled ingest stops promptly. */
  signal?: AbortSignal;
}

/**
 * A single decoded image is capped at this many pixels (~64 megapixels, which
 * is far beyond any real figure). Decoding one to RGBA costs four bytes per
 * pixel, so without a ceiling a corrupt or pathological image could ask for
 * gigabytes in one allocation.
 */
const MAX_IMAGE_PIXELS = 64_000_000;

/** Beyond this many distinct figures, stop collecting rather than fill the disk. */
const MAX_FIGURES = 2_000;

export async function parsePdf(filePath: string, options: PdfParseOptions): Promise<ParseResult> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));

  const doc = await pdfjs.getDocument({
    data,
    // No DOM here, and neither font rendering nor eval is needed for extraction.
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const blocks: ParsedBlock[] = [];
  const warnings: string[] = [];

  /**
   * Figures are written to disk the moment they are decoded, and only their
   * metadata is kept.
   *
   * The earlier version accumulated every decoded image as raw RGBA and only
   * wrote them at the end. That is fine for a lecture deck and ruinous for a
   * textbook: 150 pages of scans held a gigabyte, and a real 900-page book
   * would have asked for several — enough to take the whole machine down,
   * which is exactly what happened. Peak memory now depends on the largest
   * single image rather than on the length of the book.
   */
  const collector: FigureCollector = {
    dir: options.figureDir,
    prefix: options.figurePrefix,
    minDimension: config.ingest.figureMinDimension,
    written: new Map(),
    pagesByHash: new Map(),
    skippedSmall: 0,
    skippedOversized: 0,
    hitLimit: false,
  };
  fs.mkdirSync(collector.dir, { recursive: true });

  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);

    let lines: TextLine[] = [];
    try {
      lines = await extractLines(page);
    } catch (error) {
      warnings.push(`Page ${pageNo}: text extraction failed (${(error as Error).message})`);
    }

    const text = linesToText(lines);
    if (text.trim()) {
      blocks.push({
        text,
        pageNo,
        ...(options.treatPagesAsSlides ? { slideNo: pageNo } : {}),
      });
    }

    try {
      await extractPageImages(pdfjs, page, pageNo, lines, collector);
    } catch (error) {
      warnings.push(`Page ${pageNo}: figure extraction failed (${(error as Error).message})`);
    }

    page.cleanup();
    options.onProgress?.(pageNo, doc.numPages);

    if (options.signal?.aborted) {
      await doc.destroy();
      throw new IngestCancelled();
    }

    // Hand the event loop back between pages. Parsing a long document is
    // minutes of CPU work, and without this the server answers nothing else in
    // the meantime — which made the whole app look frozen during an ingest.
    await new Promise((resolve) => setImmediate(resolve));
  }

  const figures = finaliseFigures(collector, warnings);
  const pageCount = doc.numPages;
  await doc.destroy();

  const likelyScanned = looksScanned(blocks, collector, pageCount);
  if (likelyScanned) {
    warnings.unshift(
      'This PDF appears to be a scan: its pages are images with little or no ' +
        'selectable text. Very little could be read from it, so notes, questions ' +
        'and search will have almost nothing to work with. It needs OCR.',
    );
  }

  return { blocks, figures, pageCount, warnings, likelyScanned };
}

/**
 * A scan is a document whose pages are pictures of text.
 *
 * Judged on the share of pages carrying real text rather than on the total,
 * because a scanned book often has a born-digital cover or contents page that
 * would otherwise mask the problem.
 */
function looksScanned(
  blocks: ParsedBlock[],
  collector: FigureCollector,
  pageCount: number,
): boolean {
  if (pageCount === 0) return false;

  const pagesWithText = new Set(
    blocks.filter((block) => block.text.trim().length > 40).map((block) => block.pageNo),
  ).size;
  const pagesWithImages = new Set([...collector.pagesByHash.values()].flatMap((pages) => [...pages]))
    .size;

  // Images on most pages, text on almost none.
  return pagesWithText / pageCount < 0.2 && pagesWithImages / pageCount > 0.5;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

interface TextLine {
  text: string;
  /** PDF user-space coordinates; y grows upwards from the bottom of the page. */
  x: number;
  y: number;
  height: number;
}

/**
 * pdfjs returns positioned fragments, not lines. Joining them in array order
 * mangles multi-column slides, so fragments are grouped into lines by their y
 * coordinate and ordered left to right within each line.
 */
async function extractLines(page: PdfPage): Promise<TextLine[]> {
  const content = await page.getTextContent();
  const rows = new Map<number, Array<{ str: string; x: number; y: number; height: number }>>();

  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const height = item.height || Math.abs(item.transform[3] ?? 10) || 10;
    // Quantise y so fragments on the same visual line land in one bucket
    // despite sub-pixel baseline differences.
    const key = Math.round(y / 3);
    const row = rows.get(key);
    if (row) row.push({ str: item.str, x, y, height });
    else rows.set(key, [{ str: item.str, x, y, height }]);
  }

  return [...rows.values()]
    .map((fragments) => {
      fragments.sort((a, b) => a.x - b.x);
      const first = fragments[0]!;
      return {
        text: joinFragments(fragments),
        x: first.x,
        y: first.y,
        height: Math.max(...fragments.map((f) => f.height)),
      };
    })
    .filter((line) => line.text.trim().length > 0)
    .sort((a, b) => b.y - a.y);
}

/**
 * PDFs often emit words, or even letters, as separate fragments with no spaces.
 * Insert one only where there is a visible horizontal gap.
 */
function joinFragments(fragments: Array<{ str: string; x: number; height: number }>): string {
  let out = '';
  let prevEnd: number | null = null;

  for (const fragment of fragments) {
    if (prevEnd !== null) {
      const gap = fragment.x - prevEnd;
      const needsSpace = gap > fragment.height * 0.2 && !out.endsWith(' ') && !fragment.str.startsWith(' ');
      if (needsSpace) out += ' ';
    }
    out += fragment.str;
    // Rough advance width: PDF glyphs average around half the font size.
    prevEnd = fragment.x + fragment.str.length * fragment.height * 0.5;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Turn ordered lines into paragraphs, breaking where vertical spacing jumps. */
function linesToText(lines: TextLine[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let prev: TextLine | null = null;

  for (const line of lines) {
    if (prev) {
      const gap = prev.y - line.y;
      if (gap > prev.height * 1.8) {
        if (current.length) paragraphs.push(current.join(' '));
        current = [];
      }
    }
    current.push(line.text);
    prev = line;
  }
  if (current.length) paragraphs.push(current.join(' '));

  return paragraphs.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * Accumulates figure metadata while the pixels themselves go straight to disk.
 * Keyed by content hash, so an image repeated across pages is stored once.
 */
interface FigureCollector {
  dir: string;
  prefix: string;
  minDimension: number;
  written: Map<string, { absolutePath: string; pageNo: number; width: number; height: number; captionExtracted?: string }>;
  /** Which pages each image appears on, for spotting template furniture. */
  pagesByHash: Map<string, Set<number>>;
  skippedSmall: number;
  skippedOversized: number;
  hitLimit: boolean;
}

async function extractPageImages(
  pdfjs: PdfjsModule,
  page: PdfPage,
  pageNo: number,
  lines: TextLine[],
  collector: FigureCollector,
): Promise<void> {
  const ops = await page.getOperatorList();
  const { OPS } = pdfjs;

  // The current transformation matrix places each image, which is drawn into
  // the unit square. Tracking it is what lets a figure be matched to the
  // caption sitting underneath it.
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = (ops.argsArray[i] ?? []) as unknown[];

    if (fn === OPS.save) {
      stack.push(ctm);
      continue;
    }
    if (fn === OPS.restore) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (fn === OPS.transform) {
      ctm = multiply(ctm, args as unknown as Matrix);
      continue;
    }
    if (fn !== OPS.paintImageXObject && fn !== OPS.paintInlineImageXObject) {
      continue;
    }

    const image =
      fn === OPS.paintInlineImageXObject
        ? (args[0] as PdfImage)
        : await getImageObject(page, args[0] as string);
    if (!image?.data) continue;

    // Cheap rejections first, before anything is decoded into memory.
    if (image.width < collector.minDimension || image.height < collector.minDimension) {
      collector.skippedSmall++;
      continue;
    }
    if (image.width * image.height > MAX_IMAGE_PIXELS) {
      collector.skippedOversized++;
      continue;
    }
    if (collector.written.size >= MAX_FIGURES) {
      collector.hitLimit = true;
      continue;
    }

    const rgba = toRgba(image);
    if (!rgba) continue;

    const hash = createHash('sha1').update(rgba).digest('hex');
    const pages = collector.pagesByHash.get(hash) ?? new Set<number>();
    pages.add(pageNo);
    collector.pagesByHash.set(hash, pages);

    // Write once per distinct image, then let the pixels go. Everything after
    // this point works from the file on disk.
    if (!collector.written.has(hash)) {
      const filename = `${collector.prefix}-p${pageNo}-${hash.slice(0, 8)}.png`;
      const absolutePath = path.join(collector.dir, filename);
      const png = new PNG({ width: image.width, height: image.height });
      rgba.copy(png.data);
      fs.writeFileSync(absolutePath, PNG.sync.write(png));

      const caption = findCaption(lines, placedBox(ctm));
      collector.written.set(hash, {
        absolutePath,
        pageNo,
        width: image.width,
        height: image.height,
        ...(caption ? { captionExtracted: caption } : {}),
      });
    }
  }
}

/**
 * Decide which of the written figures to keep.
 *
 * An image appearing on three or more pages is a crest, a template band or a
 * running header rather than a figure, and the spec is explicit that decorative
 * images do not belong in the notes. Those files are deleted here.
 */
function finaliseFigures(collector: FigureCollector, warnings: string[]): ExtractedFigure[] {
  const figures: ExtractedFigure[] = [];
  let skippedRepeated = 0;

  for (const [hash, meta] of collector.written) {
    if ((collector.pagesByHash.get(hash)?.size ?? 0) >= 3) {
      fs.rmSync(meta.absolutePath, { force: true });
      skippedRepeated++;
      continue;
    }
    figures.push(meta);
  }

  if (collector.skippedSmall > 0) {
    warnings.push(`Skipped ${collector.skippedSmall} image(s) below the size threshold.`);
  }
  if (collector.skippedOversized > 0) {
    warnings.push(`Skipped ${collector.skippedOversized} image(s) too large to decode safely.`);
  }
  if (skippedRepeated > 0) {
    warnings.push(`Skipped ${skippedRepeated} image(s) repeated across pages as template furniture.`);
  }
  if (collector.hitLimit) {
    warnings.push(`Stopped after ${MAX_FIGURES} figures; this document has an unusual number.`);
  }

  return figures.sort((a, b) => (a.pageNo ?? 0) - (b.pageNo ?? 0));
}

/**
 * Fetch a decoded image from pdfjs.
 *
 * pdfjs keeps images in one of two registries and the name says which. Once a
 * document is long enough, it starts promoting images to a document-level
 * cache and prefixes their names with "g_"; those are delivered through
 * commonObjs, and asking page.objs for one registers a callback that is never
 * called. Looking only in page.objs meant that from roughly page 256 of a
 * textbook, every single image waited out the timeout and produced nothing —
 * hours of apparent hanging with no figures and no error.
 *
 * The wait stays bounded anyway, because one unresolvable object should cost a
 * moment rather than stall the whole book.
 */
function getImageObject(page: PdfPage, name: string): Promise<PdfImage | null> {
  const store = name.startsWith('g_') ? page.commonObjs : page.objs;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    try {
      store.get(name, (obj: unknown) => {
        clearTimeout(timer);
        resolve((obj as PdfImage | undefined) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

type Matrix = [number, number, number, number, number, number];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m2[0] * m1[0] + m2[1] * m1[2],
    m2[0] * m1[1] + m2[1] * m1[3],
    m2[2] * m1[0] + m2[3] * m1[2],
    m2[2] * m1[1] + m2[3] * m1[3],
    m2[4] * m1[0] + m2[5] * m1[2] + m1[4],
    m2[4] * m1[1] + m2[5] * m1[3] + m1[5],
  ];
}

interface Box {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** The unit square, transformed by the CTM, is where the image lands. */
function placedBox(ctm: Matrix): Box {
  const corners: Array<[number, number]> = [
    [ctm[4], ctm[5]],
    [ctm[0] + ctm[4], ctm[1] + ctm[5]],
    [ctm[2] + ctm[4], ctm[3] + ctm[5]],
    [ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5]],
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    bottom: Math.min(...ys),
    top: Math.max(...ys),
  };
}

const CAPTION_PATTERN = /^\s*(fig(ure)?\.?|table|chart|diagram|scheme|plate)\s*[\d.]*[\s.:—-]/i;

/**
 * A caption is a line starting "Figure 2." that sits just below the image (or
 * just above it, as textbooks often do) and overlaps it horizontally.
 */
function findCaption(lines: TextLine[], box: Box): string | undefined {
  const searchDistance = Math.max(60, (box.top - box.bottom) * 0.35);
  let best: { line: TextLine; distance: number } | null = null;

  for (const line of lines) {
    if (!CAPTION_PATTERN.test(line.text)) continue;

    const below = box.bottom - line.y;
    const above = line.y - box.top;
    const distance = below >= 0 ? below : above >= 0 ? above * 1.5 : Infinity;
    if (distance > searchDistance) continue;

    const overlapsHorizontally = line.x < box.right && line.x > box.left - (box.right - box.left);
    if (!overlapsHorizontally) continue;

    if (!best || distance < best.distance) best = { line, distance };
  }

  return best?.line.text.trim();
}

interface PdfImage {
  width: number;
  height: number;
  /** 1 = grayscale 1bpp, 2 = RGB 24bpp, 3 = RGBA 32bpp. */
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
}

function toRgba(image: PdfImage): Buffer | null {
  const { width, height, kind, data } = image;
  if (!data || !width || !height) return null;

  const pixels = width * height;
  const rgba = Buffer.alloc(pixels * 4);

  switch (kind) {
    case 3: {
      // Already RGBA.
      if (data.length < pixels * 4) return null;
      Buffer.from(data.buffer, data.byteOffset, pixels * 4).copy(rgba);
      return rgba;
    }
    case 2: {
      if (data.length < pixels * 3) return null;
      for (let i = 0; i < pixels; i++) {
        rgba[i * 4] = data[i * 3]!;
        rgba[i * 4 + 1] = data[i * 3 + 1]!;
        rgba[i * 4 + 2] = data[i * 3 + 2]!;
        rgba[i * 4 + 3] = 255;
      }
      return rgba;
    }
    case 1: {
      // One bit per pixel, packed into rows padded to byte boundaries.
      const rowBytes = (width + 7) >> 3;
      if (data.length < rowBytes * height) return null;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const byte = data[y * rowBytes + (x >> 3)]!;
          const on = (byte >> (7 - (x & 7))) & 1;
          const value = on ? 255 : 0;
          const i = (y * width + x) * 4;
          rgba[i] = value;
          rgba[i + 1] = value;
          rgba[i + 2] = value;
          rgba[i + 3] = 255;
        }
      }
      return rgba;
    }
    default:
      return null;
  }
}


