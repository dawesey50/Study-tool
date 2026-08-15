import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { startOfMonth } from './budget.js';
import { usdToGbp } from './pricing.js';

/**
 * What has been spent, per module, this month.
 *
 * The spec budgets about £7 a module. A number nobody can see is not a budget,
 * so this is what Settings reads: spend against the cap, what the cache has
 * saved, and — separately — how many calls have no price on file, because
 * folding those into the total as zero would make the figure a comfortable lie.
 */

export interface ModuleUsage {
  moduleId: string;
  title: string;
  calls: number;
  cachedCalls: number;
  failedCalls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costGbp: number;
  savedGbp: number;
  capGbp: number;
  remainingGbp: number;
}

export interface UsageSummary {
  /** The calendar month these figures cover, e.g. "2026-08". */
  month: string;
  capGbp: number;
  usdToGbp: number;
  totalGbp: number;
  savedGbp: number;
  calls: number;
  cachedCalls: number;
  unpricedCalls: number;
  modules: ModuleUsage[];
  byTask: Array<{ task: string; calls: number; costGbp: number }>;
  recent: Array<{
    createdAt: number;
    task: string;
    provider: string;
    model: string;
    status: string;
    inputTokens: number;
    outputTokens: number;
    costGbp: number | null;
    latencyMs: number | null;
    error: string | null;
  }>;
}

export function usageSummary(now = new Date()): UsageSummary {
  const db = getDb();
  const since = startOfMonth(now);
  const cap = config.llm.monthlyCapGbpPerModule;

  const perModule = db
    .select({
      moduleId: schema.llmCalls.moduleId,
      title: schema.modules.title,
      calls: sql<number>`count(*)`,
      cachedCalls: sql<number>`sum(case when ${schema.llmCalls.status} = 'cached' then 1 else 0 end)`,
      failedCalls: sql<number>`sum(case when ${schema.llmCalls.status} in ('failed', 'refused') then 1 else 0 end)`,
      unpricedCalls: sql<number>`sum(case when ${schema.llmCalls.status} = 'ok' and ${schema.llmCalls.costUsd} is null then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${schema.llmCalls.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${schema.llmCalls.outputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${schema.llmCalls.costUsd}), 0)`,
    })
    .from(schema.llmCalls)
    .leftJoin(schema.modules, eq(schema.modules.id, schema.llmCalls.moduleId))
    .where(gte(schema.llmCalls.createdAt, since))
    .groupBy(schema.llmCalls.moduleId)
    .all();

  // What the cache avoided: each hit is joined back to the answer it reused,
  // and charged at what that answer originally cost.
  const savedRows = db
    .select({
      moduleId: schema.llmCalls.moduleId,
      savedUsd: sql<number>`coalesce(sum(${schema.llmCache.costUsd}), 0)`,
    })
    .from(schema.llmCalls)
    .innerJoin(schema.llmCache, eq(schema.llmCache.hash, schema.llmCalls.requestHash))
    .where(and(eq(schema.llmCalls.status, 'cached'), gte(schema.llmCalls.createdAt, since)))
    .groupBy(schema.llmCalls.moduleId)
    .all();
  const savedByModule = new Map(savedRows.map((row) => [row.moduleId ?? '', row.savedUsd]));

  const modules: ModuleUsage[] = perModule.map((row) => {
    const costGbp = usdToGbp(row.costUsd);
    return {
      moduleId: row.moduleId ?? '',
      title: row.moduleId ? (row.title ?? 'Deleted module') : 'Not tied to a module',
      calls: row.calls,
      cachedCalls: row.cachedCalls,
      failedCalls: row.failedCalls,
      unpricedCalls: row.unpricedCalls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd,
      costGbp,
      savedGbp: usdToGbp(savedByModule.get(row.moduleId ?? '') ?? 0),
      capGbp: row.moduleId ? cap : 0,
      remainingGbp: row.moduleId ? Math.max(0, cap - costGbp) : 0,
    };
  });
  modules.sort((a, b) => b.costGbp - a.costGbp);

  const byTask = db
    .select({
      task: schema.llmCalls.task,
      calls: sql<number>`count(*)`,
      costUsd: sql<number>`coalesce(sum(${schema.llmCalls.costUsd}), 0)`,
    })
    .from(schema.llmCalls)
    .where(gte(schema.llmCalls.createdAt, since))
    .groupBy(schema.llmCalls.task)
    .all()
    .map((row) => ({ task: row.task, calls: row.calls, costGbp: usdToGbp(row.costUsd) }))
    .sort((a, b) => b.costGbp - a.costGbp);

  const recent = db
    .select()
    .from(schema.llmCalls)
    .orderBy(desc(schema.llmCalls.createdAt))
    .limit(20)
    .all()
    .map((row) => ({
      createdAt: row.createdAt,
      task: row.task,
      provider: row.provider,
      model: row.model,
      status: row.status,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costGbp: row.costUsd === null ? null : usdToGbp(row.costUsd),
      latencyMs: row.latencyMs,
      error: row.error,
    }));

  return {
    month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    capGbp: cap,
    usdToGbp: config.llm.usdToGbp,
    totalGbp: modules.reduce((sum, row) => sum + row.costGbp, 0),
    savedGbp: modules.reduce((sum, row) => sum + row.savedGbp, 0),
    calls: modules.reduce((sum, row) => sum + row.calls, 0),
    cachedCalls: modules.reduce((sum, row) => sum + row.cachedCalls, 0),
    unpricedCalls: modules.reduce((sum, row) => sum + row.unpricedCalls, 0),
    modules,
    byTask,
    recent,
  };
}
