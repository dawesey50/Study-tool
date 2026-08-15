import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { supportsAdaptiveThinking } from '../pricing.js';
import {
  LlmRefusedError,
  ProviderRequestError,
  ProviderUnavailableError,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from '../types.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: config.llm.keys.anthropic,
      timeout: config.llm.timeoutMs,
    });
  }
  return client;
}

/** Test seam: forget the client so a changed key is picked up. */
export function resetAnthropicClient(): void {
  client = null;
}

function buildContent(request: ProviderRequest): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const image of request.images ?? []) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }
  blocks.push({ type: 'text', text: request.prompt });
  return blocks;
}

export const anthropicProvider: Provider = {
  name: 'anthropic',

  configured() {
    return Boolean(config.llm.keys.anthropic);
  },

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: [{ role: 'user', content: buildContent(request) }],
      ...(request.system ? { system: request.system } : {}),
      // Adaptive thinking is the current shape; models that predate it reject
      // it outright, so it is gated on the model table rather than sent blind.
      ...(request.thinking && supportsAdaptiveThinking(request.model)
        ? { thinking: { type: 'adaptive' as const } }
        : {}),
      // Structured output rather than asking for JSON and hoping. Assistant
      // prefill, the old way of forcing this, is a 400 on current models.
      ...(request.jsonSchema
        ? {
            output_config: {
              format: { type: 'json_schema' as const, schema: request.jsonSchema },
            },
          }
        : {}),
    };

    let message: Anthropic.Message;
    try {
      // A long answer streamed cannot trip the request timeout half way
      // through; the final message is identical either way.
      message =
        request.maxTokens > config.llm.streamAboveTokens
          ? await getClient()
              .messages.stream(params, { ...(request.signal ? { signal: request.signal } : {}) })
              .finalMessage()
          : await getClient().messages.create(params, {
              ...(request.signal ? { signal: request.signal } : {}),
            });
    } catch (error) {
      throw translate(error);
    }

    if (message.stop_reason === 'refusal') {
      const detail = message.stop_details
        ? `${message.stop_details.category ?? 'unspecified'} — ${message.stop_details.explanation ?? ''}`
        : 'no detail given';
      throw new LlmRefusedError('anthropic', detail.trim());
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  },
};

/**
 * A bad request is our bug and must surface; anything else is worth trying the
 * next provider for. A wrong key counts as unavailable rather than fatal —
 * with three providers configured, one bad key should not stop the work.
 */
function translate(error: unknown): Error {
  if (error instanceof Anthropic.BadRequestError) {
    return new ProviderRequestError('anthropic', error.message);
  }
  if (error instanceof Anthropic.APIError) {
    return new ProviderUnavailableError(
      'anthropic',
      `${error.status ?? 'network'}: ${error.message}`,
      error,
    );
  }
  return new ProviderUnavailableError('anthropic', (error as Error).message, error);
}
