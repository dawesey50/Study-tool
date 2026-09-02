import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { flatten, getTree } from '../sections.js';

/**
 * Blueprint sampling — §7.1.
 *
 * The shape of the question is decided here, in code, before any content
 * reaches the model. That ordering is the whole point of the design: asking a
 * model for ten questions gets you ten variations on its favourite question,
 * because nothing forced it to vary. Sampling the archetype, the distractor
 * strategy and the scenario first means the variety is structural rather than
 * hoped for.
 *
 * Nothing here calls a model. It is ordinary weighted sampling, which means it
 * is fully testable and costs nothing to run — worth knowing, because if the
 * variety this produces is not enough, no amount of prompt work downstream
 * will rescue it.
 */

export type BloomLevel =
  | 'recall'
  | 'comprehension'
  | 'application'
  | 'analysis'
  | 'evaluation';

export type Archetype =
  | 'direct_probe'
  | 'clinical_vignette'
  | 'experimental_result'
  | 'perturbation'
  | 'comparison'
  | 'data_interpretation'
  | 'quantitative'
  | 'error_identification'
  | 'bridge'
  | 'ordering'
  | 'exception';

export type DistractorStrategy =
  | 'right_fact_wrong_context'
  | 'adjacent_pathway_step'
  | 'common_misconception'
  | 'right_mechanism_wrong_direction'
  | 'correct_for_another_tissue'
  | 'impossible_by_stoichiometry';

/** What each archetype asks for, in the words the generator is given. */
export const ARCHETYPES: Record<Archetype, string> = {
  direct_probe: 'A straight test of the concept, asked precisely.',
  clinical_vignette:
    'A patient presentation. The student works backwards from the presentation to the mechanism.',
  experimental_result:
    'Here is what the assay showed. The student explains why, from the mechanism.',
  perturbation:
    'Something is inhibited, knocked out or removed. The student works out what happens downstream.',
  comparison:
    'Two conditions, tissues or species. The student identifies the difference and explains why it exists.',
  data_interpretation:
    'A graph, table, gel or trace to read. The answer is in the data, not in recall.',
  quantitative:
    'A number to work out — ATP yield, a rate, a concentration, a Km or Vmax.',
  error_identification:
    "A student's flawed reasoning is presented. The reader finds the mistake and says why it is one.",
  bridge:
    'Two concepts from different sections, which cannot be answered from either one alone.',
  ordering: 'Sequence the steps of a pathway or process, where the order carries the meaning.',
  exception:
    'All of the following except — properly constructed, so the exception is a real distinction rather than a trick.',
};

export const DISTRACTOR_STRATEGIES: Record<DistractorStrategy, string> = {
  right_fact_wrong_context: 'A true statement that does not apply in the situation described.',
  adjacent_pathway_step: 'The step immediately before or after the correct one.',
  common_misconception: 'The thing students reliably believe that is not so.',
  right_mechanism_wrong_direction:
    'The correct mechanism with the sign, direction or gradient reversed.',
  correct_for_another_tissue:
    'True in a different tissue, species or metabolic state from the one asked about.',
  impossible_by_stoichiometry:
    'Superficially plausible but ruled out by stoichiometry, thermodynamics or mass balance.',
};

/**
 * Starter scenario seeds. Deliberately generic to biomedical science rather
 * than to one module: a seed's job is to stop two questions about the same
 * concept sharing a setting, and it does that whatever the module is.
 */
const DEFAULT_SEEDS: Array<{ category: string; value: string }> = [
  ...[
    'a 19-year-old student',
    'a 54-year-old with type 2 diabetes',
    'a marathon runner at hour three',
    'a neonate 6 hours after birth',
    'a patient on a beta blocker',
    'a patient in diabetic ketoacidosis',
    'someone fasting for 36 hours',
    'a patient with a mitochondrial myopathy',
  ].map((value) => ({ category: 'subject', value })),
  ...[
    'skeletal muscle',
    'hepatocytes',
    'cardiac muscle',
    'renal proximal tubule',
    'erythrocytes',
    'adipose tissue',
    'cerebral cortex',
    'pancreatic beta cells',
  ].map((value) => ({ category: 'tissue', value })),
  ...[
    'fed state',
    'overnight fast',
    'prolonged starvation',
    'maximal exercise',
    'hypoxia',
    'metabolic acidosis',
  ].map((value) => ({ category: 'state', value })),
  ...[
    'oligomycin',
    'rotenone',
    'a competitive inhibitor',
    'an uncoupling agent',
    'a gene knockout',
    'a temperature-sensitive mutant',
  ].map((value) => ({ category: 'perturbation', value })),
  ...[
    'a Western blot',
    'an oxygen electrode trace',
    'a Lineweaver-Burk plot',
    'a patch-clamp recording',
    'a glucose tolerance curve',
    'an enzyme activity assay',
  ].map((value) => ({ category: 'assay', value })),
];

/** Fills the seed bank the first time it is needed. Safe to call repeatedly. */
export function ensureScenarioSeeds(): number {
  const db = getDb();
  const existing = db.select().from(schema.scenarioSeeds).all();
  if (existing.length > 0) return existing.length;

  for (const seed of DEFAULT_SEEDS) {
    db.insert(schema.scenarioSeeds)
      .values({ id: newId(), category: seed.category, value: seed.value, compatibleWith: null })
      .run();
  }
  return DEFAULT_SEEDS.length;
}

export const CONSTRAINTS = [
  'must not name the pathway or enzyme directly in the stem',
  'must present data rather than prose',
  'must require rejecting a plausible-sounding mechanism',
  'must be answerable in under sixty seconds',
  'must hinge on a number, ratio or direction rather than a name',
];

export interface Blueprint {
  conceptIds: string[];
  sectionIds: string[];
  bloom: BloomLevel;
  format: schema.QuestionFormat;
  archetype: Archetype;
  distractors: DistractorStrategy[];
  scenario: string[];
  figureId: string | null;
  constraint: string | null;
}

export interface SampleOptions {
  moduleId: string;
  /** Restrict to these sections. Omitted means the whole module. */
  sectionIds?: string[];
  /** Deterministic sampling, for tests and for reproducing a run. */
  random?: () => number;
  /** Share of blueprints that must bridge two sections. §7.2 asks for ~40%. */
  bridgeShare?: number;
}

const BRIDGE_SHARE = 0.4;

/**
 * Bloom is skewed away from recall on purpose. A bank that is mostly recall is
 * a bank you can pass by recognition, which is the thing this exists to avoid.
 */
const BLOOM_WEIGHTS: Array<[BloomLevel, number]> = [
  ['recall', 1],
  ['comprehension', 2],
  ['application', 3],
  ['analysis', 3],
  ['evaluation', 1],
];

const FORMAT_WEIGHTS: Array<[schema.QuestionFormat, number]> = [
  ['mcq', 5],
  ['saq', 3],
  ['data_interp', 2],
  ['calculation', 1],
  ['essay', 1],
];

/** Archetypes that only make sense with something to look at. */
const NEEDS_FIGURE = new Set<Archetype>(['data_interpretation']);

export interface ConceptForSampling {
  id: string;
  sectionId: string;
  statement: string;
  emphasis: number;
  examinable: boolean;
  /** 0 = never got it wrong, 1 = always wrong. Drives "your measured weakness". */
  weakness: number;
  /** Days since extraction, as a crude recency signal. */
  ageDays: number;
}

/**
 * How badly you do on a concept, from what you have actually answered.
 *
 * An unanswered concept sits at 0.5 rather than 0: it is unknown, not known.
 * Treating "never tested" as "mastered" would quietly starve new material of
 * questions.
 */
export function conceptWeakness(moduleId: string): Map<string, number> {
  const db = getDb();
  const questions = db
    .select({ id: schema.questions.id, conceptIds: schema.questions.conceptIds })
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, moduleId))
    .all();
  if (questions.length === 0) return new Map();

  const attempts = db
    .select()
    .from(schema.attempts)
    .where(
      inArray(
        schema.attempts.questionId,
        questions.map((row) => row.id),
      ),
    )
    .all();
  if (attempts.length === 0) return new Map();

  const byQuestion = new Map(questions.map((row) => [row.id, row.conceptIds ?? []]));
  const tally = new Map<string, { right: number; total: number }>();

  for (const attempt of attempts) {
    for (const conceptId of byQuestion.get(attempt.questionId) ?? []) {
      const entry = tally.get(conceptId) ?? { right: 0, total: 0 };
      entry.total += 1;
      if (attempt.correct) entry.right += 1;
      tally.set(conceptId, entry);
    }
  }

  const weakness = new Map<string, number>();
  for (const [conceptId, entry] of tally) {
    weakness.set(conceptId, 1 - entry.right / entry.total);
  }
  return weakness;
}

export function conceptsForSampling(options: SampleOptions): ConceptForSampling[] {
  const db = getDb();
  const tree = flatten(getTree(options.moduleId));
  const wanted = options.sectionIds?.length
    ? tree.filter((node) => options.sectionIds!.includes(node.id))
    : tree;
  if (wanted.length === 0) return [];

  const rows = db
    .select()
    .from(schema.concepts)
    .where(
      inArray(
        schema.concepts.sectionId,
        wanted.map((node) => node.id),
      ),
    )
    .all();

  const weakness = conceptWeakness(options.moduleId);
  const now = Date.now() / 1000;

  return rows.map((row) => ({
    id: row.id,
    sectionId: row.sectionId,
    statement: row.statement,
    emphasis: row.emphasisScore ?? 0.5,
    examinable: row.examinableFlag,
    weakness: weakness.get(row.id) ?? 0.5,
    ageDays: Math.max(0, (now - row.createdAt) / 86_400),
  }));
}

/**
 * The weight a concept carries when picking what to ask about.
 *
 * Emphasis and examinability come from the material; weakness comes from you.
 * Recency is deliberately mild — a concept from six weeks ago that you keep
 * getting wrong should still outrank one from yesterday that you do not.
 */
export function conceptWeight(concept: ConceptForSampling): number {
  const emphasis = 0.5 + concept.emphasis;
  const examinable = concept.examinable ? 1.6 : 1;
  const weak = 0.5 + concept.weakness * 1.5;
  const recency = 1 + Math.max(0, 1 - concept.ageDays / 30) * 0.3;
  return emphasis * examinable * weak * recency;
}

function weightedPick<T>(items: T[], weight: (item: T) => number, random: () => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  if (total <= 0) return items[Math.floor(random() * items.length)]!;
  let roll = random() * total;
  for (const item of items) {
    roll -= weight(item);
    if (roll <= 0) return item;
  }
  return items[items.length - 1]!;
}

function pickFromWeights<T>(pairs: Array<[T, number]>, random: () => number): T {
  return weightedPick(pairs, ([, weight]) => weight, random)[0];
}

export interface SampleResult {
  blueprint: Blueprint;
  /** Why this shape, in one line — shown in the bank so a bad run is diagnosable. */
  rationale: string;
}

export function sampleBlueprint(options: SampleOptions): SampleResult | null {
  const random = options.random ?? Math.random;
  const concepts = conceptsForSampling(options);
  if (concepts.length === 0) return null;

  ensureScenarioSeeds();
  const db = getDb();
  const seeds = db.select().from(schema.scenarioSeeds).all();

  // --- which concepts ------------------------------------------------------
  const first = weightedPick(concepts, conceptWeight, random);
  const picked = [first];

  // §7.2 asks for roughly 40% bridges, and specifically across sections: real
  // exam questions integrate, and a bank of single-concept questions is a bank
  // you can answer one fact at a time.
  const wantBridge = random() < (options.bridgeShare ?? BRIDGE_SHARE);
  const elsewhere = concepts.filter((concept) => concept.sectionId !== first.sectionId);
  if (wantBridge && elsewhere.length > 0) {
    picked.push(weightedPick(elsewhere, conceptWeight, random));
  }

  const isBridge = picked.length > 1;

  // --- shape ---------------------------------------------------------------
  const bloom = pickFromWeights(BLOOM_WEIGHTS, random);
  const format = pickFromWeights(FORMAT_WEIGHTS, random);

  const archetypes = (Object.keys(ARCHETYPES) as Archetype[]).filter((archetype) => {
    if (archetype === 'bridge') return isBridge;
    // A bridge blueprint may still use another shape, but a single concept can
    // never honestly be a bridge.
    if (NEEDS_FIGURE.has(archetype) && format !== 'data_interp') return false;
    if (archetype === 'exception' && format !== 'mcq') return false;
    return true;
  });
  const archetype = isBridge && random() < 0.5
    ? 'bridge'
    : archetypes[Math.floor(random() * archetypes.length)] ?? 'direct_probe';

  const strategies = Object.keys(DISTRACTOR_STRATEGIES) as DistractorStrategy[];
  const distractors =
    format === 'mcq'
      ? shuffle(strategies, random).slice(0, 3)
      : [];

  const seedCount = Math.floor(random() * 4); // 0-3, per the spec
  const scenario = shuffle(seeds, random)
    .slice(0, Math.min(seedCount, seeds.length))
    .map((seed) => seed.value);

  const figureId =
    format === 'data_interp' || archetype === 'data_interpretation'
      ? figureForSections(picked.map((concept) => concept.sectionId), random)
      : null;

  const constraint =
    random() < 0.35 ? CONSTRAINTS[Math.floor(random() * CONSTRAINTS.length)]! : null;

  const blueprint: Blueprint = {
    conceptIds: picked.map((concept) => concept.id),
    sectionIds: [...new Set(picked.map((concept) => concept.sectionId))],
    bloom,
    format,
    archetype,
    distractors,
    scenario,
    figureId,
    constraint,
  };

  return {
    blueprint,
    rationale:
      `${archetype.replace(/_/g, ' ')} · ${format} · ${bloom}` +
      (isBridge ? ' · bridges two sections' : '') +
      (scenario.length ? ` · ${scenario.join(', ')}` : '') +
      (constraint ? ` · ${constraint}` : ''),
  };
}

function figureForSections(sectionIds: string[], random: () => number): string | null {
  const db = getDb();
  if (sectionIds.length === 0) return null;

  const chunkIds = db
    .select()
    .from(schema.sourceSections)
    .where(inArray(schema.sourceSections.sectionId, sectionIds))
    .all()
    .flatMap((row) => row.chunkRange?.chunkIds ?? []);
  if (chunkIds.length === 0) return null;

  const sourceIds = [
    ...new Set(
      db
        .select({ sourceId: schema.chunks.sourceId })
        .from(schema.chunks)
        .where(inArray(schema.chunks.id, chunkIds))
        .all()
        .map((row) => row.sourceId),
    ),
  ];
  if (sourceIds.length === 0) return null;

  const figures = db
    .select()
    .from(schema.figures)
    .where(inArray(schema.figures.sourceId, sourceIds))
    .all();
  if (figures.length === 0) return null;

  return figures[Math.floor(random() * figures.length)]!.id;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** The tuple §7.3 asks to have never been used before. */
export function blueprintSignature(blueprint: Blueprint): string {
  return [
    [...blueprint.conceptIds].sort().join('+'),
    blueprint.archetype,
    [...blueprint.scenario].sort().join('|'),
  ].join('::');
}

/** Signatures already in the bank, so a repeat can be recognised. */
export function usedSignatures(moduleId: string): Set<string> {
  const db = getDb();
  return new Set(
    db
      .select({ blueprint: schema.questions.blueprintJson })
      .from(schema.questions)
      .where(and(eq(schema.questions.moduleId, moduleId), eq(schema.questions.source, 'generated')))
      .all()
      .map((row) => {
        const blueprint = row.blueprint as unknown as Blueprint | null;
        return blueprint ? blueprintSignature(blueprint) : '';
      })
      .filter(Boolean),
  );
}
