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
 * Gemini, over its REST API.
 *
 * The spec routes the cheap high-volume work here — concept extraction,
 * transcript cleanup, figure captioning — because it handles images and costs
 * a fraction of the note-generation model.
 *
 * There is no official Node SDK dependency added for this: one HTTP call
 * against a documented endpoint is not worth another package in a project that
 * has to install cleanly on a student's laptop.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Our JSON schemas, cut down to what Gemini's `responseSchema` accepts.
 *
 * Every schema in prompts.ts is written once, in full JSON Schema, and reused
 * across whichever provider ends up serving the task — that reuse is the
 * whole point of routing tasks to models rather than writing a prompt per
 * provider. But Gemini's `responseSchema` is not JSON Schema: it is a
 * deliberately restricted OpenAPI-3.0-flavoured subset, and it rejects any
 * field it does not recognise with a 400 rather than ignoring it.
 *
 * `additionalProperties: false` is in every one of our object schemas — it is
 * how "the model may not invent an extra field" is expressed — and Gemini has
 * no such field at all. Sent as-is, every schema-constrained call to Gemini
 * fails with "Unknown name additionalProperties: Cannot find field", which is
 * exactly the reason this had never worked. It looked like a JSON payload
 * problem in the error text; it was a schema dialect mismatch, and the
 * request had never once successfully reached the model.
 *
 * This is deliberately narrow — it drops only the one field known to be
 * incompatible, rather than allow-listing Gemini's accepted keys and risking
 * silently dropping something a future schema relies on.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const { additionalProperties: _drop, ...rest } = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    cleaned[key] = toGeminiSchema(value);
  }
  return cleaned;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

export const geminiProvider: Provider = {
  name: 'gemini',

  configured() {
    return Boolean(config.llm.keys.gemini);
  },

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const parts: Array<Record<string, unknown>> = [];
    for (const image of request.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
    }
    parts.push({ text: request.prompt });

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        ...(request.jsonSchema
          ? {
              responseMimeType: 'application/json',
              responseSchema: toGeminiSchema(request.jsonSchema),
            }
          : {}),
      },
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    };

    const url = `${ENDPOINT}/${encodeURIComponent(request.model)}:generateContent`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.llm.keys.gemini,
        },
        body: JSON.stringify(body),
        signal: request.signal ?? AbortSignal.timeout(config.llm.timeoutMs),
      });
    } catch (error) {
      throw new ProviderUnavailableError('gemini', describeFetchError(error), error);
    }

    const payload = (await response.json().catch(() => ({}))) as GeminiResponse;

    if (!response.ok) {
      const message = payload.error?.message ?? `HTTP ${response.status}`;
      if (response.status === 400) throw new ProviderRequestError('gemini', message);
      throw new ProviderUnavailableError('gemini', `${response.status}: ${message}`);
    }

    const candidate = payload.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
    const usage = payload.usageMetadata ?? {};

    return {
      text,
      model: request.model,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        cacheReadTokens: usage.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0,
      },
    };
  },
};
