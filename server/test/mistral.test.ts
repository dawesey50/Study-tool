/**
 * Mistral's provider — the fifth link in the chain, added after a real user
 * watched Gemini and Groq fail in the same window.
 *
 * Same shape as gemini.test.ts and for the same reason: a fetch mock stands
 * in for the network, but the provider's own code — the exact request body,
 * the exact error classification — runs for real, rather than being replaced
 * by a fake the way PROVIDERS.mistral is in llm.test.ts.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

process.env.MISTRAL_API_KEY = 'test-key';
process.env.EMBEDDINGS_PROVIDER = 'hash';
const { mistralProvider } = await import('../src/llm/providers/mistral.js');

const originalFetch = globalThis.fetch;
let lastRequest: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null =
  null;
let mockResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  lastRequest = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    lastRequest = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? '{}')),
    };
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

test('sends an OpenAI-shaped body to the real Mistral endpoint', async () => {
  mockResponse = {
    status: 200,
    body: {
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    },
  };

  const result = await mistralProvider.complete({
    model: 'mistral-small-latest',
    system: 'Be terse.',
    prompt: 'Say hi.',
    maxTokens: 50,
  });

  assert.equal(lastRequest?.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(lastRequest?.headers.authorization, 'Bearer test-key');
  assert.deepEqual(lastRequest?.body.messages, [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Say hi.' },
  ]);
  assert.equal(result.text, 'hello');
  assert.equal(result.usage.inputTokens, 4);
  assert.equal(result.usage.outputTokens, 1);
});

test('a JSON-schema request asks for json_object mode, not an unverified schema dialect', async () => {
  mockResponse = {
    status: 200,
    body: { choices: [{ message: { content: '{}' } }], usage: {} },
  };

  await mistralProvider.complete({
    model: 'mistral-small-latest',
    prompt: 'x',
    maxTokens: 50,
    jsonSchema: { type: 'object', additionalProperties: false, properties: {} },
  });

  // Deliberate: Mistral's real json_schema mode was not something this
  // codebase could verify the exact nested shape of at the time this was
  // written, and guessing wrong is exactly what silently broke Gemini (see
  // gemini.test.ts). json_object is a verified, unambiguous format.
  assert.deepEqual(lastRequest?.body.response_format, { type: 'json_object' });
});

test('a 400 is our bug, not a reason to fail over', async () => {
  mockResponse = {
    status: 400,
    body: { object: 'error', message: 'model does not exist', type: 'invalid_request_error' },
  };

  await assert.rejects(
    () => mistralProvider.complete({ model: 'not-a-real-model', prompt: 'x', maxTokens: 50 }),
    (error: Error) => {
      assert.equal(error.name, 'ProviderRequestError');
      assert.match(error.message, /model does not exist/);
      return true;
    },
  );
});

test('a rate limit is still worth failing over', async () => {
  mockResponse = { status: 429, body: { object: 'error', message: 'rate limited' } };

  await assert.rejects(
    () => mistralProvider.complete({ model: 'mistral-small-latest', prompt: 'x', maxTokens: 50 }),
    (error: Error) => {
      assert.equal(error.name, 'ProviderUnavailableError');
      return true;
    },
  );
});

test('an image request is refused outright rather than silently dropping the image', async () => {
  await assert.rejects(
    () =>
      mistralProvider.complete({
        model: 'mistral-small-latest',
        prompt: 'Describe this figure.',
        maxTokens: 50,
        images: [{ mediaType: 'image/png', data: 'YWJj' }],
      }),
    (error: Error) => {
      assert.equal(error.name, 'ProviderUnavailableError');
      assert.match(error.message, /text only/);
      return true;
    },
  );
});
