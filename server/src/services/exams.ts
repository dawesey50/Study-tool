import { desc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { flatten, getTree } from './sections.js';
import { recordReview } from './schedule.js';

/**
 * Timed exams — §9.
 *
 * WHY THIS IS NOT JUST PRACTICE WITH A CLOCK
 *
 * Practice is one question at a time, answered and revealed immediately, which
 * is the right shape for learning and the wrong shape for finding out whether
 * you can sit the paper. Three things differ here and each one is the point:
 *
 * The whole paper is drawn up front and fixed. You can look ahead, skip, come
 * back, and change your mind — which is what you do in an exam and which
 * question-at-a-time practice makes impossible.
 *
 * Nothing is marked until you submit. Immediate feedback is what makes
 * practice useful and it is also what stops it measuring anything: knowing you
 * got question three right changes how you answer question four.
 *
 * Real past-paper questions are included by preference. A mock built only from
 * generated questions measures how well you do on this system's questions. The
 * ones that actually came up are the closest thing to evidence available, so
 * they go in first and the generated ones fill the rest.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not mark written answers. Every past-paper question and most
 * generated ones are prose, and marking prose needs a model and a mark scheme
 * — past papers have neither. So a submitted paper reports a score over the
 * multiple-choice questions it could mark, says plainly how many it could not,
 * and leaves those for you to mark yourself. Reporting a percentage that
 * quietly ignored two thirds of the paper would be worse than reporting none.
 */

export interface ExamBlueprint {
  /** Sections the paper draws from. Empty means the whole module. */
  sectionIds: string[];
  questionCount: number;
  minutes: number;
  /** Share of the paper that should be real past-paper questions, 0–1. */
  pastPaperShare: number;
}

export interface ExamQuestionView {
  id: string;
  format: schema.QuestionFormat;
  stem: string;
  /** Option text only. Which is correct is withheld until submission. */
  options: string[];
  marks: number | null;
  source: 'generated' | 'past_paper';
  sectionPaths: string[];
  figure: { url: string; caption: string | null } | null;
}

export interface ExamView {
  id: string;
  moduleId: string;
  title: string;
  blueprint: ExamBlueprint;
  startedAt: number | null;
  submittedAt: number | null;
  score: number | null;
  questions: ExamQuestionView[];
}

const DEFAULTS: ExamBlueprint = {
  sectionIds: [],
  questionCount: 15,
  minutes: 45,
  pastPaperShare: 0.4,
};

export interface CreateExamOptions {
  moduleId: string;
  title?: string;
  blueprint?: Partial<ExamBlueprint>;
  random?: () => number;
}

export function createExam(options: CreateExamOptions): ExamView {
  const db = getDb();
  const random = options.random ?? Math.random;

  const blueprint: ExamBlueprint = { ...DEFAULTS, ...options.blueprint };

  const sectionIds = blueprint.sectionIds.length
    ? blueprint.sectionIds
    : flatten(getTree(options.moduleId)).map((node) => node.id);

  const pool = db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.moduleId, options.moduleId))
    .all()
    .filter(
      (question) =>
        sectionIds.length === 0 ||
        (question.sectionIds ?? []).some((id) => sectionIds.includes(id)) ||
        // A past-paper question that never matched a concept has no section,
        // and excluding it would drop the most valuable questions in the bank
        // from every section-scoped paper.
        (question.source === 'past_paper' && (question.sectionIds ?? []).length === 0),
    );

  if (pool.length === 0) {
    throw new Error(
      'No questions to build a paper from. Generate some in the question bank, or extract ' +
        'them from a past paper, first.',
    );
  }

  const papers = shuffle(pool.filter((question) => question.source === 'past_paper'), random);
  const generated = shuffle(pool.filter((question) => question.source === 'generated'), random);

  // Real questions first, up to their share, then generated ones fill the
  // rest — and if there are not enough of one, the other makes up the
  // difference rather than the paper coming up short.
  const wantedPapers = Math.round(blueprint.questionCount * blueprint.pastPaperShare);
  const chosen = [
    ...papers.slice(0, wantedPapers),
    ...generated.slice(0, blueprint.questionCount - Math.min(wantedPapers, papers.length)),
  ];
  if (chosen.length < blueprint.questionCount) {
    const already = new Set(chosen.map((question) => question.id));
    for (const question of [...papers, ...generated]) {
      if (chosen.length >= blueprint.questionCount) break;
      if (!already.has(question.id)) chosen.push(question);
    }
  }

  const ordered = shuffle(chosen, random);

  const id = newId();
  db.insert(schema.exams)
    .values({
      id,
      moduleId: options.moduleId,
      title: options.title?.trim() || defaultTitle(),
      blueprintJson: blueprint as unknown as Record<string, unknown>,
      questionIds: ordered.map((question) => question.id),
      startedAt: null,
      submittedAt: null,
      score: null,
    })
    .run();

  return getExam(id)!;
}

export function getExam(examId: string): ExamView | null {
  const db = getDb();
  const exam = db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam) return null;

  const questionIds = exam.questionIds ?? [];
  const questions = questionIds.length
    ? db.select().from(schema.questions).where(inArray(schema.questions.id, questionIds)).all()
    : [];

  // The stored order is the paper's order and must survive the round trip: a
  // paper that reshuffles itself between loads is a different paper.
  const byId = new Map(questions.map((question) => [question.id, question]));
  const paths = new Map(
    flatten(getTree(exam.moduleId)).map((node) => [node.id, `${node.number} ${node.title}`]),
  );

  const figures = new Map(
    questions
      .map((question) => question.figureId)
      .filter((figureId): figureId is string => Boolean(figureId))
      .map((figureId) => {
        const figure = db
          .select()
          .from(schema.figures)
          .where(eq(schema.figures.id, figureId))
          .get();
        return [
          figureId,
          figure
            ? {
                url: `/media/${figure.path.replace(/^media\//, '')}`,
                caption: figure.captionExtracted ?? figure.captionAi ?? null,
              }
            : null,
        ] as const;
      }),
  );

  return {
    id: exam.id,
    moduleId: exam.moduleId,
    title: exam.title,
    blueprint: (exam.blueprintJson ?? DEFAULTS) as unknown as ExamBlueprint,
    startedAt: exam.startedAt,
    submittedAt: exam.submittedAt,
    score: exam.score,
    questions: questionIds
      .map((questionId) => byId.get(questionId))
      .filter((question): question is NonNullable<typeof question> => Boolean(question))
      .map((question) => {
        const blueprint = (question.blueprintJson ?? {}) as { marks?: number };
        return {
          id: question.id,
          format: question.format,
          stem: question.stem,
          // Nothing about the answer crosses the wire until submission. That
          // is the same rule practice follows, and it matters more here.
          options: (question.optionsJson ?? []).map((option) => option.text),
          marks: blueprint.marks ?? null,
          source: question.source,
          sectionPaths: (question.sectionIds ?? []).map((id) => paths.get(id) ?? ''),
          figure: question.figureId ? (figures.get(question.figureId) ?? null) : null,
        };
      }),
  };
}

export function startExam(examId: string): ExamView | null {
  const db = getDb();
  const exam = db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam) return null;
  if (exam.startedAt === null) {
    db.update(schema.exams)
      .set({ startedAt: Math.floor(Date.now() / 1000) })
      .where(eq(schema.exams.id, examId))
      .run();
  }
  return getExam(examId);
}

export interface SubmittedAnswer {
  questionId: string;
  optionIndex?: number;
  text?: string;
  confidence?: number;
}

export interface MarkedQuestion {
  questionId: string;
  stem: string;
  format: schema.QuestionFormat;
  source: 'generated' | 'past_paper';
  answered: boolean;
  /** Null when it could not be marked here — every written answer. */
  correct: boolean | null;
  correctIndex: number | null;
  options: schema.McqOption[] | null;
  yourAnswer: string | null;
  workedAnswer: string | null;
  markScheme: string | null;
  attemptId: string;
  confidentlyWrong: boolean;
}

export interface ExamResult {
  examId: string;
  title: string;
  submittedAt: number;
  secondsTaken: number | null;
  /** Over the questions that could be marked automatically. */
  score: number | null;
  marked: number;
  correct: number;
  /** Written answers, which need marking by hand. */
  unmarked: number;
  unanswered: number;
  confidentlyWrong: number;
  questions: MarkedQuestion[];
}

/**
 * Mark and close a paper.
 *
 * Attempts are recorded here rather than as you go, which is the whole
 * difference between a mock and practice — and it means the scheduler learns
 * from an exam exactly as it does from practice, since a question answered
 * under time pressure is at least as good evidence as one answered at leisure.
 */
export function submitExam(examId: string, answers: SubmittedAnswer[]): ExamResult | null {
  const db = getDb();
  const exam = db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam) return null;
  if (exam.submittedAt !== null) {
    throw new Error('That paper has already been submitted.');
  }

  const submittedAt = Math.floor(Date.now() / 1000);
  const given = new Map(answers.map((answer) => [answer.questionId, answer]));
  const questionIds = exam.questionIds ?? [];

  const questions = questionIds.length
    ? db.select().from(schema.questions).where(inArray(schema.questions.id, questionIds)).all()
    : [];
  const byId = new Map(questions.map((question) => [question.id, question]));

  const marked: MarkedQuestion[] = [];
  let correctCount = 0;
  let markedCount = 0;
  let unmarkedCount = 0;
  let unanswered = 0;
  let confidentlyWrongCount = 0;

  for (const questionId of questionIds) {
    const question = byId.get(questionId);
    if (!question) continue;

    const answer = given.get(questionId);
    const options = question.optionsJson ?? [];
    const isMcq = options.length > 0;
    const answered = Boolean(answer && (answer.optionIndex !== undefined || answer.text?.trim()));

    if (!answered) unanswered += 1;

    const correct =
      isMcq && answered
        ? options[answer!.optionIndex ?? -1]?.correct === true
        : isMcq && !answered
          ? false
          : null;

    if (correct === null) unmarkedCount += 1;
    else {
      markedCount += 1;
      if (correct) correctCount += 1;
    }

    const confidentlyWrong = correct === false && (answer?.confidence ?? 0) >= 4;
    if (confidentlyWrong) confidentlyWrongCount += 1;

    const attemptId = newId();
    db.insert(schema.attempts)
      .values({
        id: attemptId,
        questionId,
        answerGiven: isMcq ? String(answer?.optionIndex ?? '') : (answer?.text ?? null),
        correct,
        confidenceRating: answer?.confidence ?? null,
        secondsTaken: null,
        attemptedAt: submittedAt,
      })
      .run();

    db.update(schema.questions)
      .set({
        timesServed: question.timesServed + 1,
        timesCorrect: question.timesCorrect + (correct === true ? 1 : 0),
      })
      .where(eq(schema.questions.id, questionId))
      .run();

    // Same rule as practice: only a marked answer is evidence. An unmarked
    // written answer schedules nothing until it is marked by hand.
    if (correct !== null) {
      recordReview({
        conceptIds: question.conceptIds ?? [],
        correct,
        confidence: answer?.confidence ?? null,
      });
    }

    marked.push({
      questionId,
      stem: question.stem,
      format: question.format,
      source: question.source,
      answered,
      correct,
      correctIndex: isMcq ? options.findIndex((option) => option.correct) : null,
      options: isMcq ? options : null,
      yourAnswer: isMcq ? (options[answer?.optionIndex ?? -1]?.text ?? null) : (answer?.text ?? null),
      workedAnswer: question.workedAnswer,
      markScheme: question.markScheme,
      attemptId,
      confidentlyWrong,
    });
  }

  // Over what could be marked, and null when nothing could. A percentage that
  // quietly ignored two thirds of the paper would be worse than no percentage.
  const score = markedCount > 0 ? correctCount / markedCount : null;

  db.update(schema.exams)
    .set({ submittedAt, score })
    .where(eq(schema.exams.id, examId))
    .run();

  return {
    examId,
    title: exam.title,
    submittedAt,
    secondsTaken: exam.startedAt !== null ? submittedAt - exam.startedAt : null,
    score,
    marked: markedCount,
    correct: correctCount,
    unmarked: unmarkedCount,
    unanswered,
    confidentlyWrong: confidentlyWrongCount,
    questions: marked,
  };
}

export function listExams(moduleId: string) {
  return getDb()
    .select()
    .from(schema.exams)
    .where(eq(schema.exams.moduleId, moduleId))
    .orderBy(desc(schema.exams.startedAt))
    .all()
    .map((exam) => ({
      id: exam.id,
      title: exam.title,
      questionCount: (exam.questionIds ?? []).length,
      startedAt: exam.startedAt,
      submittedAt: exam.submittedAt,
      score: exam.score,
      minutes: ((exam.blueprintJson ?? {}) as { minutes?: number }).minutes ?? DEFAULTS.minutes,
    }));
}

export function deleteExam(examId: string): boolean {
  const db = getDb();
  const exam = db.select().from(schema.exams).where(eq(schema.exams.id, examId)).get();
  if (!exam) return false;
  db.delete(schema.exams).where(eq(schema.exams.id, examId)).run();
  return true;
}

function defaultTitle(): string {
  const now = new Date();
  return `Mock paper — ${now.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })}`;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
