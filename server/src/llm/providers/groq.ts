import { config } from '../../config.js';
import {
  ProviderRequestError,
  ProviderUnavailableError,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from '../types.js';

/**
 * Groq, the last link in the chain.
 *
 * Its own API is OpenAI-shaped, which is what the endpoint below speaks — this
 * is Groq's native interface, not a compatibility shim over another provider.
 * The spec puts it last for exactly one reason: a free tier that keeps work
 * moving when a paid provider is down.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

interface GroqResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export const groqProvider: Provider = {
  name: 'groq',

  configured() {
    return Boolean(config.llm.keys.groq);
  },

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    // The models on the free tier are text-only, so an image request cannot be
    // served here. Saying so is better than sending the prompt without its
    // images and returning a confident answer about nothing.
    if (request.images?.length) {
      throw new ProviderUnavailableError('groq', 'this provider is configured for text only');
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
          authorization: `Bearer ${config.llm.keys.groq}`,
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
      throw new ProviderUnavailableError('groq', (error as Error).message, error);
    }

    const payload = (await response.json().catch(() => ({}))) as GroqResponse;

    if (!response.ok) {
      const message = payload.error?.message ?? `HTTP ${response.status}`;
      if (response.status === 400) throw new ProviderRequestError('groq', message);
      throw new ProviderUnavailableError('groq', `${response.status}: ${message}`);
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
