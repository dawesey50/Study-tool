import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { usdToGbp } from './pricing.js';
import type { LlmUsage } from './types.js';

/**
 * The brakes.
 *
 * Accounting tells you what a run cost after it finished. That is no use
 * against the failure this exists for: a coverage pass that never converges,
 * regenerating one section forty times overnight. Three limits, each stopping
 * a different runaway:
 *
 *   - a per-run token ceiling, so one unit of work cannot grow without bound;
 *   - a per-module monthly cap in pounds, so a month cannot;
 *   - a maximum iteration count on any loop that regenerates until a condition
 *     is met, so the loop reports what is still wrong instead of spinning.
 *
 * All three stop the work and say why. None of them silently degrades to a
 * cheaper model, because quietly producing worse notes is the failure that
 * would be hardest to notice.
 */

export class RunCeilingError extends Error {
  constructor(
    readonly label: string,
    readonly used: number,
    readonly ceiling: number,
  ) {
    super(
      `"${label}" reached its token ceiling (${used.toLocaleString()} of ` +
        `${ceiling.toLocaleString()}) and stopped. Raise LLM_MAX_TOKENS_PER_RUN if this is ` +
        'genuinely a big job, or look at what it is repeating.',
    );
    this.name = 'RunCeilingError';
  }
}

export class MonthlyCapError extends Error {
  constructor(
    readonly moduleId: string,
    readonly spentGbp: number,
    readonly capGbp: number,
  ) {
    super(
      `This module has spent £${spentGbp.toFixed(2)} of its £${capGbp.toFixed(2)} monthly cap, ` +
        'so generation has stopped. Raise LLM_MONTHLY_CAP_GBP to continue, or wait for the ' +
        'first of the month.',
    );
    this.name = 'MonthlyCapError';
  }
}

export class IterationLimitError extends Error {
  constructor(
    readonly label: string,
    readonly limit: number,
  ) {
    super(
      `"${label}" ran ${limit} passes without finishing and stopped. What is still outstanding ` +
        'is reported rather than retried, because a loop that has not converged in ' +
        `${limit} passes usually will not converge in ${limit + 1}.`,
    );
    this.name = 'IterationLimitError';
  }
}

/** Unix seconds at midnight on the 1st of the current month, UTC. */
export function startOfMonth(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

/** What this module has been charged so far this calendar month, in dollars. */
export function monthlySpendUsd(moduleId: string, now = new Date()): number {
  const row = getDb()
    .select({ total: sql<number>`coalesce(sum(${schema.llmCalls.costUsd}), 0)` })
    .from(schema.llmCalls)
    .where(
      and(
        eq(schema.llmCalls.moduleId, moduleId),
        gte(schema.llmCalls.createdAt, startOfMonth(now)),
      ),
    )
    .get();
  return row?.total ?? 0;
}

export interface RunOptions {
  /** What this run is for, quoted back in any error. */
  label: string;
  /** The module being charged. Without one the monthly cap cannot apply. */
  moduleId?: string;
  tokenCeiling?: number;
  maxIterations?: number;
  /** Tighter than the configured cap, for a job you want kept on a short lead. */
  monthlyCapGbp?: number;
}

/**
 * One unit of work — generating a section's notes, extracting a lecture's
 * concepts — across however many model calls it takes.
 */
export class LlmRun {
  readonly id = newId();
  readonly label: string;
  readonly moduleId: string | undefined;
  readonly tokenCeiling: number;
  readonly maxIterations: number;
  readonly monthlyCapGbp: number;

  tokensUsed = 0;
  costUsd = 0;
  callCount = 0;
  iterations = 0;

  constructor(options: RunOptions) {
    this.label = options.label;
    this.moduleId = options.moduleId;
    this.tokenCeiling = options.tokenCeiling ?? config.llm.maxTokensPerRun;
    this.maxIterations = options.maxIterations ?? config.llm.maxIterations;
    this.monthlyCapGbp = options.monthlyCapGbp ?? config.llm.monthlyCapGbpPerModule;
  }

  /** Called before every model call. Throws rather than letting the call happen. */
  check(now = new Date()): void {
    if (this.tokensUsed >= this.tokenCeiling) {
      throw new RunCeilingError(this.label, this.tokensUsed, this.tokenCeiling);
    }
    if (this.moduleId) {
      const spentGbp = usdToGbp(monthlySpendUsd(this.moduleId, now));
      const cap = this.monthlyCapGbp;
      if (cap > 0 && spentGbp >= cap) {
        throw new MonthlyCapError(this.moduleId, spentGbp, cap);
      }
    }
  }

  record(usage: LlmUsage, costUsd: number | null): void {
    this.tokensUsed +=
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    this.costUsd += costUsd ?? 0;
    this.callCount += 1;
  }

  /**
   * Marks the start of another pass round a regeneration loop. Call it at the
   * top of the loop body; it throws once the limit is reached, which is what
   * turns "keeps going until covered" into "gives up and tells you".
   */
  nextIteration(): number {
    if (this.iterations >= this.maxIterations) {
      throw new IterationLimitError(this.label, this.maxIterations);
    }
    this.iterations += 1;
    return this.iterations;
  }
}

export function startRun(options: RunOptions): LlmRun {
  return new LlmRun(options);
}
