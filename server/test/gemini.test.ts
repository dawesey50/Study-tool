/**
 * Gemini's provider, and the schema dialect mismatch that made it never work.
 *
 * WHAT WENT WRONG, FOUND BY A REAL USER RATHER THAN BY THIS FILE
 *
 * Every schema in prompts.ts is written once, in full JSON Schema, and reused
 * across whichever provider ends up serving the task. `additionalProperties:
 * false` is in every object schema — it is how "do not invent an extra field"
 * is expressed. Gemini's `responseSchema` is not JSON Schema: it is a
 * restricted OpenAPI-3.0 subset with no such field, and it rejects the whole
 * request with a 400 the moment it sees one it does not recognise.
 *
 * So every schema-constrained call to Gemini failed outright, every task
 * routed to Gemini by default (concept extraction is) silently skipped
 * instead of running, and nothing here caught it: the existing suite replaces
 * `PROVIDERS.gemini` with a fake object before every test, which exercises the
 * routing and fallback logic perfectly and never once runs the real body this
 * provider sends over the wire. This file exists to close that gap — a fetch
 * mock stands in for the network, but the provider's own code path, including
 * the exact JSON it builds, runs for real.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { toGeminiSchema } from '../src/llm/providers/gemini.js';

// ---------------------------------------------------------------------------
// The sanitiser, in isolation
// ---------------------------------------------------------------------------

/** Shaped like a real schema from prompts.ts: nested objects, arrays, enums. */
const REAL_SHAPED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts'],
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statement', 'type'],
        properties: {
          statement: { type: 'string' },
          type: { type: 'string', enum: ['fact', 'mechanism', 'pathway'] },
          difficulty: { type: 'integer', minimum: 1, maximum: 5 },
          sourceChunkIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
};

test('additionalProperties is stripped at every level of nesting', () => {
  const cleaned = toGeminiSchema(REAL_SHAPED_SCHEMA) as Record<string, unknown>;
  const asText = JSON.stringify(cleaned);

  // This is the entire bug. Gemini returns a 400 the moment it sees this key
  // anywhere in the document, at any depth.
  assert.ok(!asText.includes('additionalProperties'), asText);
});

test('everything else survives untouched', () => {
  const cleaned = toGeminiSchema(REAL_SHAPED_SCHEMA) as typeof REAL_SHAPED_SCHEMA;

  assert.equal(cleaned.type, 'object');
  assert.deepEqual(cleaned.required, ['concepts']);
  assert.equal(cleaned.properties.concepts.type, 'array');
  const item = cleaned.properties.concepts.items as Record<string, unknown>;
  assert.deepEqual(item.required, ['statement', 'type']);
  const props = item.properties as Record<string, { enum?: string[]; minimum?: number }>;
  assert.deepEqual(props.type!.enum, ['fact', 'mechanism', 'pathway']);
  assert.equal(props.difficulty!.minimum, 1);
});

test('a schema with nothing to strip round-trips exactly', () => {
  const plain = { type: 'string', description: 'x' };
  assert.deepEqual(toGeminiSchema(plain), plain);
});

test('primitives and null pass through unchanged', () => {
  assert.equal(toGeminiSchema('x'), 'x');
  assert.equal(toGeminiSchema(5), 5);
  assert.equal(toGeminiSchema(null), null);
  assert.equal(toGeminiSchema(true), true);
});

test('the original schema object is not mutated', () => {
  const before = JSON.stringify(REAL_SHAPED_SCHEMA);
  toGeminiSchema(REAL_SHAPED_SCHEMA);
  // The same schema object is reused across every call for a task, and every
  // provider in the fallback chain — mutating it here would leave Anthropic's
  // copy silently missing additionalProperties too.
  assert.equal(JSON.stringify(REAL_SHAPED_SCHEMA), before);
});

// ---------------------------------------------------------------------------
// The provider, with a fetch mock standing in for the network
// ---------------------------------------------------------------------------

process.env.GEMINI_API_KEY = 'test-key';
process.env.EMBEDDINGS_PROVIDER = 'hash';
const { geminiProvider } = await import('../src/llm/providers/gemini.js');

const originalFetch = globalThis.fetch;
let lastRequest: { url: string; body: Record<string, unknown> } | null = null;
let mockResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  lastRequest = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    lastRequest = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')) };
    return {
      ok: mockResponse.status < 400,
      status: mockResponse.status,
      json: async () => mockResponse.body,
    } as Response;
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('a schema-constrained request never contains additionalProperties on the wire', async () => {
  mockResponse = {
    status: 200,
    body: {
      candidates: [{ content: { parts: [{ text: '{"concepts":[]}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
  };

  await geminiProvider.complete({
    model: 'gemini-2.5-flash',
    prompt: 'Extract concepts.',
    maxTokens: 500,
    jsonSchema: REAL_SHAPED_SCHEMA,
  });

  // This is the assertion that would have caught the real bug before a real
  // user did: not that the sanitiser works in isolation, but that the actual
  // network body this provider sends is clean.
  const sent = JSON.stringify(lastRequest?.body);
  assert.ok(!sent.includes('additionalProperties'), sent);
  const responseSchema = (
    (lastRequest?.body.generationConfig as Record<string, unknown>)?.responseSchema
  );
  assert.ok(responseSchema, 'responseSchema was not sent at all');
});

test('a 400 from Gemini is our bug, not a reason to fail over', async () => {
  mockResponse = {
    status: 400,
    body: {
      error: {
        message:
          'Invalid JSON payload received. Unknown name "additionalProperties" at ' +
          '\'generation_config.response_schema\': Cannot find field.',
      },
    },
  };

  await assert.rejects(
    () =>
      geminiProvider.complete({
        model: 'gemini-2.5-flash',
        prompt: 'x',
        maxTokens: 100,
        jsonSchema: REAL_SHAPED_SCHEMA,
      }),
    (error: Error) => {
      // A malformed request is ours to fix, not a reason to spend a call on
      // the next provider in the chain and get the same wrong answer there
      // too — this is exactly why ProviderRequestError exists.
      assert.equal(error.name, 'ProviderRequestError');
      assert.match(error.message, /additionalProperties/);
      return true;
    },
  );
});

test('a rate limit is still worth failing over', async () => {
  mockResponse = { status: 429, body: { error: { message: 'Resource exhausted' } } };

  await assert.rejects(
    () =>
      geminiProvider.complete({ model: 'gemini-2.5-flash', prompt: 'x', maxTokens: 100 }),
    (error: Error) => {
      assert.equal(error.name, 'ProviderUnavailableError');
      return true;
    },
  );
});

test('images and a system prompt are still assembled correctly', async () => {
  mockResponse = {
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: {} },
  };

  await geminiProvider.complete({
    model: 'gemini-2.5-flash',
    system: 'Be terse.',
    prompt: 'Describe this figure.',
    maxTokens: 100,
    images: [{ mediaType: 'image/png', data: 'YWJj' }],
  });

  const body = lastRequest!.body;
  assert.equal(
    (body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text,
    'Be terse.',
  );
  const parts = (body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]!.parts;
  assert.ok(parts.some((part) => 'inlineData' in part));
  assert.ok(parts.some((part) => part.text === 'Describe this figure.'));
  // No schema was requested, so none should be sent.
  assert.ok(!('responseSchema' in (body.generationConfig as Record<string, unknown>)));
});
