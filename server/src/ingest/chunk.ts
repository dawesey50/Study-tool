import { config } from '../config.js';
import type { ParsedBlock } from './types.js';

export interface Chunk extends ParsedBlock {
  position: number;
}

/**
 * Group parsed blocks into chunks of roughly CHUNK_TARGET_CHARS.
 *
 * Two rules shape this. Chunks never span a page or slide boundary, because a
 * chunk's whole job is to point at one place in one document — a chunk covering
 * slides 13 and 14 cannot honestly cite either. And consecutive chunks within a
 * page overlap by CHUNK_OVERLAP_CHARS, so a passage split down the middle still
 * appears whole in at least one chunk for retrieval.
 */
export function chunkBlocks(blocks: ParsedBlock[]): Chunk[] {
  const target = config.ingest.chunkTargetChars;
  const overlap = Math.min(config.ingest.chunkOverlapChars, Math.floor(target / 2));
  const chunks: Chunk[] = [];

  for (const group of groupByLocation(blocks)) {
    const text = group.blocks
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n\n');
    if (!text) continue;

    for (const piece of splitText(text, target, overlap)) {
      chunks.push({
        text: piece,
        pageNo: group.pageNo,
        slideNo: group.slideNo,
        // The timestamp of the first block in the group is the closest honest
        // answer for "where in the recording does this start".
        timestamp: group.timestamp,
        position: chunks.length,
      });
    }
  }

  return chunks;
}

interface LocationGroup {
  pageNo?: number;
  slideNo?: number;
  timestamp?: number;
  blocks: ParsedBlock[];
}

/**
 * A group is a run of blocks that share one citable location.
 *
 * For paged documents that means the same page or slide. For a transcript there
 * is no page, but each block already carries its own start time, and merging
 * two of those would leave the result claiming the earlier timestamp while
 * containing later material — so a timestamped block always starts a new group.
 */
function groupByLocation(blocks: ParsedBlock[]): LocationGroup[] {
  const groups: LocationGroup[] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    const sameLocation =
      last !== undefined &&
      last.pageNo === block.pageNo &&
      last.slideNo === block.slideNo &&
      block.timestamp === undefined;

    if (sameLocation) {
      last.blocks.push(block);
    } else {
      groups.push({
        pageNo: block.pageNo,
        slideNo: block.slideNo,
        timestamp: block.timestamp,
        blocks: [block],
      });
    }
  }
  return groups;
}

/**
 * Split on the largest natural boundary that fits: paragraph, then sentence,
 * then whitespace. Only a single word longer than the target gets cut mid-token.
 */
function splitText(text: string, target: number, overlap: number): string[] {
  if (text.length <= target) return [text];

  const pieces: string[] = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= target) {
      pieces.push(text.slice(start).trim());
      break;
    }

    const window = text.slice(start, start + target);
    const cut = lastBoundary(window, target);
    const piece = text.slice(start, start + cut).trim();
    if (piece) pieces.push(piece);

    const next = start + cut - overlap;
    // Guarantee forward progress even if the boundary landed inside the overlap.
    start = next > start ? next : start + cut;
  }

  return pieces.filter(Boolean);
}

function lastBoundary(window: string, target: number): number {
  // Only accept a boundary in the last third, so chunks stay near the target
  // size rather than collapsing to the first paragraph break.
  const floor = Math.floor(target * 0.6);

  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph >= floor) return paragraph + 2;

  const sentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
    window.lastIndexOf('.\n'),
  );
  if (sentence >= floor) return sentence + 2;

  const space = window.lastIndexOf(' ');
  if (space >= floor) return space + 1;

  return window.length;
}
