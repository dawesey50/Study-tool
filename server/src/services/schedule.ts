import { and, eq, inArray, lte } from 'drizzle-orm';
import { createEmptyCard, fsrs, Rating, State, type Card, type FSRS, type Grade } from 'ts-fsrs';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { flatten, getTree } from './sections.js';

/**
 * Spaced repetition — §8.
 *
 * WHAT IS SCHEDULED
 *
 * Concepts, not questions. Scheduling questions would revise the question
 * rather than the thing it tests: the same wording comes back on the day it
 * falls due, and answering it correctly proves only that you remember that
 * question. A concept can be approached from eleven archetypes, so what comes
 * due here is the idea, and a question is drawn fresh against it.
 *
 * WHAT FSRS CAN AND CANNOT EXPRESS
 *
 * FSRS grades an answer Again, Hard, Good or Easy. Two of the four cases this
 * system cares about map cleanly — a correct answer you were unsure of is
 * Hard, a correct answer you were certain of is Easy — and one does not: every
 * wrong answer is Again, whether you guessed or would have bet money on it.
 *
 * Those are not the same problem. Being wrong about something you know you do
 * not know costs a review; being wrong about something you are certain of
 * means the thing you believe is wrong, and no amount of repetition fixes it
 * until you find out why. The temptation is to hand-adjust stability for that
 * case, and this deliberately does not: FSRS's parameters are fitted, and
 * pushing them by hand produces a schedule that is neither FSRS nor anything
 * else. So confident-and-wrong is counted alongside the schedule instead, and
 * surfaced separately as something to go and read rather than something to
 * drill.
 *
 * WHAT A BRIDGE QUESTION CAN HONESTLY TELL YOU
 *
 * A question that spans two concepts, answered wrongly, does not say which of
 * the two failed. The grade is applied to both, because the alternative —
 * guessing which one — invents evidence. It means a bridge question is weaker
 * evidence per concept than a single-concept one, which is worth knowing when
 * reading a mastery number built mostly out of bridges.
 */

/** One scheduler, built once: constructing it parses and clamps parameters. */
let engine: FSRS | null = null;
function scheduler(): FSRS {
  engine ??= fsrs({ request_retention: config.schedule.requestRetention });
  return engine;
}

export interface ScheduleRow {
  conceptId: string;
  stability: number | null;
  difficulty: number | null;
  dueDate: number | null;
  reps: number;
  lapses: number;
  lastReview: number | null;
  state: number;
  scheduledDays: number;
  elapsedDays: number;
  learningSteps: number;
  confidentlyWrong: number;
  lastGrade: number | null;
}

/** Seconds since the epoch, which is how every other timestamp here is stored. */
const toSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);
const toDate = (seconds: number | null): Date =>
  seconds === null ? new Date() : new Date(seconds * 1000);

function toCard(row: ScheduleRow | undefined, now: Date): Card {
  if (!row || row.lastReview === null) return createEmptyCard(now);
  return {
    due: toDate(row.dueDate),
    stability: row.stability ?? 0,
    difficulty: row.difficulty ?? 0,
    elapsed_days: row.elapsedDays,
    scheduled_days: row.scheduledDays,
    reps: row.reps,
    lapses: row.lapses,
    learning_steps: row.learningSteps,
    state: row.state as State,
    last_review: toDate(row.lastReview),
  };
}

/**
 * The grade an attempt earns.
 *
 * Confidence is what separates Hard from Easy, and it is why the interface
 * asks for it before revealing the answer: asked afterwards it would be a
 * memory of how you felt, and this mapping would be built on it.
 *
 * A confidence of 3 is the honest middle — Good — and an attempt with no
 * confidence recorded at all is treated as Good rather than as anything more
 * flattering, since assuming Easy would stretch intervals on no evidence.
 */
// `Grade` rather than `Rating`: Rating includes Manual, which is a schedule
// override rather than an answer, and nothing here should ever produce one.
export function gradeFor(correct: boolean, confidence: number | null): Grade {
  if (!correct) return Rating.Again;
  if (confidence === null) return Rating.Good;
  if (confidence <= 2) return Rating.Hard;
  if (confidence >= 5) return Rating.Easy;
  return Rating.Good;
}

export interface ReviewInput {
  conceptIds: string[];
  correct: boolean;
  confidence: number | null;
  /** For tests and for replaying history. Defaults to now. */
  at?: Date;
}

export interface ReviewOutcome {
  conceptId: string;
  grade: Grade;
  dueDate: number;
  /** Days until it comes round again, which is the number worth showing. */
  intervalDays: number;
  stability: number;
  lapsed: boolean;
  confidentlyWrong: boolean;
}

/**
 * Record one answer against every concept the question tested.
 *
 * Idempotent per call rather than per attempt: calling this twice for the same
 * attempt schedules two reviews, so it is called once, from the attempt route.
 */
export function recordReview(input: ReviewInput): ReviewOutcome[] {
  const db = getDb();
  const now = input.at ?? new Date();
  const grade = gradeFor(input.correct, input.confidence);
  const confidentlyWrong = !input.correct && (input.confidence ?? 0) >= 4;
  const outcomes: ReviewOutcome[] = [];

  for (const conceptId of input.conceptIds) {
    // A concept that has been deleted since the question was written should
    // not fail the attempt that referenced it.
    const concept = db
      .select({ id: schema.concepts.id })
      .from(schema.concepts)
      .where(eq(schema.concepts.id, conceptId))
      .get();
    if (!concept) continue;

    const existing = db
      .select()
      .from(schema.conceptSchedule)
      .where(eq(schema.conceptSchedule.conceptId, conceptId))
      .get();

    const card = toCard(existing, now);
    const { card: next } = scheduler().next(card, now, grade);

    const row = {
      conceptId,
      stability: next.stability,
      difficulty: next.difficulty,
      dueDate: toSeconds(next.due),
      reps: next.reps,
      lapses: next.lapses,
      lastReview: toSeconds(now),
      state: next.state as number,
      scheduledDays: next.scheduled_days,
      elapsedDays: next.elapsed_days,
      learningSteps: next.learning_steps,
      confidentlyWrong: (existing?.confidentlyWrong ?? 0) + (confidentlyWrong ? 1 : 0),
      lastGrade: grade as number,
    };

    db.insert(schema.conceptSchedule)
      .values(row)
      .onConflictDoUpdate({ target: schema.conceptSchedule.conceptId, set: row })
      .run();

    outcomes.push({
      conceptId,
      grade,
      dueDate: row.dueDate,
      intervalDays: Math.max(0, (next.due.getTime() - now.getTime()) / 86_400_000),
      stability: next.stability,
      lapsed: next.lapses > (existing?.lapses ?? 0),
      confidentlyWrong,
    });
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// What is due, and how well you know it
// ---------------------------------------------------------------------------

export interface DueConcept {
  conceptId: string;
  sectionId: string;
  statement: string;
  dueDate: number | null;
  /** Never reviewed. Due immediately, but distinguishable from a lapse. */
  isNew: boolean;
  stability: number | null;
  lapses: number;
  confidentlyWrong: number;
}

/**
 * Concepts due for review, soonest first, with never-reviewed ones included.
 *
 * A concept with no schedule row is due: it has never been tested, which is
 * not the same as being known. Sorting puts genuinely overdue material ahead
 * of new material, because forgetting something you had learned is worse than
 * not having started something.
 */
export function dueConcepts(moduleId: string, options: { at?: Date; limit?: number } = {}): DueConcept[] {
  const db = getDb();
  const now = options.at ?? new Date();
  const cutoff = toSeconds(now);

  const sectionIds = flatten(getTree(moduleId)).map((node) => node.id);
  if (sectionIds.length === 0) return [];

  const concepts = db
    .select()
    .from(schema.concepts)
    .where(inArray(schema.concepts.sectionId, sectionIds))
    .all();
  if (concepts.length === 0) return [];

  const schedules = new Map(
    db
      .select()
      .from(schema.conceptSchedule)
      .where(
        inArray(
          schema.conceptSchedule.conceptId,
          concepts.map((concept) => concept.id),
        ),
      )
      .all()
      .map((row) => [row.conceptId, row]),
  );

  const due = concepts
    .map((concept) => {
      const schedule = schedules.get(concept.id);
      return {
        conceptId: concept.id,
        sectionId: concept.sectionId,
        statement: concept.statement,
        dueDate: schedule?.dueDate ?? null,
        isNew: !schedule || schedule.lastReview === null,
        stability: schedule?.stability ?? null,
        lapses: schedule?.lapses ?? 0,
        confidentlyWrong: schedule?.confidentlyWrong ?? 0,
      } satisfies DueConcept;
    })
    .filter((concept) => concept.isNew || (concept.dueDate ?? 0) <= cutoff)
    .sort((a, b) => {
      // Overdue before new, then most overdue first.
      if (a.isNew !== b.isNew) return a.isNew ? 1 : -1;
      return (a.dueDate ?? 0) - (b.dueDate ?? 0);
    });

  return options.limit ? due.slice(0, options.limit) : due;
}

/**
 * How well a concept is known, as a number between 0 and 1.
 *
 * Derived from FSRS stability, which is the model's estimate of how long the
 * memory lasts, mapped through a saturating curve so that the difference
 * between one day and one week is large and the difference between six months
 * and a year is small. That shape is deliberate: it is where the useful
 * revision decisions actually are.
 *
 * The number is a convenience for display and nothing more. A concept with one
 * lucky correct answer will read as partly mastered, which is honest — the
 * system has one piece of evidence — but it is not a claim to be leaned on
 * until several reviews have accumulated. `reviews` is returned alongside for
 * exactly that reason.
 */
export function masteryFromStability(stability: number | null): number {
  if (stability === null || stability <= 0) return 0;
  return stability / (stability + config.schedule.masteryHalfLifeDays);
}

export interface SectionMastery {
  sectionId: string;
  sectionPath: string;
  concepts: number;
  reviewed: number;
  /** Mean mastery across every concept, counting unreviewed ones as zero. */
  mastery: number;
  due: number;
  confidentlyWrong: number;
  /** Rolled up from this section and everything beneath it. */
  subtree: {
    concepts: number;
    reviewed: number;
    mastery: number;
    due: number;
    confidentlyWrong: number;
  };
}

/**
 * Mastery per section, and rolled up the tree.
 *
 * Unreviewed concepts count as zero rather than being left out. Averaging only
 * what has been tested would show a section as 90% mastered when nine of its
 * fifty concepts have ever been seen, which is the most misleading number the
 * system could print.
 */
export function moduleMastery(moduleId: string, options: { at?: Date } = {}): SectionMastery[] {
  const db = getDb();
  const cutoff = toSeconds(options.at ?? new Date());
  const tree = getTree(moduleId);
  const nodes = flatten(tree);
  if (nodes.length === 0) return [];

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

  const schedules = new Map(
    (concepts.length
      ? db
          .select()
          .from(schema.conceptSchedule)
          .where(
            inArray(
              schema.conceptSchedule.conceptId,
              concepts.map((concept) => concept.id),
            ),
          )
          .all()
      : []
    ).map((row) => [row.conceptId, row]),
  );

  // Own totals per section.
  const own = new Map<string, SectionMastery['subtree']>();
  for (const node of nodes) {
    own.set(node.id, { concepts: 0, reviewed: 0, mastery: 0, due: 0, confidentlyWrong: 0 });
  }

  for (const concept of concepts) {
    const entry = own.get(concept.sectionId);
    if (!entry) continue;
    const schedule = schedules.get(concept.id);
    const reviewed = Boolean(schedule && schedule.lastReview !== null);

    entry.concepts += 1;
    if (reviewed) entry.reviewed += 1;
    // Summed here, divided at the end.
    entry.mastery += masteryFromStability(schedule?.stability ?? null);
    if (!reviewed || (schedule?.dueDate ?? 0) <= cutoff) entry.due += 1;
    entry.confidentlyWrong += schedule?.confidentlyWrong ?? 0;
  }

  // Roll up: every node gets its own totals plus those of its descendants.
  const subtree = new Map<string, SectionMastery['subtree']>();
  const accumulate = (nodeId: string, children: ReturnType<typeof getTree>): SectionMastery['subtree'] => {
    const mine = own.get(nodeId)!;
    const total = { ...mine };
    for (const child of children) {
      const beneath = accumulate(child.id, child.children);
      total.concepts += beneath.concepts;
      total.reviewed += beneath.reviewed;
      total.mastery += beneath.mastery;
      total.due += beneath.due;
      total.confidentlyWrong += beneath.confidentlyWrong;
    }
    subtree.set(nodeId, total);
    return total;
  };
  for (const root of tree) accumulate(root.id, root.children);

  return nodes.map((node) => {
    const mine = own.get(node.id)!;
    const beneath = subtree.get(node.id)!;
    return {
      sectionId: node.id,
      sectionPath: `${node.number} ${node.title}`,
      concepts: mine.concepts,
      reviewed: mine.reviewed,
      mastery: mine.concepts ? mine.mastery / mine.concepts : 0,
      due: mine.due,
      confidentlyWrong: mine.confidentlyWrong,
      subtree: {
        ...beneath,
        mastery: beneath.concepts ? beneath.mastery / beneath.concepts : 0,
      },
    };
  });
}

/**
 * The concepts you are confidently wrong about, worst first.
 *
 * Kept as its own view rather than folded into the due list, because the right
 * response is different: a due concept wants another question, and one of
 * these wants you to go and read the section again. Drilling something you
 * believe incorrectly just rehearses the belief.
 */
export interface Misconception {
  conceptId: string;
  sectionId: string;
  sectionPath: string;
  statement: string;
  confidentlyWrong: number;
  lapses: number;
}

export function misconceptions(moduleId: string, limit = 20): Misconception[] {
  const db = getDb();
  const nodes = flatten(getTree(moduleId));
  if (nodes.length === 0) return [];
  const paths = new Map(nodes.map((node) => [node.id, `${node.number} ${node.title}`]));

  const rows = db
    .select({
      conceptId: schema.concepts.id,
      sectionId: schema.concepts.sectionId,
      statement: schema.concepts.statement,
      confidentlyWrong: schema.conceptSchedule.confidentlyWrong,
      lapses: schema.conceptSchedule.lapses,
    })
    .from(schema.conceptSchedule)
    .innerJoin(schema.concepts, eq(schema.concepts.id, schema.conceptSchedule.conceptId))
    .where(
      inArray(
        schema.concepts.sectionId,
        nodes.map((node) => node.id),
      ),
    )
    .all();

  return rows
    .filter((row) => row.confidentlyWrong > 0)
    .sort((a, b) => b.confidentlyWrong - a.confidentlyWrong || b.lapses - a.lapses)
    .slice(0, limit)
    .map((row) => ({ ...row, sectionPath: paths.get(row.sectionId) ?? '' }));
}

/** Everything the revision view needs, in one query the client can poll. */
export function revisionSummary(moduleId: string, options: { at?: Date } = {}) {
  const sections = moduleMastery(moduleId, options);
  const due = dueConcepts(moduleId, options);
  const totals = sections.reduce(
    (sum, section) => ({
      concepts: sum.concepts + section.concepts,
      reviewed: sum.reviewed + section.reviewed,
      mastery: sum.mastery + section.mastery * section.concepts,
    }),
    { concepts: 0, reviewed: 0, mastery: 0 },
  );

  return {
    moduleId,
    sections,
    due: due.length,
    dueNew: due.filter((concept) => concept.isNew).length,
    dueOverdue: due.filter((concept) => !concept.isNew).length,
    concepts: totals.concepts,
    reviewed: totals.reviewed,
    mastery: totals.concepts ? totals.mastery / totals.concepts : 0,
    misconceptions: misconceptions(moduleId),
  };
}

/** Used by the practice route to prefer questions on what is actually due. */
export function dueConceptIds(moduleId: string, at?: Date): Set<string> {
  return new Set(
    dueConcepts(moduleId, at ? { at } : {}).map((concept) => concept.conceptId),
  );
}

/** Exported for the tests, which need to talk about grades by name. */
export { Rating, State };

/** Kept for the scheduled-review query in the routes. */
export function overdueCount(moduleId: string, at?: Date): number {
  const db = getDb();
  const sectionIds = flatten(getTree(moduleId)).map((node) => node.id);
  if (sectionIds.length === 0) return 0;
  const conceptIds = db
    .select({ id: schema.concepts.id })
    .from(schema.concepts)
    .where(inArray(schema.concepts.sectionId, sectionIds))
    .all()
    .map((row) => row.id);
  if (conceptIds.length === 0) return 0;

  return db
    .select()
    .from(schema.conceptSchedule)
    .where(
      and(
        inArray(schema.conceptSchedule.conceptId, conceptIds),
        lte(schema.conceptSchedule.dueDate, toSeconds(at ?? new Date())),
      ),
    )
    .all().length;
}
