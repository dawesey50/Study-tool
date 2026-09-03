import { asc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { complete, startRun, type LlmRun } from '../llm/index.js';
import {
  BLOCK_ACTIONS,
  BLOCK_ACTION_SCHEMA,
  BLOCK_ACTION_SYSTEM,
  blockActionPrompt,
  type BlockAction,
} from '../llm/prompts.js';
import { chunksForSection, listConcepts } from './concepts.js';
import { flatten, getTree } from './sections.js';

/**
 * Acting on one block of notes — §6.6.
 *
 * "Explain further", "go deeper", "simplify". A `section_rewrite` task has
 * been configured and routed since the LLM layer landed and nothing has ever
 * called it, which left notes take-it-or-leave-it: a paragraph that did not
 * land could only be fixed by regenerating the whole section and losing
 * everything else in it.
 *
 * TWO THINGS THIS DOES NOT DO
 *
 * It does not write over your block. The result comes back as a proposal with
 * the original beside it, because the whole point is that you are dissatisfied
 * with one paragraph — not that you want it replaced by something you have not
 * read. Accepting is a second, separate action, and it goes through the normal
 * update path so the block is marked `user_edited` exactly as if you had
 * rewritten it yourself.
 *
 * It does not let the model reach outside the section's own sources. Asking to
 * "go deeper" is precisely the request most likely to be answered with
 * something plausible and absent from the material, and a note that ends up in
 * your revision is the worst place for that. The prompt is given the same
 * chunks note generation had, and the schema has a flag for saying the sources
 * do not go that far — which is a better answer than an invention.
 */

export interface BlockActionResult {
  blockId: string;
  action: BlockAction;
  /** The block as it stands. Returned so the two can be shown side by side. */
  original: string;
  proposed: string;
  note: string | null;
  /** The sources did not support what was asked, and it says so. */
  limitedBySources: boolean;
  costUsd: number;
}

export interface RunActionOptions {
  blockId: string;
  action: BlockAction;
  /** Free-text instead of a preset. Overrides `action`'s wording. */
  instruction?: string;
  run?: LlmRun;
  signal?: AbortSignal;
}

/** Blocks either side, so a rewrite does not repeat what is already said. */
const CONTEXT_BLOCKS = 2;

export async function runBlockAction(options: RunActionOptions): Promise<BlockActionResult> {
  const db = getDb();

  const block = db
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.id, options.blockId))
    .get();
  if (!block) throw new Error('Block not found');

  if (block.locked) {
    // A locked block is a promise that nothing rewrites it. Producing a
    // proposal you could not apply would only waste a call.
    throw new Error(
      'That block is locked. Unlock it first — locked blocks are never rewritten, which is ' +
        'the point of the lock.',
    );
  }

  const section = db
    .select()
    .from(schema.sections)
    .where(eq(schema.sections.id, block.sectionId))
    .get();
  if (!section) throw new Error('Section not found');

  const chunks = chunksForSection(block.sectionId);
  if (chunks.length === 0) {
    throw new Error(
      'No source material is mapped to this section, so there is nothing to revise against. ' +
        'Map a source to it on the Sources page first.',
    );
  }

  const siblings = db
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.sectionId, block.sectionId))
    .orderBy(asc(schema.noteBlocks.position))
    .all();

  const index = siblings.findIndex((row) => row.id === block.id);
  const surrounding = siblings
    .slice(Math.max(0, index - CONTEXT_BLOCKS), index + CONTEXT_BLOCKS + 1)
    .filter((row) => row.id !== block.id)
    .map((row) => row.markdown);

  const node = flatten(getTree(section.moduleId)).find((entry) => entry.id === section.id);
  const run =
    options.run ??
    startRun({ label: `${options.action} on a block`, moduleId: section.moduleId });

  const response = await complete({
    task: 'section_rewrite',
    system: BLOCK_ACTION_SYSTEM,
    prompt: blockActionPrompt({
      action: options.action,
      instruction: options.instruction?.trim() || BLOCK_ACTIONS[options.action],
      sectionPath: node ? `${node.number} ${node.title}` : section.title,
      markdown: block.markdown,
      surrounding,
      chunks,
      concepts: listConcepts(block.sectionId).map((concept) => concept.statement),
    }),
    jsonSchema: BLOCK_ACTION_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2000,
    moduleId: section.moduleId,
    run,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const raw = (response.json ?? {}) as {
    markdown?: string;
    note?: string;
    limitedBySources?: boolean;
  };
  const proposed = (raw.markdown ?? '').trim();

  if (!proposed) {
    throw new Error('The model returned an empty block, so there is nothing to show you.');
  }

  return {
    blockId: block.id,
    action: options.action,
    original: block.markdown,
    proposed,
    note: raw.note?.trim() || null,
    limitedBySources: raw.limitedBySources === true,
    costUsd: run.costUsd,
  };
}
