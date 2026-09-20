import { config } from '../../config.js';
import {
  ProviderRequestError,
  ProviderUnavailableError,
  describeFetchError,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from '../types.js';

/**
 * Mistral, a fifth link added to the chain after a real user watched both
 * Gemini and Groq fail in the same window — Gemini overloaded, Groq blocked
 * by local antivirus scanning. Neither is common on its own, but "every
 * provider failed" stops a study session outright, and one more free option
 * makes that a much rarer event than a coincidence of two.
 *
 * Mistral's own API is OpenAI-shaped, same as Groq's. It also has a real
 * JSON-schema response mode (`response_format: { type: 'json_schema' }`), but
 * this deliberately does not use it: the exact nested shape it expects was not
 * something this codebase could verify against current docs at the time this
 * was written, and guessing a schema dialect wrong is exactly the mistake that
 * broke Gemini silently for as long as it did (see gemini.ts). `json_object`
 * mode is verified and unambiguous — it guarantees syntactically valid JSON,
 * with the desired shape carried in the prompt, same as Groq.
 */

const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';

interface MistralResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  message?: string;
}

export const mistralProvider: Provider = {
  name: 'mistral',

  configured() {
    return Boolean(config.llm.keys.mistral);
  },

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    // The free "Experiment" tier's chat models are text-only; vision needs a
    // separate Pixtral model this provider isn't configured to use.
    if (request.images?.length) {
      throw new ProviderUnavailableError('mistral', 'this provider is configured for text only');
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push({ role: 'user', content: request.prompt });

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.llm.keys.mistral}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages,
          max_tokens: request.maxTokens,
          ...(request.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: request.signal ?? AbortSignal.timeout(config.llm.timeoutMs),
      });
    } catch (error) {
      throw new ProviderUnavailableError('mistral', describeFetchError(error), error);
    }

    const payload = (await response.json().catch(() => ({}))) as MistralResponse;

    if (!response.ok) {
      const message = payload.message ?? `HTTP ${response.status}`;
      if (response.status === 400) throw new ProviderRequestError('mistral', message);
      throw new ProviderUnavailableError('mistral', `${response.status}: ${message}`);
    }

    const usage = payload.usage ?? {};
    return {
      text: payload.choices?.[0]?.message?.content ?? '',
      model: request.model,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  },
};
