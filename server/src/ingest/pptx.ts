import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { ExtractedFigure, ParsedBlock, ParseResult } from './types.js';

/**
 * PowerPoint, which is what lectures actually arrive as.
 *
 * This was missing, which made the whole system unusable for its intended
 * purpose: a biomedical sciences student's lectures are .pptx files, and
 * telling them to export thirty decks to PDF by hand is not a workaround, it
 * is a reason not to use the tool.
 *
 * HOW IT WORKS
 *
 * A .pptx is a ZIP of XML. Slide text lives in `ppt/slides/slideN.xml` inside
 * `<a:t>` elements, grouped into paragraphs by `<a:p>`. Speaker notes live in
 * `ppt/notesSlides/notesSlideN.xml` with the same shape. Images are files
 * under `ppt/media/`.
 *
 * That is parsed here directly rather than through a library, because every
 * library for this either wraps a headless Office install or does exactly
 * this. Reading it ourselves is about a hundred lines and keeps the dependency
 * list honest.
 *
 * WHY SPEAKER NOTES MATTER MORE THAN THE SLIDES
 *
 * A slide says "Oxidative phosphorylation → ATP". The notes underneath say
 * what the lecturer actually intended to explain, in sentences. For a system
 * whose entire job is extracting atomic, examinable concepts, the notes are
 * frequently the only prose in the file — so they are included, and marked, so
 * a citation can say which it came from.
 */

export interface PptxParseOptions {
  figureDir: string;
  figurePrefix: string;
}

/**
 * `<a:t>` carries the text runs. Escaping is minimal in these files but real,
 * so the five XML entities are decoded.
 */
function textOf(xml: string): string[] {
  const paragraphs: string[] = [];
  // Each <a:p>…</a:p> is a paragraph — a bullet, a title, a line of notes.
  for (const match of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...(match[1] ?? '').matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(
      (run) => run[1] ?? '',
    );
    const text = decode(runs.join('')).trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, or a doubly-escaped entity decodes wrongly.
    .replace(/&amp;/g, '&');
}

/** slide12.xml sorts after slide2.xml only if the number is read as a number. */
function slideNumber(name: string): number {
  const match = name.match(/(\d+)\.xml$/);
  return match ? Number(match[1]) : 0;
}

export async function parsePptx(
  filePath: string,
  options: PptxParseOptions,
): Promise<ParseResult> {
  const JSZip = (await import('jszip')).default;
  const warnings: string[] = [];
  const blocks: ParsedBlock[] = [];
  const figures: ExtractedFigure[] = [];

  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));

  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slideNames.length === 0) {
    return {
      blocks: [],
      figures: [],
      pageCount: 0,
      warnings: [
        'No slides found in this file. If it is a .ppt (the old binary format) rather than ' +
          'a .pptx, open it in PowerPoint and save it again as .pptx.',
      ],
    };
  }

  // Which notes file belongs to which slide is recorded in the slide's own
  // relationships, so a deck where the numbering does not line up still gets
  // the right notes attached.
  const notesFor = new Map<string, string>();
  for (const slideName of slideNames) {
    const relsName = slideName.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    const rels = zip.file(relsName);
    if (!rels) continue;
    const xml = await rels.async('string');
    const match = xml.match(/Target="[^"]*(notesSlide\d+\.xml)"/);
    if (match) notesFor.set(slideName, `ppt/notesSlides/${match[1]}`);
  }

  let withText = 0;

  for (const [index, slideName] of slideNames.entries()) {
    const slideNo = index + 1;
    const file = zip.file(slideName);
    if (!file) continue;

    const paragraphs = textOf(await file.async('string'));

    const notesName = notesFor.get(slideName);
    const notesFile = notesName ? zip.file(notesName) : null;
    const notes = notesFile ? textOf(await notesFile.async('string')) : [];

    // PowerPoint puts the slide number in the notes placeholder, so a notes
    // page whose only content is the slide's own number is not notes.
    const realNotes = notes.filter(
      (line) => !new RegExp(`^${slideNo}$`).test(line.trim()),
    );

    const parts: string[] = [];
    if (paragraphs.length > 0) parts.push(paragraphs.join('\n'));
    if (realNotes.length > 0) {
      // Labelled rather than merged. The slide is a heading and three bullets;
      // the notes are what the lecturer meant by them. Downstream, a concept
      // extracted from prose is a different kind of evidence from one squeezed
      // out of a bullet, and the citation should be able to say which.
      parts.push(`Speaker notes:\n${realNotes.join('\n')}`);
    }

    const text = parts.join('\n\n').trim();
    if (!text) continue;

    withText += 1;
    blocks.push({ text, slideNo, pageNo: slideNo });
  }

  // --- images --------------------------------------------------------------
  const mediaNames = Object.keys(zip.files).filter((name) =>
    /^ppt\/media\/.+\.(png|jpe?g|gif|bmp|tiff?|emf|wmf)$/i.test(name),
  );

  if (mediaNames.length > 0) fs.mkdirSync(options.figureDir, { recursive: true });

  let imageIndex = 0;
  for (const name of mediaNames) {
    const extension = path.extname(name).toLowerCase().replace('.', '');

    // EMF and WMF are Windows vector formats that no browser will render.
    // Writing them out would put a broken image in the figures strip, which
    // reads as a bug rather than as an unsupported format.
    if (extension === 'emf' || extension === 'wmf') continue;

    const file = zip.file(name);
    if (!file) continue;

    try {
      const buffer = await file.async('nodebuffer');
      // A deck's bullet glyphs and logos live in the same folder as its
      // diagrams. Size is the only signal available without decoding, and a
      // real diagram is never a few hundred bytes.
      if (buffer.length < 4096) continue;

      const filename = `${options.figurePrefix}-img${++imageIndex}.${extension}`;
      const absolutePath = path.join(options.figureDir, filename);
      fs.writeFileSync(absolutePath, buffer);
      figures.push({ absolutePath, width: 0, height: 0 });
    } catch (error) {
      warnings.push(`Image ${name} skipped: ${(error as Error).message}`);
    }
  }

  // --- what the deck actually gave us --------------------------------------
  const characters = blocks.reduce((total, block) => total + block.text.length, 0);
  const perSlide = characters / slideNames.length;

  // A deck exported as one flat image per slide parses cleanly and yields
  // nothing, which is the same failure a scanned PDF has and needs saying just
  // as loudly — everything downstream reads text.
  const likelyScanned = withText === 0 || (perSlide < 40 && figures.length >= withText);

  if (likelyScanned) {
    warnings.push(
      'This deck has almost no selectable text — the slides are probably images. Nothing ' +
        'downstream can read it. If the deck was exported from Keynote or Google Slides as ' +
        'pictures, re-export it keeping the text.',
    );
  } else if (withText < slideNames.length / 2) {
    warnings.push(
      `Only ${withText} of ${slideNames.length} slides carried any text. Title and image ` +
        'slides are normal, but if most of the deck is missing, check the original.',
    );
  }

  const notesCount = blocks.filter((block) => block.text.includes('Speaker notes:')).length;
  if (notesCount > 0) {
    warnings.push(
      `Speaker notes found on ${notesCount} slide${notesCount === 1 ? '' : 's'} and included. ` +
        'They are usually the only full sentences in a deck, so concepts extracted from this ' +
        'source will lean on them.',
    );
  } else if (perSlide < 150) {
    warnings.push(
      'No speaker notes, and the slides are terse. Concept extraction works from the words ' +
        'in the file, so a deck of bullet fragments gives it very little to go on.',
    );
  }

  return {
    blocks,
    figures,
    pageCount: slideNames.length,
    warnings,
    ...(likelyScanned ? { likelyScanned: true } : {}),
  };
}

void config;
