import { config } from '../../config.js';
import {
  ProviderRequestError,
  ProviderUnavailableError,
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
          ? { responseMimeType: 'application/json', responseSchema: request.jsonSchema }
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
      throw new ProviderUnavailableError('gemini', (error as Error).message, error);
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
