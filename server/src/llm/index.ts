import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { LlmRun, startRun } from './budget.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { costUsd } from './pricing.js';
import { modelForTask, routeFor, wantsThinking } from './routing.js';
import {
  AllProvidersFailedError,
  LlmNotConfiguredError,
  LlmRefusedError,
  ProviderRequestError,
  ProviderUnavailableError,
  type LlmImage,
  type LlmTask,
  type LlmUsage,
} from './types.js';

export * from './types.js';
export * from './budget.js';
export { clearCache } from './cache.js';
export { routingTable, modelForTask } from './routing.js';
export { costUsd, usdToGbp, modelInfo, reloadPrices } from './pricing.js';

/**
 * One way in for every model call in the system.
 *
 * Feature code says what it wants done — `task: 'note_generation'` — and never
 * names a model, a provider or a price. That indirection is the whole point of
 * §3's routing table: swapping the note-generation model is an edit to .env.
 *
 * Everything that has to happen on every call happens here, once: the fallback
 * chain, the cache, the three caps, and a ledger row for every attempt
 * including the ones that failed. A feature that called a provider directly
 * would skip all four, so nothing else in this codebase imports a provider.
 */

export interface CompleteRequest {
  task: LlmTask;
  prompt: string;
  system?: string;
  images?: LlmImage[];
  /** Ask for JSON matching this schema, enforced by the provider where it can. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  /** The unit of work this call belongs to. One is invented if you omit it. */
  run?: LlmRun;
  /** Charged to this module, and counted against its monthly cap. */
  moduleId?: string;
  /** Ignore any cached answer and pay for a new one. */
  fresh?: boolean;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  /** Present when jsonSchema was given. Parsed, or the call throws. */
  json?: unknown;
  provider: string;
  model: string;
  usage: LlmUsage;
  costUsd: number | null;
  cached: boolean;
  /** Providers tried and rejected before this answer. Empty on a first-choice hit. */
  failedOver: Array<{ provider: string; error: string }>;
}

const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

interface LedgerRow {
  task: LlmTask;
  moduleId: string | undefined;
  runId: string;
  provider: string;
  model: string;
  status: 'ok' | 'failed' | 'refused' | 'cached';
  usage: LlmUsage;
  costUsd: number | null;
  latencyMs: number;
  requestHash: string;
  attempt: number;
  error?: string;
}

function record(row: LedgerRow): void {
  getDb()
    .insert(schema.llmCalls)
    .values({
      id: newId(),
      moduleId: row.moduleId ?? null,
      runId: row.runId,
      task: row.task,
      provider: row.provider,
      model: row.model,
      status: row.status,
      inputTokens: row.usage.inputTokens,
      outputTokens: row.usage.outputTokens,
      cacheReadTokens: row.usage.cacheReadTokens,
      cacheWriteTokens: row.usage.cacheWriteTokens,
      costUsd: row.costUsd,
      latencyMs: row.latencyMs,
      requestHash: row.requestHash,
      attempt: row.attempt,
      error: row.error ?? null,
    })
    .run();
}

export async function complete(request: CompleteRequest): Promise<CompleteResult> {
  const run = request.run ?? startRun({ label: request.task, moduleId: request.moduleId });
  const moduleId = request.moduleId ?? run.moduleId;
  const model = modelForTask(request.task);
  const maxTokens = Math.min(request.maxTokens ?? config.llm.maxOutputTokens, config.llm.maxOutputTokens);

  const hash = cacheKey({
    task: request.task,
    model,
    ...(request.system !== undefined ? { system: request.system } : {}),
    prompt: request.prompt,
    ...(request.images ? { images: request.images } : {}),
    ...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
    maxTokens,
  });

  // The caps are checked before anything is spent, not after.
  run.check();

  if (config.llm.cache && !request.fresh) {
    const hit = readCache(hash);
    if (hit) {
      record({
        task: request.task,
        moduleId,
        runId: run.id,
        provider: hit.provider,
        model: hit.model,
        status: 'cached',
        usage: ZERO_USAGE,
        costUsd: 0,
        latencyMs: 0,
        requestHash: hash,
        attempt: 1,
      });
      return finish({
        text: hit.text,
        provider: hit.provider,
        model: hit.model,
        usage: ZERO_USAGE,
        costUsd: 0,
        cached: true,
        failedOver: [],
        jsonSchema: request.jsonSchema,
      });
    }
  }

  const chain = routeFor(request.task);
  if (chain.length === 0) throw new LlmNotConfiguredError(request.task);

  const failedOver: Array<{ provider: string; error: string }> = [];

  for (const [index, step] of chain.entries()) {
    const startedAt = Date.now();
    try {
      const response = await step.provider.complete({
        model: step.model,
        prompt: request.prompt,
        maxTokens,
        thinking: wantsThinking(request.task),
        ...(request.system !== undefined ? { system: request.system } : {}),
        ...(request.images ? { images: request.images } : {}),
        ...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });

      const cost = costUsd(response.model, response.usage);
      record({
        task: request.task,
        moduleId,
        runId: run.id,
        provider: step.provider.name,
        model: response.model,
        status: 'ok',
        usage: response.usage,
        costUsd: cost,
        latencyMs: Date.now() - startedAt,
        requestHash: hash,
        attempt: index + 1,
      });
      run.record(response.usage, cost);

      if (config.llm.cache) {
        writeCache(hash, {
          task: request.task,
          provider: step.provider.name,
          model: response.model,
          text: response.text,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        });
      }

      return finish({
        text: response.text,
        provider: step.provider.name,
        model: response.model,
        usage: response.usage,
        costUsd: cost,
        cached: false,
        failedOver,
        jsonSchema: request.jsonSchema,
      });
    } catch (error) {
      const refused = error instanceof LlmRefusedError;
      const ourFault = error instanceof ProviderRequestError;
      const message = (error as Error).message;

      record({
        task: request.task,
        moduleId,
        runId: run.id,
        provider: step.provider.name,
        model: step.model,
        status: refused ? 'refused' : 'failed',
        usage: ZERO_USAGE,
        costUsd: null,
        latencyMs: Date.now() - startedAt,
        requestHash: hash,
        attempt: index + 1,
        error: message,
      });

      // A refusal is a decision and a malformed request is our bug. Trying the
      // next provider would hide the second and quietly work around the first.
      if (refused || ourFault) throw error;
      if (!(error instanceof ProviderUnavailableError)) throw error;

      failedOver.push({ provider: step.provider.name, error: message });
    }
  }

  throw new AllProvidersFailedError(failedOver);
}

function finish(
  result: Omit<CompleteResult, 'json'> & { jsonSchema?: Record<string, unknown> },
): CompleteResult {
  const { jsonSchema, ...rest } = result;
  if (!jsonSchema) return rest;
  try {
    return { ...rest, json: JSON.parse(rest.text) };
  } catch {
    throw new Error(
      `${rest.provider}/${rest.model} was asked for JSON and returned something else: ` +
        `${rest.text.slice(0, 200)}`,
    );
  }
}

/** Namespaced form, so feature code reads `llm.complete({ ... })` as §3 writes it. */
export const llm = { complete, startRun };
