import { getDb, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { startRun, type LlmRun } from '../llm/index.js';
import { flatten, getTree } from './sections.js';
import { assignOwnership, extractConcepts, type ExtractionResult } from './concepts.js';

/**
 * Extraction across a module runs in the background, for the same reason
 * ingestion does: twenty sections is twenty model calls, and holding the
 * request open makes the whole app look frozen while every other call queues
 * behind it.
 *
 * The run handle is shared across every section, so the per-run token ceiling
 * applies to the job as a whole rather than resetting each section — a run
 * that goes wrong on section one should not be allowed to go wrong twenty more
 * times.
 */

export type ConceptPhase = 'queued' | 'extracting' | 'linking' | 'done' | 'failed' | 'cancelled';

export interface ConceptJob {
  moduleId: string;
  phase: ConceptPhase;
  done: number;
  total: number;
  message: string;
  startedAt: number;
  finishedAt?: number;
  results: ExtractionResult[];
  /** Sections that could not be extracted, and why. Never fails the whole run. */
  skipped: Array<{ sectionId: string; sectionPath: string; reason: string }>;
  links?: number;
  costGbp?: number;
  error?: string;
}

const jobs = new Map<string, ConceptJob>();
const controllers = new Map<string, AbortController>();
const FINISHED: ConceptPhase[] = ['done', 'failed', 'cancelled'];

export function getConceptJob(moduleId: string): ConceptJob | undefined {
  return jobs.get(moduleId);
}

export function isExtracting(moduleId: string): boolean {
  const job = jobs.get(moduleId);
  return job !== undefined && !FINISHED.includes(job.phase);
}

export function cancelExtraction(moduleId: string): boolean {
  const controller = controllers.get(moduleId);
  if (!controller || !isExtracting(moduleId)) return false;
  controller.abort();
  const job = jobs.get(moduleId);
  if (job) job.message = 'Cancelling…';
  return true;
}

export interface StartExtractionOptions {
  moduleId: string;
  /** Limit the run to these sections. Omitted means every section with material. */
  sectionIds?: string[];
  fresh?: boolean;
}

export function startExtraction(options: StartExtractionOptions): ConceptJob {
  const existing = jobs.get(options.moduleId);
  if (existing && isExtracting(options.moduleId)) return existing;

  const job: ConceptJob = {
    moduleId: options.moduleId,
    phase: 'queued',
    done: 0,
    total: 0,
    message: 'Queued',
    startedAt: Date.now(),
    results: [],
    skipped: [],
  };
  jobs.set(options.moduleId, job);

  const controller = new AbortController();
  controllers.set(options.moduleId, controller);

  void run(job, options, controller).finally(() => controllers.delete(options.moduleId));
  return job;
}

async function run(
  job: ConceptJob,
  options: StartExtractionOptions,
  controller: AbortController,
): Promise<void> {
  const db = getDb();
  try {
    const tree = flatten(getTree(options.moduleId));
    const wanted = options.sectionIds?.length
      ? tree.filter((node) => options.sectionIds!.includes(node.id))
      : tree;

    job.total = wanted.length;
    job.phase = 'extracting';

    const llmRun: LlmRun = startRun({
      label: `Concept extraction`,
      moduleId: options.moduleId,
    });

    for (const node of wanted) {
      if (controller.signal.aborted) {
        job.phase = 'cancelled';
        job.message = 'Cancelled';
        job.finishedAt = Date.now();
        return;
      }

      job.message = `${node.number} ${node.title}`;
      try {
        const result = await extractConcepts({
          sectionId: node.id,
          run: llmRun,
          signal: controller.signal,
          ...(options.fresh ? { fresh: true } : {}),
        });
        job.results.push(result);
      } catch (error) {
        // A section with no material mapped to it is the normal case, not a
        // failure — skipping it and saying so beats aborting the other
        // nineteen. A cap being hit is different: it stops everything.
        const message = (error as Error).message;
        if (isFatal(error)) throw error;
        job.skipped.push({
          sectionId: node.id,
          sectionPath: `${node.number} ${node.title}`,
          reason: message,
        });
      }
      job.done += 1;
    }

    job.phase = 'linking';
    job.message = 'Matching concepts across the module';
    const ownership = await assignOwnership(options.moduleId);
    job.links = ownership.links;

    job.costGbp = llmRun.costUsd * usdToGbpRate();
    job.phase = 'done';
    job.message = summarise(job);
    job.finishedAt = Date.now();
  } catch (error) {
    job.phase = 'failed';
    job.error = (error as Error).message;
    job.message = job.error;
    job.finishedAt = Date.now();
  } finally {
    // Section status reflects what actually happened, so the tree shows it.
    for (const result of job.results) {
      if (result.kept === 0) continue;
      db.update(schema.sections)
        .set({ status: 'drafted' })
        .where(eq(schema.sections.id, result.sectionId))
        .run();
    }
  }
}

/** A spending limit or a refusal stops the whole run; anything else is skipped. */
function isFatal(error: unknown): boolean {
  const name = (error as Error)?.name ?? '';
  return (
    name === 'RunCeilingError' ||
    name === 'MonthlyCapError' ||
    name === 'IterationLimitError' ||
    name === 'LlmNotConfiguredError' ||
    name === 'LlmRefusedError' ||
    name === 'AbortError'
  );
}

function usdToGbpRate(): number {
  // Imported lazily to keep this module free of config at load time, which
  // matters because the tests set environment variables before importing.
  return Number(process.env.USD_TO_GBP ?? 0.79);
}

function summarise(job: ConceptJob): string {
  const concepts = job.results.reduce((total, result) => total + result.kept, 0);
  const parts = [`${concepts} concepts across ${job.results.length} sections`];
  if (job.links) parts.push(`${job.links} cross-section matches`);
  if (job.skipped.length) parts.push(`${job.skipped.length} skipped`);
  return parts.join(' · ');
}
