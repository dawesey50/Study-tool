import { startRun, type LlmRun } from '../../llm/index.js';
import { generateQuestions, type GenerateQuestionsResult } from './generate.js';

/**
 * Question generation runs in the background.
 *
 * Note generation stays in the request because one section is a handful of
 * calls. A batch of thirty questions is thirty generation calls plus thirty
 * examiner calls plus every rejected attempt — minutes, not seconds — and
 * holding the request open for that makes the whole app look frozen.
 *
 * As with concept extraction, the run handle is shared across the whole batch,
 * so the per-run token ceiling applies to the job rather than resetting per
 * question. A batch that goes wrong on question one should not be allowed to
 * go wrong twenty-nine more times.
 */

export type QuestionPhase = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled';

export interface QuestionJob {
  moduleId: string;
  phase: QuestionPhase;
  done: number;
  total: number;
  message: string;
  startedAt: number;
  finishedAt?: number;
  result?: GenerateQuestionsResult;
  costGbp?: number;
  error?: string;
}

const jobs = new Map<string, QuestionJob>();
const controllers = new Map<string, AbortController>();
const FINISHED: QuestionPhase[] = ['done', 'failed', 'cancelled'];

export function getQuestionJob(moduleId: string): QuestionJob | undefined {
  return jobs.get(moduleId);
}

export function isGenerating(moduleId: string): boolean {
  const job = jobs.get(moduleId);
  return job !== undefined && !FINISHED.includes(job.phase);
}

export function cancelGeneration(moduleId: string): boolean {
  const controller = controllers.get(moduleId);
  if (!controller || !isGenerating(moduleId)) return false;
  controller.abort();
  const job = jobs.get(moduleId);
  if (job) job.message = 'Cancelling…';
  return true;
}

export interface StartGenerationOptions {
  moduleId: string;
  count: number;
  sectionIds?: string[];
  skipExaminer?: boolean;
}

export function startGeneration(options: StartGenerationOptions): QuestionJob {
  const existing = jobs.get(options.moduleId);
  if (existing && isGenerating(options.moduleId)) return existing;

  const job: QuestionJob = {
    moduleId: options.moduleId,
    phase: 'queued',
    done: 0,
    total: options.count,
    message: 'Queued',
    startedAt: Date.now(),
  };
  jobs.set(options.moduleId, job);

  const controller = new AbortController();
  controllers.set(options.moduleId, controller);

  void run(job, options, controller).finally(() => controllers.delete(options.moduleId));
  return job;
}

async function run(
  job: QuestionJob,
  options: StartGenerationOptions,
  controller: AbortController,
): Promise<void> {
  try {
    job.phase = 'generating';
    job.message = 'Sampling blueprints';

    const llmRun: LlmRun = startRun({
      label: 'Question generation',
      moduleId: options.moduleId,
    });

    const result = await generateQuestions({
      moduleId: options.moduleId,
      count: options.count,
      run: llmRun,
      signal: controller.signal,
      ...(options.sectionIds?.length ? { sectionIds: options.sectionIds } : {}),
      ...(options.skipExaminer ? { skipExaminer: true } : {}),
      onProgress: (done, total, stem) => {
        job.done = done;
        job.total = total;
        job.message = stem;
      },
    });

    job.result = result;
    job.done = result.accepted;
    job.costGbp = result.costUsd * usdToGbpRate();
    job.phase = result.stoppedBecause === 'cancelled' ? 'cancelled' : 'done';
    job.message = summarise(result);
    job.finishedAt = Date.now();
  } catch (error) {
    job.phase = 'failed';
    job.error = (error as Error).message;
    job.message = job.error;
    job.finishedAt = Date.now();
  }
}

function usdToGbpRate(): number {
  // Read lazily for the same reason as in conceptJobs: tests set environment
  // variables before importing, and a config read at load time would miss them.
  return Number(process.env.USD_TO_GBP ?? 0.79);
}

/**
 * What the job says when it finishes.
 *
 * A short run is the interesting case and the message has to distinguish its
 * two causes, because they call for opposite responses: giving up means the
 * material is exhausted and asking again will not help, while a full run that
 * simply produced fewer means the gate was busy.
 */
function summarise(result: GenerateQuestionsResult): string {
  const parts = [`${result.accepted} of ${result.requested} questions`];

  if (result.stoppedBecause === 'ran_out_of_blueprints') {
    parts.push('gave up — this material may not hold that many different questions');
  }
  if (result.rejected.length) parts.push(`${result.rejected.length} rejected`);
  if (result.admittedWithoutEmbeddings > 0) {
    parts.push(
      `${result.admittedWithoutEmbeddings} passed on wording alone (the embedder was unavailable)`,
    );
  }
  return parts.join(' · ');
}
