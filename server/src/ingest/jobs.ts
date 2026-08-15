import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { ingestSource, type IngestResult } from './index.js';

/**
 * Ingestion runs as a background job rather than inside the HTTP request.
 *
 * A textbook takes minutes to parse. Doing that in the request handler meant
 * the browser sat on a hanging POST while every other call queued behind it —
 * so notes would not load or save, and the whole app looked frozen. Now the
 * upload returns immediately and the page follows the job's progress.
 *
 * The registry is in memory, which is the right trade for a single-user local
 * app: no extra moving parts, and a server restart is handled by
 * `resetInterruptedIngests` below rather than by a queue.
 */

export type IngestPhase =
  | 'queued'
  | 'parsing'
  | 'embedding'
  | 'mapping'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface IngestJob {
  sourceId: string;
  phase: IngestPhase;
  /** Units completed and expected within the current phase. */
  done: number;
  total: number;
  message: string;
  startedAt: number;
  finishedAt?: number;
  result?: IngestResult;
  error?: string;
}

const jobs = new Map<string, IngestJob>();
/** One controller per running job, so a cancel can reach into the pipeline. */
const controllers = new Map<string, AbortController>();

export function getJob(sourceId: string): IngestJob | undefined {
  return jobs.get(sourceId);
}

const FINISHED: IngestPhase[] = ['done', 'failed', 'cancelled'];

export function isRunning(sourceId: string): boolean {
  const job = jobs.get(sourceId);
  return job !== undefined && !FINISHED.includes(job.phase);
}

/**
 * Ask a running ingest to stop. It halts at the next page or embedding batch,
 * and whatever it had written so far is discarded — a half-read document is
 * worse than none, because later phases cannot tell it is incomplete.
 */
export function cancelIngest(sourceId: string): boolean {
  const controller = controllers.get(sourceId);
  if (!controller || !isRunning(sourceId)) return false;
  controller.abort();
  const job = jobs.get(sourceId);
  if (job) job.message = 'Cancelling…';
  return true;
}

/**
 * Begin ingesting, or return the job already in flight. Never starts a second
 * pass over the same source: re-ingesting concurrently would have two writers
 * deleting and inserting the same chunks.
 */
export function startIngest(sourceId: string): IngestJob {
  const existing = jobs.get(sourceId);
  if (existing && isRunning(sourceId)) return existing;

  const job: IngestJob = {
    sourceId,
    phase: 'queued',
    done: 0,
    total: 0,
    message: 'Waiting to start',
    startedAt: Date.now(),
  };
  jobs.set(sourceId, job);
  controllers.set(sourceId, new AbortController());

  // Deliberately not awaited: the caller responds straight away.
  void run(job);
  return job;
}

async function run(job: IngestJob): Promise<void> {
  try {
    const result = await ingestSource(
      job.sourceId,
      (phase, done, total) => {
        job.phase = phase;
        job.done = done;
        job.total = total;
        job.message = describe(phase, done, total);
      },
      controllers.get(job.sourceId)?.signal,
    );

    job.phase = 'done';
    job.result = result;
    job.done = job.total;
    job.finishedAt = Date.now();
    job.message = `${result.chunks} chunks, ${result.figures} figures`;
  } catch (error) {
    const cancelled =
      (error as Error)?.name === 'IngestCancelled' || (error as Error)?.name === 'AbortError';
    job.phase = cancelled ? 'cancelled' : 'failed';
    job.finishedAt = Date.now();
    job.message = cancelled ? 'Cancelled' : 'Ingestion failed';
    if (!cancelled) job.error = (error as Error).message;
  } finally {
    controllers.delete(job.sourceId);
  }
}

function describe(phase: IngestPhase, done: number, total: number): string {
  switch (phase) {
    case 'parsing':
      return `Reading page ${done} of ${total}`;
    case 'embedding':
      return `Indexing ${done} of ${total} passages`;
    case 'mapping':
      return 'Matching to sections';
    default:
      return 'Working';
  }
}

/**
 * A source left mid-ingest by a crash or a restart would otherwise sit on
 * "ingesting" for ever, with no job behind it to finish the work. Mark those
 * clearly so they can simply be re-ingested.
 */
export function resetInterruptedIngests(): number {
  const db = getDb();
  const stuck = db
    .select({ id: schema.sources.id })
    .from(schema.sources)
    .where(eq(schema.sources.status, 'ingesting'))
    .all();

  if (stuck.length === 0) return 0;

  db.update(schema.sources)
    .set({
      status: 'failed',
      error: 'Ingestion was interrupted when the server stopped. Re-ingest to try again.',
    })
    .where(
      inArray(
        schema.sources.id,
        stuck.map((row) => row.id),
      ),
    )
    .run();

  return stuck.length;
}
