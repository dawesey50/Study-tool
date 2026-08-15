/**
 * The LLM layer.
 *
 * Three of these tests exist because the alternative is proving them with a
 * real bill: a run that will not stop, a month that will not stop, and a
 * coverage loop that never converges. All three run offline against a stub
 * provider that reports real-looking token counts, so the routing, the ledger,
 * the cache and every cap are exercised end to end without a key.
 *
 * The stub answers for whatever model it is asked for, which means the cost
 * arithmetic below is checked against the real price table rather than an
 * invented rate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-llm-'));
process.env.DATA_DIR = tempDir;
process.env.EMBEDDINGS_PROVIDER = 'hash';
// Swapping the note-generation model is meant to be a config change and
// nothing else. This is that swap, and the routing test below is its proof.
process.env.LLM_MODEL_NOTES = 'claude-opus-5';
process.env.LLM_MODEL_EXAMINER = 'claude-haiku-4-5';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.LLM_MONTHLY_CAP_GBP = '1000';

const { buildServer } = await import('../src/index.js');
const { closeDb, getDb, schema } = await import('../src/db/index.js');
const llm = await import('../src/llm/index.js');
const { PROVIDERS } = await import('../src/llm/routing.js');
const { stubProvider, setStub, resetStub, stubCalls } = await import(
  '../src/llm/providers/stub.js'
);
const { usageSummary } = await import('../src/llm/usage.js');
const { costUsd } = await import('../src/llm/pricing.js');
import type { Provider, ProviderRequest, ProviderResponse } from '../src/llm/types.js';

type App = Awaited<ReturnType<typeof buildServer>>;
let app: App;
let moduleId: string;

const realAnthropic = PROVIDERS.anthropic!;

before(async () => {
  app = await buildServer({ logger: false });
  await app.ready();

  // The routing stays exactly as it is in production — Claude first, then the
  // fallbacks — and only the transport is replaced.
  PROVIDERS.anthropic = { ...stubProvider, name: 'anthropic' };

  const created = await app.inject({
    method: 'POST',
    url: '/api/modules',
    payload: { title: 'Neuroscience' },
  });
  moduleId = (JSON.parse(created.body) as { id: string }).id;
});

after(async () => {
  PROVIDERS.anthropic = realAnthropic;
  await app.close();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetStub();
});

/** Unique per test, so one test's cached answer cannot serve another's. */
let promptSeed = 0;
const uniquePrompt = (label: string): string => `${label} #${++promptSeed}`;

test('a task runs the model named in config, not one named in code', async () => {
  const result = await llm.complete({
    task: 'note_generation',
    prompt: uniquePrompt('summarise the action potential'),
  });

  assert.equal(result.model, 'claude-opus-5');
  assert.equal(result.provider, 'anthropic');
  assert.equal(stubCalls()[0]?.model, 'claude-opus-5');

  // Different task, different model, same call site.
  const checked = await llm.complete({ task: 'examiner', prompt: uniquePrompt('check this') });
  assert.equal(checked.model, 'claude-haiku-4-5');
});

test('every call lands in the ledger, priced from the model table', async () => {
  setStub({ respond: () => 'x'.repeat(400), outputTokens: 1000 });

  const before = usageSummary().calls;
  const result = await llm.complete({
    task: 'note_generation',
    prompt: uniquePrompt('write the notes'),
    moduleId,
  });

  assert.equal(result.cached, false);
  assert.equal(result.usage.outputTokens, 1000);

  // claude-opus-5 is $5 in / $25 out per million tokens.
  const expected = costUsd('claude-opus-5', {
    inputTokens: result.usage.inputTokens,
    outputTokens: 1000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.ok(expected !== null);
  assert.equal(result.costUsd, expected);

  const summary = usageSummary();
  assert.equal(summary.calls, before + 1);
  const row = summary.modules.find((entry) => entry.moduleId === moduleId);
  assert.ok(row, 'the module should appear in the usage summary');
  assert.ok(row.costGbp > 0);
  assert.equal(row.unpricedCalls, 0);
});

test('an identical request is served from cache and never reaches a provider', async () => {
  const prompt = uniquePrompt('explain saltatory conduction');

  const first = await llm.complete({ task: 'note_generation', prompt, moduleId });
  assert.equal(first.cached, false);
  assert.equal(stubCalls().length, 1);

  const second = await llm.complete({ task: 'note_generation', prompt, moduleId });
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.equal(second.costUsd, 0);
  assert.equal(stubCalls().length, 1, 'the provider should not have been called again');

  // And the cache can be bypassed on purpose, for a real regeneration.
  const forced = await llm.complete({ task: 'note_generation', prompt, moduleId, fresh: true });
  assert.equal(forced.cached, false);
  assert.equal(stubCalls().length, 2);

  const saved = usageSummary().savedGbp;
  assert.ok(saved > 0, 'the cache hit should show as money not spent');
});

test('an unpriced model records a null cost rather than a free one', async () => {
  const answered: ProviderRequest[] = [];
  const fake: Provider = {
    name: 'gemini',
    configured: () => true,
    async complete(request): Promise<ProviderResponse> {
      answered.push(request);
      return {
        text: 'concepts',
        model: request.model,
        usage: {
          inputTokens: 500,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
  const previous = PROVIDERS.gemini!;
  PROVIDERS.gemini = fake;
  try {
    const result = await llm.complete({
      task: 'concept_extraction',
      prompt: uniquePrompt('extract the concepts'),
      moduleId,
    });
    assert.equal(result.provider, 'gemini');
    assert.equal(result.costUsd, null, 'no price on file must not read as free');

    const row = usageSummary().modules.find((entry) => entry.moduleId === moduleId);
    assert.ok((row?.unpricedCalls ?? 0) > 0, 'unpriced calls are counted separately');
  } finally {
    PROVIDERS.gemini = previous;
  }
});

test('a provider that is down fails over to the next one', async () => {
  const down: Provider = {
    name: 'anthropic',
    configured: () => true,
    async complete() {
      throw new llm.ProviderUnavailableError('anthropic', '503: upstream unavailable');
    },
  };
  const standIn: Provider = {
    name: 'gemini',
    configured: () => true,
    async complete(request): Promise<ProviderResponse> {
      return {
        text: 'answered by the stand-in',
        model: request.model,
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };

  const previousAnthropic = PROVIDERS.anthropic!;
  const previousGemini = PROVIDERS.gemini!;
  PROVIDERS.anthropic = down;
  PROVIDERS.gemini = standIn;
  try {
    const result = await llm.complete({
      task: 'note_generation',
      prompt: uniquePrompt('carry on regardless'),
      moduleId,
    });
    assert.equal(result.provider, 'gemini');
    assert.deepEqual(
      result.failedOver.map((entry) => entry.provider),
      ['anthropic'],
    );

    // The failed attempt is in the ledger too — a call that errors after
    // generating output is still charged for, so hiding it would understate.
    const failures = getDb()
      .select()
      .from(schema.llmCalls)
      .all()
      .filter((row) => row.status === 'failed');
    assert.ok(failures.length > 0);
  } finally {
    PROVIDERS.anthropic = previousAnthropic;
    PROVIDERS.gemini = previousGemini;
  }
});

test('a refusal is reported, not routed around', async () => {
  let standInCalled = false;
  const refusing: Provider = {
    name: 'anthropic',
    configured: () => true,
    async complete() {
      throw new llm.LlmRefusedError('anthropic', 'bio — declined');
    },
  };
  const standIn: Provider = {
    name: 'gemini',
    configured: () => true,
    async complete(request): Promise<ProviderResponse> {
      standInCalled = true;
      return {
        text: 'should never be reached',
        model: request.model,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };

  const previousAnthropic = PROVIDERS.anthropic!;
  const previousGemini = PROVIDERS.gemini!;
  PROVIDERS.anthropic = refusing;
  PROVIDERS.gemini = standIn;
  try {
    await assert.rejects(
      () =>
        llm.complete({
          task: 'note_generation',
          prompt: uniquePrompt('something declined'),
          moduleId,
        }),
      llm.LlmRefusedError,
    );
    assert.equal(standInCalled, false, 'a decision is not an outage');
  } finally {
    PROVIDERS.anthropic = previousAnthropic;
    PROVIDERS.gemini = previousGemini;
  }
});

test('a run stops at its token ceiling', async () => {
  setStub({ outputTokens: 5000 });
  // The ceiling is checked before each call, so the first one always runs; it
  // is the second that must be refused once 5000 tokens are on the clock.
  const run = llm.startRun({ label: 'notes for 1.2', moduleId, tokenCeiling: 5000 });

  await llm.complete({ task: 'note_generation', prompt: uniquePrompt('first pass'), run });
  assert.ok(run.tokensUsed >= 5000);

  await assert.rejects(
    () => llm.complete({ task: 'note_generation', prompt: uniquePrompt('second pass'), run }),
    (error: Error) => {
      assert.equal(error.name, 'RunCeilingError');
      assert.match(error.message, /notes for 1\.2/);
      return true;
    },
  );
});

test('a module stops at its monthly cap', async () => {
  setStub({ outputTokens: 200_000 });
  const run = llm.startRun({ label: 'a very expensive run', moduleId, monthlyCapGbp: 0.5 });

  // One call at 200k output tokens on claude-opus-5 is $5, well over 50p.
  await llm.complete({ task: 'note_generation', prompt: uniquePrompt('expensive'), run });

  await assert.rejects(
    () =>
      llm.complete({
        task: 'note_generation',
        prompt: uniquePrompt('and again'),
        run: llm.startRun({ label: 'the next run', moduleId, monthlyCapGbp: 0.5 }),
      }),
    (error: Error) => {
      assert.equal(error.name, 'MonthlyCapError');
      assert.match(error.message, /monthly cap/);
      return true;
    },
  );
});

test('a coverage loop that never converges stops itself', async () => {
  setStub({ respond: () => 'notes that cover nothing new' });

  // Deliberately induced: the generator never covers the outstanding concept,
  // so "regenerate until covered" would run forever.
  const run = llm.startRun({ label: 'coverage for 2.1', moduleId, maxIterations: 3 });
  const uncovered = ['the Na+/K+ ATPase is electrogenic'];
  let passes = 0;

  const attempt = async (): Promise<void> => {
    while (uncovered.length > 0) {
      run.nextIteration();
      passes += 1;
      await llm.complete({
        task: 'note_generation',
        prompt: uniquePrompt(`cover ${uncovered.join(', ')}`),
        run,
      });
      // Coverage never improves. This is the runaway.
    }
  };

  await assert.rejects(attempt, (error: Error) => {
    assert.equal(error.name, 'IterationLimitError');
    assert.match(error.message, /coverage for 2\.1/);
    return true;
  });

  assert.equal(passes, 3, 'it should stop after the configured number of passes');
  assert.deepEqual(uncovered, ['the Na+/K+ ATPase is electrogenic']);
});

test('the status route reports what is configured and where the caps sit', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/llm/status' });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    routing: Array<{
      task: string;
      configuredModel: string;
      effectiveModel: string | null;
      available: boolean;
      substituted: boolean;
    }>;
    caps: { maxIterations: number; monthlyCapGbpPerModule: number };
    providers: Array<{ name: string; configured: boolean }>;
  };

  const notes = body.routing.find((row) => row.task === 'note_generation');
  assert.equal(notes?.configuredModel, 'claude-opus-5');
  assert.equal(notes?.effectiveModel, 'claude-opus-5');
  assert.equal(notes?.available, true);
  assert.equal(notes?.substituted, false);

  // Gemini has no key here, so concept extraction really runs on Claude. The
  // table has to say that rather than repeat what .env asked for.
  const concepts = body.routing.find((row) => row.task === 'concept_extraction');
  assert.equal(concepts?.configuredModel, 'gemini-2.5-flash');
  assert.equal(concepts?.substituted, true);
  assert.equal(concepts?.effectiveModel, 'claude-haiku-4-5');
  assert.ok(body.caps.maxIterations > 0);
  assert.ok(body.providers.some((provider) => provider.name === 'anthropic'));
});

test('the usage route adds up to what the ledger holds', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/llm/usage' });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    totalGbp: number;
    calls: number;
    modules: Array<{ moduleId: string; costGbp: number }>;
    byTask: Array<{ task: string }>;
    recent: unknown[];
  };

  const rows = getDb().select().from(schema.llmCalls).all();
  assert.equal(body.calls, rows.length);
  assert.ok(body.totalGbp > 0);
  assert.ok(body.modules.some((row) => row.moduleId === moduleId));
  assert.ok(body.byTask.some((row) => row.task === 'note_generation'));
  assert.ok(body.recent.length > 0);
});
