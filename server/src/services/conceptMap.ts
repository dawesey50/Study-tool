import { inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { flatten, getTree } from './sections.js';
import { masteryFromStability } from './schedule.js';

/**
 * The concept map — §10.
 *
 * `concept_links` has been populated by ownership assignment since concepts
 * landed, and read only to warn that another section says the same thing.
 * Drawn as a graph it answers a question no list can: where does this module
 * actually connect?
 *
 * WHAT IS AND IS NOT IN IT
 *
 * The edges are real and were measured, not inferred by a model at draw time:
 * ownership assignment compared every concept against every other and recorded
 * the pairs above the similarity threshold. So an edge means "these two say
 * something close to the same thing", which is a narrower claim than "these
 * two are related" — and it is the honest one, because it is the only one the
 * data supports.
 *
 * That narrowness makes the map useful in a specific way. A concept linked
 * across three sections is one the module keeps coming back to, and is
 * therefore both important and a good bridge question. A section with no
 * outgoing edges at all is either genuinely self-contained or has drifted in
 * vocabulary from the rest of the module.
 *
 * Nothing here calls a model or costs anything, which is why it can be
 * recomputed on every view rather than cached and left to go stale.
 */

export interface MapNode {
  id: string;
  sectionId: string;
  sectionPath: string;
  /** Index of the section in display order, for grouping and colour. */
  sectionIndex: number;
  statement: string;
  examinable: boolean;
  /** 0-1, from the schedule. Null when never reviewed. */
  mastery: number | null;
  /** How many links touch it — the module's own measure of centrality. */
  degree: number;
}

export interface MapEdge {
  from: string;
  to: string;
  type: string;
  note: string | null;
  /** True when the two ends sit in different sections. */
  crossSection: boolean;
}

export interface ConceptMap {
  moduleId: string;
  nodes: MapNode[];
  edges: MapEdge[];
  sections: Array<{ id: string; path: string; concepts: number; index: number }>;
  /**
   * Sections with no link to anywhere else. Called out because the reason is
   * worth knowing and there are two of them: genuinely self-contained, or
   * drifted in vocabulary from the rest of the module.
   */
  isolatedSections: string[];
}

export function conceptMap(moduleId: string): ConceptMap {
  const db = getDb();

  const nodes = flatten(getTree(moduleId));
  const sectionIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const sectionPath = new Map(nodes.map((node) => [node.id, `${node.number} ${node.title}`]));

  if (nodes.length === 0) {
    return { moduleId, nodes: [], edges: [], sections: [], isolatedSections: [] };
  }

  const concepts = db
    .select()
    .from(schema.concepts)
    .where(
      inArray(
        schema.concepts.sectionId,
        nodes.map((node) => node.id),
      ),
    )
    .all();

  if (concepts.length === 0) {
    return {
      moduleId,
      nodes: [],
      edges: [],
      sections: nodes.map((node) => ({
        id: node.id,
        path: sectionPath.get(node.id)!,
        concepts: 0,
        index: sectionIndex.get(node.id)!,
      })),
      isolatedSections: [],
    };
  }

  const conceptIds = concepts.map((concept) => concept.id);
  const inModule = new Set(conceptIds);

  const links = db
    .select()
    .from(schema.conceptLinks)
    .where(inArray(schema.conceptLinks.fromConceptId, conceptIds))
    .all()
    // A link can point at a concept in another module if one was deleted and
    // an id reused; drawing an edge to a node that is not on the map would
    // produce a line going nowhere.
    .filter((link) => inModule.has(link.toConceptId));

  const schedules = new Map(
    db
      .select()
      .from(schema.conceptSchedule)
      .where(inArray(schema.conceptSchedule.conceptId, conceptIds))
      .all()
      .map((row) => [row.conceptId, row]),
  );

  const sectionOf = new Map(concepts.map((concept) => [concept.id, concept.sectionId]));
  const degree = new Map<string, number>();
  const seen = new Set<string>();
  const edges: MapEdge[] = [];

  for (const link of links) {
    // Ownership records both directions of a match; drawing both would double
    // every line and double every degree.
    const key = [link.fromConceptId, link.toConceptId].sort().join('::') + link.type;
    if (seen.has(key)) continue;
    seen.add(key);

    const fromSection = sectionOf.get(link.fromConceptId);
    const toSection = sectionOf.get(link.toConceptId);

    edges.push({
      from: link.fromConceptId,
      to: link.toConceptId,
      type: link.type,
      note: link.note,
      crossSection: fromSection !== toSection,
    });

    degree.set(link.fromConceptId, (degree.get(link.fromConceptId) ?? 0) + 1);
    degree.set(link.toConceptId, (degree.get(link.toConceptId) ?? 0) + 1);
  }

  const linkedSections = new Set<string>();
  for (const edge of edges) {
    if (!edge.crossSection) continue;
    linkedSections.add(sectionOf.get(edge.from)!);
    linkedSections.add(sectionOf.get(edge.to)!);
  }

  const withConcepts = new Set(concepts.map((concept) => concept.sectionId));

  return {
    moduleId,
    nodes: concepts.map((concept) => {
      const schedule = schedules.get(concept.id);
      return {
        id: concept.id,
        sectionId: concept.sectionId,
        sectionPath: sectionPath.get(concept.sectionId) ?? '',
        sectionIndex: sectionIndex.get(concept.sectionId) ?? 0,
        statement: concept.statement,
        examinable: concept.examinableFlag,
        mastery:
          schedule && schedule.lastReview !== null
            ? masteryFromStability(schedule.stability)
            : null,
        degree: degree.get(concept.id) ?? 0,
      };
    }),
    edges,
    sections: nodes
      .filter((node) => withConcepts.has(node.id))
      .map((node) => ({
        id: node.id,
        path: sectionPath.get(node.id)!,
        concepts: concepts.filter((concept) => concept.sectionId === node.id).length,
        index: sectionIndex.get(node.id)!,
      })),
    isolatedSections: nodes
      .filter((node) => withConcepts.has(node.id) && !linkedSections.has(node.id))
      .map((node) => sectionPath.get(node.id)!),
  };
}
