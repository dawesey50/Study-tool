import type { LlmTask } from '../db/schema.js';

export type { LlmTask };

/** An image to send alongside the prompt. Base64, because that is what every provider takes. */
export interface LlmImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Base64, no data: prefix. */
  data: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * What a provider is asked for, after routing has already chosen the model.
 * Deliberately narrow: anything a provider cannot express has to be expressed
 * in the prompt, which keeps the providers swappable.
 */
export interface ProviderRequest {
  model: string;
  system?: string;
  prompt: string;
  images?: LlmImage[];
  maxTokens: number;
  /** Ask for JSON matching this schema. Providers that cannot enforce it say so in the prompt. */
  jsonSchema?: Record<string, unknown>;
  /** Whether extended thinking is wanted, if the model supports it. */
  thinking?: boolean;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  usage: LlmUsage;
  /** The model that actually answered, which can differ from the one asked for. */
  model: string;
}

export interface Provider {
  readonly name: string;
  /** False when the API key is missing. Unconfigured providers are skipped, not tried and failed. */
  configured(): boolean;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

/**
 * Errors are split by whether trying the next provider could plausibly help.
 *
 * A transport failure or a rate limit is worth failing over. A malformed
 * request is our bug, and a refusal is a decision — routing around either one
 * just produces a second failure, or worse, quietly gets a different provider
 * to do something the first declined to do.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly underlying?: unknown,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** The request itself was wrong. Failing over would hide the bug. */
export class ProviderRequestError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

/** The model declined. Not an outage, and not something to route around. */
export class LlmRefusedError extends Error {
  constructor(
    readonly provider: string,
    readonly detail: string,
  ) {
    super(`${provider} declined to answer: ${detail}`);
    this.name = 'LlmRefusedError';
  }
}

/** No provider for this task has an API key. */
export class LlmNotConfiguredError extends Error {
  constructor(readonly task: LlmTask) {
    super(
      `No model provider is configured for "${task}". Add an API key to the .env file ` +
        '(ANTHROPIC_API_KEY, GEMINI_API_KEY or GROQ_API_KEY) and restart.',
    );
    this.name = 'LlmNotConfiguredError';
  }
}

/** Every provider in the chain was tried and none answered. */
export class AllProvidersFailedError extends Error {
  constructor(readonly attempts: Array<{ provider: string; error: string }>) {
    super(
      `Every provider failed: ${attempts.map((a) => `${a.provider} (${a.error})`).join('; ')}`,
    );
    this.name = 'AllProvidersFailedError';
  }
}
