import fs from 'node:fs';
import type { ParsedBlock, ParseResult } from './types.js';

/**
 * Lecture transcripts as plain text, VTT or SRT.
 *
 * Timestamps are kept when the file has them, because "transcript at 34:20" is
 * a far better citation than "somewhere in lecture 7", but their absence is not
 * a problem — plain text ingests just as well, only with weaker citations.
 */
export function parseTranscript(filePath: string): ParseResult {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const cues = parseCues(raw);

  const blocks: ParsedBlock[] =
    cues.length > 0 ? mergeCues(cues) : paragraphsOf(raw).map((text) => ({ text }));

  return {
    blocks,
    figures: [],
    warnings: cues.length === 0 && /-->/.test(raw)
      ? ['Timestamps were detected but could not be parsed; ingested as plain text.']
      : [],
  };
}

interface Cue {
  start: number;
  text: string;
}

const TIMESTAMP_LINE = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

function parseCues(raw: string): Cue[] {
  const cues: Cue[] = [];
  const lines = raw.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!TIMESTAMP_LINE.test(line)) continue;

    const start = toSeconds(line.split('-->')[0]!.trim());
    if (start === null) continue;

    // Cue text runs until the next blank line.
    const text: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) break;
      if (TIMESTAMP_LINE.test(next)) break;
      text.push(next.trim());
      i = j;
    }

    const joined = cleanCueText(text.join(' '));
    if (joined) cues.push({ start, text: joined });
  }

  return cues;
}

function toSeconds(stamp: string): number | null {
  const match = stamp.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]!.padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** Strip VTT inline markup and speaker labels that add nothing to the text. */
function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/^-\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Subtitle cues are a few seconds each, which is far too fine to chunk against.
 * Merge them into paragraph-sized blocks, keeping the timestamp of the first
 * cue in each so the citation still points at the right moment.
 *
 * A block is also cut whenever there is a large jump between consecutive cues.
 * A block carries the timestamp of its first cue, so material recorded minutes
 * later must not be swept into it — "transcript at 34:20" has to actually be at
 * 34:20, and a gap that size means the recording skipped or the lecturer moved on.
 */
const MAX_CUE_GAP_SECONDS = 60;

function mergeCues(cues: Cue[], targetChars = 700): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let buffer: string[] = [];
  let start = cues[0]!.start;
  let previousStart = cues[0]!.start;
  let length = 0;

  const flush = () => {
    if (!buffer.length) return;
    blocks.push({ text: dedupeOverlap(buffer).join(' '), timestamp: start });
    buffer = [];
    length = 0;
  };

  for (const cue of cues) {
    if (buffer.length > 0 && cue.start - previousStart > MAX_CUE_GAP_SECONDS) flush();
    if (buffer.length === 0) start = cue.start;

    buffer.push(cue.text);
    length += cue.text.length + 1;
    previousStart = cue.start;

    // Prefer to break at a sentence end once the block is big enough.
    if (length >= targetChars && /[.!?]$/.test(cue.text)) flush();
    else if (length >= targetChars * 1.6) flush();
  }
  flush();

  return blocks;
}

/**
 * Rolling captions repeat the previous line as the new one scrolls in. Dropping
 * an exact repeat of the preceding cue removes most of that duplication.
 */
function dedupeOverlap(cues: string[]): string[] {
  const out: string[] = [];
  for (const cue of cues) {
    if (out[out.length - 1] === cue) continue;
    out.push(cue);
  }
  return out;
}

export function paragraphsOf(raw: string): string[] {
  return raw
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
