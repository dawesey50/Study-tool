import { asc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { complete, startRun, type LlmRun } from '../llm/index.js';
import { HIERARCHY_SCHEMA, HIERARCHY_SYSTEM, hierarchyPrompt } from '../llm/prompts.js';
import { flatten, getTree, replaceTree, type TreeInput } from './sections.js';

/**
 * Proposing a section hierarchy from the material — §4.
 *
 * The spec calls this the default flow and it was the last part of §4 never
 * built. Until now a new module started with an empty tree and a text box, so
 * the first twenty minutes with a new unit was typing out a handbook contents
 * page — felt on day one of every module rather than in week eight.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO
 *
 * It does not apply the proposal. `replaceTree` deletes any section not present
 * in what it is given, along with the notes inside it, so a hierarchy that
 * arrived by itself and rearranged your work would be the single most
 * destructive thing in the system. The proposal comes back as data, and
 * something you look at before accepting.
 *
 * It does not read the whole of every source. A module's material is hundreds
 * of pages and the structure is visible in the titles and the first lines of
 * each document — so it sends an outline, not a corpus. That keeps one
 * proposal to a single cheap call rather than a run that costs pounds and
 * risks the token ceiling on a module with a textbook in it.
 */

export interface ProposedSection {
  title: string;
  rationale?: string;
  children?: ProposedSection[];
  /** True when a section with this exact title already exists. */
  existing?: boolean;
}

export interface HierarchyProposal {
  moduleId: string;
  sections: ProposedSection[];
  /** What it was shown, so a poor proposal can be explained. */
  sourcesConsidered: Array<{ title: string; type: string; outlineLines: number }>;
  /** Sections that exist now and are absent from the proposal — these would be deleted. */
  wouldRemove: string[];
  costUsd: number;
}

/** Lines from a source that read like headings, for the outline. */
const MAX_OUTLINE_LINES = 12;

/**
 * A crude outline of a document: the shortest lines from its first chunks.
 *
 * Slide titles and section headings are short and sit at the start of a chunk;
 * body prose is long. That is a heuristic and it will pick up the odd stray
 * line, which is survivable — the model is being asked for a structure, not
 * for a transcription, and a wrong line costs nothing but a little noise.
 */
export function outlineOf(chunks: Array<{ text: string }>, limit = MAX_OUTLINE_LINES): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    for (const raw of chunk.text.split('\n')) {
      const line = raw.trim();
      if (line.length < 4 || line.length > 80) continue;
      // A heading rarely ends in a full stop, and body text usually does.
      if (/[.,;:]$/.test(line)) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
      if (lines.length >= limit) return lines;
    }
  }
  return lines;
}

export interface ProposeOptions {
  moduleId: string;
  run?: LlmRun;
  signal?: AbortSignal;
}

export async function proposeHierarchy(options: ProposeOptions): Promise<HierarchyProposal> {
  const db = getDb();

  const module = db
    .select()
    .from(schema.modules)
    .where(eq(schema.modules.id, options.moduleId))
    .get();
  if (!module) throw new Error('Module not found');

  const sources = db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.moduleId, options.moduleId))
    .all()
    .filter((source) => source.status === 'ingested')
    // Past papers describe what was examined, not how the module was taught,
    // and a hierarchy built from them would be shaped like an exam paper.
    .filter((source) => source.type !== 'past_paper')
    .sort((a, b) => (a.lectureDate ?? '').localeCompare(b.lectureDate ?? ''));

  if (sources.length === 0) {
    throw new Error(
      'No ingested material to propose a hierarchy from. Upload the lecture slides or ' +
        'handbook first — the structure is read off their titles, not invented.',
    );
  }

  const outlines = sources.map((source) => {
    const chunks = db
      .select({ text: schema.chunks.text })
      .from(schema.chunks)
      .where(eq(schema.chunks.sourceId, source.id))
      .orderBy(asc(schema.chunks.position))
      .limit(4)
      .all();

    return {
      title: source.title,
      type: source.type,
      date: source.lectureDate,
      outline: outlineOf(chunks),
    };
  });

  const existingTitles = flatten(getTree(options.moduleId)).map((node) => node.title);

  const run =
    options.run ?? startRun({ label: `Hierarchy for ${module.title}`, moduleId: options.moduleId });

  const response = await complete({
    task: 'hierarchy_proposal',
    system: HIERARCHY_SYSTEM,
    prompt: hierarchyPrompt({
      moduleTitle: module.title,
      sources: outlines,
      existing: existingTitles,
    }),
    jsonSchema: HIERARCHY_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2500,
    moduleId: options.moduleId,
    run,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const raw = (response.json ?? {}) as { sections?: ProposedSection[] };
  const sections = clean(raw.sections ?? [], new Set(existingTitles));

  const proposedTitles = new Set(titlesIn(sections));

  return {
    moduleId: options.moduleId,
    sections,
    sourcesConsidered: outlines.map((source) => ({
      title: source.title,
      type: source.type,
      outlineLines: source.outline.length,
    })),
    // Named explicitly rather than left to be discovered after the fact:
    // applying a proposal deletes the notes in any section it omits.
    wouldRemove: existingTitles.filter((title) => !proposedTitles.has(title)),
    costUsd: run.costUsd,
  };
}

/** Drops empty titles and marks the ones that already exist. */
function clean(sections: ProposedSection[], existing: Set<string>): ProposedSection[] {
  const kept: ProposedSection[] = [];
  for (const section of sections) {
    const title = (section.title ?? '').trim();
    if (!title) continue;
    const children = clean(section.children ?? [], existing);
    kept.push({
      title,
      ...(section.rationale ? { rationale: section.rationale } : {}),
      ...(children.length ? { children } : {}),
      ...(existing.has(title) ? { existing: true } : {}),
    });
  }
  return kept;
}

function titlesIn(sections: ProposedSection[]): string[] {
  return sections.flatMap((section) => [section.title, ...titlesIn(section.children ?? [])]);
}

/**
 * Apply a proposal, or a version of it you have edited.
 *
 * Kept separate from proposing on purpose. `replaceTree` deletes any section
 * not present in what it is given, along with its notes — so this is only ever
 * reached by someone pressing a button having seen what would go.
 */
export function applyHierarchy(moduleId: string, sections: ProposedSection[]) {
  /**
   * Existing sections are matched back to their ids by title.
   *
   * This is the difference between keeping a section and rebuilding it.
   * `replaceTree` reuses a section when it is handed the id, and creates a new
   * one otherwise — so passing titles alone deletes every section and recreates
   * it, taking its notes, concepts and questions with it. The proposal marks
   * sections as `existing` and tells you they will be kept; without this that
   * promise is false, and false in the most expensive possible way.
   *
   * Title is the only thing a proposal can be matched on, since a model
   * returns text rather than ids. Two sections sharing a title is possible and
   * the first wins, which is the same rule the tree view already applies.
   */
  const byTitle = new Map<string, string>();
  for (const node of flatten(getTree(moduleId))) {
    if (!byTitle.has(node.title)) byTitle.set(node.title, node.id);
  }

  const toTree = (nodes: ProposedSection[]): TreeInput[] =>
    nodes.map((node) => {
      const id = byTitle.get(node.title);
      return {
        ...(id ? { id } : {}),
        title: node.title,
        ...(node.children?.length ? { children: toTree(node.children) } : {}),
      };
    });

  return replaceTree(moduleId, toTree(sections));
}

/** Sections that would lose notes if a proposal were applied. */
export function notesAtRisk(moduleId: string, sections: ProposedSection[]) {
  const db = getDb();
  const proposed = new Set(titlesIn(sections));
  const nodes = flatten(getTree(moduleId)).filter((node) => !proposed.has(node.title));
  if (nodes.length === 0) return [];

  const blocks = db
    .select({ sectionId: schema.noteBlocks.sectionId })
    .from(schema.noteBlocks)
    .where(
      inArray(
        schema.noteBlocks.sectionId,
        nodes.map((node) => node.id),
      ),
    )
    .all();

  const counts = new Map<string, number>();
  for (const block of blocks) {
    counts.set(block.sectionId, (counts.get(block.sectionId) ?? 0) + 1);
  }

  return nodes
    .map((node) => ({
      sectionId: node.id,
      sectionPath: `${node.number} ${node.title}`,
      blocks: counts.get(node.id) ?? 0,
    }))
    .filter((entry) => entry.blocks > 0);
}
