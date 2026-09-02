import { eq, inArray } from 'drizzle-orm';
import { config } from '../../config.js';
import { getDb, schema } from '../../db/index.js';
import { indexVector } from '../../db/vectorIndex.js';
import { embedSafely } from '../../embeddings/index.js';
import { newId } from '../../lib/ids.js';
import { toBlob } from '../../lib/vector.js';
import { complete, startRun, type LlmRun } from '../../llm/index.js';
import {
  EXAMINER_SCHEMA,
  EXAMINER_SYSTEM,
  examinerPrompt,
  QUESTION_GENERATION_SCHEMA,
  QUESTION_GENERATION_SYSTEM,
  questionGenerationPrompt,
  type ChunkForPrompt,
} from '../../llm/prompts.js';
import { chunksForSection } from '../concepts.js';
import { flatten, getTree } from '../sections.js';
import {
  ARCHETYPES,
  DISTRACTOR_STRATEGIES,
  blueprintSignature,
  sampleBlueprint,
  usedSignatures,
  type Blueprint,
} from './blueprint.js';
import { balanceAnswerKeys } from './balance.js';
import {
  checkNovelty,
  existingStems,
  nearestStems,
  type NoveltyVerdict,
  type ExistingStem,
} from './novelty.js';

/**
 * The question engine — §7.2 and §7.4.
 *
 * The order matters and is the whole design. A blueprint is sampled in code
 * first, so the shape is decided before the model sees anything. Generation is
 * shown the nearest existing stems and told not to repeat their reasoning. The
 * novelty gate then checks rather than trusts. A second model, deliberately a
 * different one, scores the result against six criteria and rejects it below
 * the floor.
 *
 * Three strikes on one blueprint and the blueprint itself is resampled, since
 * a blueprint that keeps producing near-duplicates is the problem, not the
 * wording. Everything runs inside one LLM run, so the token ceiling applies to
 * the batch rather than resetting per question.
 */

export interface ExaminerScores {
  answerability: number;
  singleAnswer: number;
  distractorQuality: number;
  noGiveaways: number;
  bloomFidelity: number;
  fairness: number;
  verdict: string;
  average: number;
}

export interface RejectedAttempt {
  stem: string;
  reason: NoveltyVerdict['reason'] | 'examiner';
  detail?: string;
  scores?: ExaminerScores;
}

export interface GenerateQuestionsResult {
  moduleId: string;
  requested: number;
  accepted: number;
  /** Every rejection, so a run that produced little can be diagnosed. */
  rejected: RejectedAttempt[];
  blueprintsResampled: number;
  costUsd: number;
  questionIds: string[];
  /**
   * How many questions were admitted on a trigram-only verdict, because the
   * embedder was unavailable. The spike showed trigrams catch copy-paste and
   * almost nothing subtler, so these went through a gate that was barely a
   * gate. Non-zero means the bank needs reading before it is trusted.
   */
  admittedWithoutEmbeddings: number;
  /**
   * Why the run stopped. `asked_for` is the ordinary case; the others all mean
   * fewer questions came back than were requested, and which one it was is the
   * difference between "ask for fewer" and "the material is exhausted".
   */
  stoppedBecause: 'asked_for' | 'ran_out_of_blueprints' | 'cancelled';
}

export interface GenerateQuestionsOptions {
  moduleId: string;
  count: number;
  sectionIds?: string[];
  run?: LlmRun;
  signal?: AbortSignal;
  random?: () => number;
  /** Skip the examiner. Only for the novelty spike, which is about the gate. */
  skipExaminer?: boolean;
  onProgress?: (done: number, total: number, message: string) => void;
}

interface GeneratedQuestion {
  stem: string;
  options?: schema.McqOption[];
  correctAnswer?: string;
  workedAnswer: string;
  markScheme?: string;
  difficulty?: number;
}

export async function generateQuestions(
  options: GenerateQuestionsOptions,
): Promise<GenerateQuestionsResult> {
  const db = getDb();
  const module = db
    .select()
    .from(schema.modules)
    .where(eq(schema.modules.id, options.moduleId))
    .get();
  if (!module) throw new Error('Module not found');

  const tree = flatten(getTree(options.moduleId));
  const sectionPath = new Map(tree.map((node) => [node.id, `${node.number} ${node.title}`]));

  const run =
    options.run ??
    startRun({ label: `Questions for ${module.title}`, moduleId: options.moduleId });

  const existing = existingStems(options.moduleId);
  const signatures = usedSignatures(options.moduleId);

  const result: GenerateQuestionsResult = {
    moduleId: options.moduleId,
    requested: options.count,
    accepted: 0,
    rejected: [],
    blueprintsResampled: 0,
    costUsd: 0,
    questionIds: [],
    admittedWithoutEmbeddings: 0,
    stoppedBecause: 'asked_for',
  };

  const accepted: Array<{ id: string; options: schema.McqOption[] }> = [];

  /**
   * The hard stop on blueprint churn.
   *
   * Every blueprint that fails costs up to `strikesPerBlueprint` model calls,
   * so this number times that is the real ceiling on what one request can
   * spend — for the defaults, twenty-four attempts per question asked for. It
   * exists because a module with three concepts genuinely cannot produce fifty
   * different questions, and without a bound the engine would keep paying to
   * discover that. The token ceiling would eventually stop it, but stopping at
   * a ceiling is a worse answer than stopping when the material runs out.
   */
  const attemptBudget = options.count * config.questions.blueprintAttemptsEach;

  while (result.accepted < options.count) {
    if (result.blueprintsResampled >= attemptBudget) {
      result.stoppedBecause = 'ran_out_of_blueprints';
      break;
    }

    const sampled = sampleBlueprint({
      moduleId: options.moduleId,
      ...(options.sectionIds ? { sectionIds: options.sectionIds } : {}),
      ...(options.random ? { random: options.random } : {}),
    });
    if (!sampled) {
      throw new Error(
        'No concepts to build questions from. Extract concepts for this module first — ' +
          'questions are sampled from the concept list, not from the notes.',
      );
    }

    const signature = blueprintSignature(sampled.blueprint);
    if (signatures.has(signature)) {
      // A blueprint already used is not worth a model call at all.
      result.blueprintsResampled += 1;
      continue;
    }

    let struck = 0;
    let stored = false;
    const avoidExtra: string[] = [];

    while (struck < config.questions.strikesPerBlueprint && !stored) {
      if (options.signal?.aborted) {
        result.stoppedBecause = 'cancelled';
        result.costUsd = run.costUsd;
        return result;
      }

      const context = contextFor(sampled.blueprint, sectionPath);
      if (context.chunks.length === 0) {
        // Nothing to be answerable from, so nothing honest to ask.
        result.rejected.push({
          stem: '',
          reason: 'empty',
          detail: 'the concepts behind this blueprint have no source material mapped',
        });
        break;
      }

      const [probe] = await embedSafely([
        sampled.blueprint.conceptIds.join(' ') + context.conceptStatements.join(' '),
      ]);

      const response = await complete({
        task: 'question_generation',
        system: QUESTION_GENERATION_SYSTEM,
        prompt: questionGenerationPrompt({
          moduleTitle: module.title,
          concepts: context.concepts,
          chunks: context.chunks,
          archetype: sampled.blueprint.archetype,
          archetypeDescription: ARCHETYPES[sampled.blueprint.archetype],
          format: sampled.blueprint.format,
          bloom: sampled.blueprint.bloom,
          distractors: sampled.blueprint.distractors.map(
            (strategy) => DISTRACTOR_STRATEGIES[strategy],
          ),
          scenario: sampled.blueprint.scenario,
          constraint: sampled.blueprint.constraint,
          figureCaption: context.figureCaption,
          avoid: [...nearestStems(probe ?? null, existing), ...avoidExtra],
        }),
        jsonSchema: QUESTION_GENERATION_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 3000,
        moduleId: options.moduleId,
        run,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      const question = (response.json ?? {}) as GeneratedQuestion;
      const stem = (question.stem ?? '').trim();

      const [stemVector] = await embedSafely([stem]);
      const verdict = checkNovelty({
        stem,
        embedding: stemVector ?? null,
        signature,
        existing,
        usedSignatures: signatures,
      });

      if (!verdict.accepted) {
        struck += 1;
        if (stem) avoidExtra.push(stem);
        result.rejected.push({
          stem,
          reason: verdict.reason!,
          ...(verdict.nearest
            ? { detail: `closest: "${truncate(verdict.nearest.stem)}" at ${verdict.nearest.score.toFixed(2)}` }
            : {}),
        });
        continue;
      }

      // --- the examiner, §7.4 ------------------------------------------------
      let scores: ExaminerScores | null = null;
      if (!options.skipExaminer) {
        scores = await examine({
          question,
          blueprint: sampled.blueprint,
          chunks: context.chunks,
          moduleId: options.moduleId,
          run,
          ...(options.signal ? { signal: options.signal } : {}),
        });

        if (scores.average < config.questions.examinerFloor) {
          struck += 1;
          avoidExtra.push(stem);
          result.rejected.push({ stem, reason: 'examiner', detail: scores.verdict, scores });
          continue;
        }
      }

      const id = store({
        moduleId: options.moduleId,
        blueprint: sampled.blueprint,
        question,
        stem,
        embedding: stemVector ?? null,
        scores,
      });

      existing.push({
        id,
        stem,
        embedding: stemVector ?? null,
        source: 'generated',
      } satisfies ExistingStem);
      signatures.add(signature);
      result.accepted += 1;
      if (!verdict.embeddingsUsed) result.admittedWithoutEmbeddings += 1;
      result.questionIds.push(id);
      if (question.options?.length) accepted.push({ id, options: question.options });
      stored = true;

      options.onProgress?.(result.accepted, options.count, stem);
    }

    if (!stored) result.blueprintsResampled += 1;
  }

  // §7.5, on the assembled set rather than per question.
  if (accepted.length > 0) {
    balanceAnswerKeys(accepted, options.random ?? Math.random);
    for (const entry of accepted) {
      db.update(schema.questions)
        .set({ optionsJson: entry.options })
        .where(eq(schema.questions.id, entry.id))
        .run();
    }
  }

  result.costUsd = run.costUsd;
  return result;
}

interface Context {
  concepts: Array<{ statement: string; sectionPath: string }>;
  conceptStatements: string[];
  chunks: ChunkForPrompt[];
  figureCaption: string | null;
}

function contextFor(blueprint: Blueprint, sectionPath: Map<string, string>): Context {
  const db = getDb();
  const concepts = db
    .select()
    .from(schema.concepts)
    .where(inArray(schema.concepts.id, blueprint.conceptIds))
    .all();

  // Only the chunks the concepts actually cite: a question must be answerable
  // from its own sources, and handing over the whole section invites one that
  // is answerable from material the concept never covered.
  const citedIds = new Set(concepts.flatMap((concept) => concept.sourceChunkIds ?? []));
  const chunks = blueprint.sectionIds
    .flatMap((sectionId) => chunksForSection(sectionId))
    .filter((chunk) => citedIds.has(chunk.id));

  const figure = blueprint.figureId
    ? db.select().from(schema.figures).where(eq(schema.figures.id, blueprint.figureId)).get()
    : undefined;

  return {
    concepts: concepts.map((concept) => ({
      statement: concept.statement,
      sectionPath: sectionPath.get(concept.sectionId) ?? '',
    })),
    conceptStatements: concepts.map((concept) => concept.statement),
    chunks,
    figureCaption: figure?.captionExtracted ?? figure?.captionAi ?? null,
  };
}

async function examine(input: {
  question: GeneratedQuestion;
  blueprint: Blueprint;
  chunks: ChunkForPrompt[];
  moduleId: string;
  run: LlmRun;
  signal?: AbortSignal;
}): Promise<ExaminerScores> {
  const response = await complete({
    task: 'examiner',
    system: EXAMINER_SYSTEM,
    prompt: examinerPrompt({
      stem: input.question.stem,
      options: input.question.options ?? [],
      correctAnswer: input.question.correctAnswer ?? null,
      workedAnswer: input.question.workedAnswer ?? '',
      bloom: input.blueprint.bloom,
      chunks: input.chunks,
    }),
    jsonSchema: EXAMINER_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1200,
    moduleId: input.moduleId,
    run: input.run,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const raw = (response.json ?? {}) as Partial<ExaminerScores>;
  const criteria = [
    raw.answerability,
    raw.singleAnswer,
    raw.distractorQuality,
    raw.noGiveaways,
    raw.bloomFidelity,
    raw.fairness,
  ].map((score) => clamp(score));

  return {
    answerability: criteria[0]!,
    singleAnswer: criteria[1]!,
    distractorQuality: criteria[2]!,
    noGiveaways: criteria[3]!,
    bloomFidelity: criteria[4]!,
    fairness: criteria[5]!,
    verdict: raw.verdict ?? '',
    average: criteria.reduce((sum, score) => sum + score, 0) / criteria.length,
  };
}

/** A missing score is treated as the worst, not as a pass. */
function clamp(score: unknown): number {
  const value = Number(score);
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(1, value));
}

function store(input: {
  moduleId: string;
  blueprint: Blueprint;
  question: GeneratedQuestion;
  stem: string;
  embedding: Float32Array | null;
  scores: ExaminerScores | null;
}): string {
  const db = getDb();
  const id = newId();

  db.insert(schema.questions)
    .values({
      id,
      moduleId: input.moduleId,
      blueprintJson: input.blueprint as unknown as Record<string, unknown>,
      conceptIds: input.blueprint.conceptIds,
      sectionIds: input.blueprint.sectionIds,
      format: input.blueprint.format,
      stem: input.stem,
      optionsJson: input.question.options ?? null,
      correctAnswer: input.question.correctAnswer ?? null,
      workedAnswer: input.question.workedAnswer ?? null,
      markScheme: input.question.markScheme ?? null,
      figureId: input.blueprint.figureId,
      bloomLevel: input.blueprint.bloom,
      difficultyEst: input.question.difficulty ?? null,
      embedding: input.embedding ? toBlob(input.embedding) : null,
      source: 'generated',
      criticScore: input.scores?.average ?? null,
    })
    .run();

  if (input.embedding) indexVector('question', id, input.embedding);
  return id;
}

function truncate(text: string, length = 90): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
