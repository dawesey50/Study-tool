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

export interface PdfParseOptions {
  /** Where extracted figures are written. */
  figureDir: string;
  /** Filename prefix for extracted figures. */
  figurePrefix: string;
  /** Slides get slideNo set as well as pageNo. */
  treatPagesAsSlides: boolean;
}

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
  const candidates: ImageCandidate[] = [];

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
      candidates.push(...(await extractPageImages(pdfjs, page, pageNo, lines)));
    } catch (error) {
      warnings.push(`Page ${pageNo}: figure extraction failed (${(error as Error).message})`);
    }

    page.cleanup();
  }

  const figures = writeFigures(candidates, options, warnings);
  await doc.destroy();

  return { blocks, figures, pageCount: doc.numPages, warnings };
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

interface ImageCandidate {
  pageNo: number;
  width: number;
  height: number;
  /** RGBA pixel data. */
  rgba: Buffer;
  /** Content hash, used to drop logos and other repeated furniture. */
  hash: string;
  captionExtracted?: string;
}

async function extractPageImages(
  pdfjs: PdfjsModule,
  page: PdfPage,
  pageNo: number,
  lines: TextLine[],
): Promise<ImageCandidate[]> {
  const ops = await page.getOperatorList();
  const { OPS } = pdfjs;
  const out: ImageCandidate[] = [];

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

    const rgba = toRgba(image);
    if (!rgba) continue;

    out.push({
      pageNo,
      width: image.width,
      height: image.height,
      rgba,
      hash: createHash('sha1').update(rgba).digest('hex'),
      captionExtracted: findCaption(lines, placedBox(ctm)),
    });
  }

  return out;
}

/**
 * Image objects resolve asynchronously through a callback registry, and an
 * object that never resolves would hang ingestion, so the wait is bounded.
 */
function getImageObject(page: PdfPage, name: string): Promise<PdfImage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    try {
      page.objs.get(name, (obj: unknown) => {
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

/**
 * Write the surviving candidates to disk as PNGs.
 *
 * Two filters run first. Anything smaller than FIGURE_MIN_DIMENSION is a bullet,
 * rule or icon rather than a figure. Anything whose pixels repeat across three
 * or more pages is slide furniture — a university crest, a template band — and
 * the spec is explicit that decorative images do not belong in the notes.
 */
function writeFigures(
  candidates: ImageCandidate[],
  options: PdfParseOptions,
  warnings: string[],
): ExtractedFigure[] {
  const minDimension = config.ingest.figureMinDimension;

  const pagesByHash = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    const pages = pagesByHash.get(candidate.hash) ?? new Set<number>();
    pages.add(candidate.pageNo);
    pagesByHash.set(candidate.hash, pages);
  }

  fs.mkdirSync(options.figureDir, { recursive: true });

  const figures: ExtractedFigure[] = [];
  const written = new Set<string>();
  let skippedSmall = 0;
  let skippedRepeated = 0;

  for (const candidate of candidates) {
    if (candidate.width < minDimension || candidate.height < minDimension) {
      skippedSmall++;
      continue;
    }
    if ((pagesByHash.get(candidate.hash)?.size ?? 0) >= 3) {
      skippedRepeated++;
      continue;
    }
    // The same figure repeated on one page is still one figure.
    if (written.has(candidate.hash)) continue;
    written.add(candidate.hash);

    const filename = `${options.figurePrefix}-p${candidate.pageNo}-${candidate.hash.slice(0, 8)}.png`;
    const absolutePath = path.join(options.figureDir, filename);

    const png = new PNG({ width: candidate.width, height: candidate.height });
    candidate.rgba.copy(png.data);
    fs.writeFileSync(absolutePath, PNG.sync.write(png));

    figures.push({
      absolutePath,
      pageNo: candidate.pageNo,
      width: candidate.width,
      height: candidate.height,
      ...(candidate.captionExtracted ? { captionExtracted: candidate.captionExtracted } : {}),
    });
  }

  if (skippedSmall > 0) warnings.push(`Skipped ${skippedSmall} image(s) below the size threshold.`);
  if (skippedRepeated > 0) {
    warnings.push(`Skipped ${skippedRepeated} image(s) repeated across pages as template furniture.`);
  }

  return figures;
}

