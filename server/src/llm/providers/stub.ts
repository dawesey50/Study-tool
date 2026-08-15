import { createHash } from 'node:crypto';
import type { Provider, ProviderRequest, ProviderResponse } from '../types.js';

/**
 * An offline provider that answers deterministically.
 *
 * Set `LLM_PROVIDER=stub` and everything works without a key or a network: the
 * routing, the ledger, the cache and all three caps run exactly as they do
 * against a real provider. That is the only way to test a runaway loop stopping
 * itself without paying to prove it.
 *
 * It answers for whatever model it is asked for, so cost arithmetic is
 * exercised against the real price table rather than a made-up rate.
 */

export interface StubScript {
  /** Return text to answer with, or an Error to throw. Default: a hash of the prompt. */
  respond?: (request: ProviderRequest, callIndex: number) => string | Error;
  /** Reported output tokens per call. Lets a test reach a ceiling in a known number of calls. */
  outputTokens?: number;
}

let script: StubScript = {};
let calls: ProviderRequest[] = [];

export function setStub(next: StubScript): void {
  script = next;
  calls = [];
}

export function resetStub(): void {
  script = {};
  calls = [];
}

export function stubCalls(): ProviderRequest[] {
  return calls;
}

/** Rough, and only used by the stub: real providers report their own counts. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export const stubProvider: Provider = {
  name: 'stub',

  configured() {
    return true;
  },

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const index = calls.length;
    calls.push(request);

    const answer =
      script.respond?.(request, index) ??
      `stub:${createHash('sha256').update(request.prompt).digest('hex').slice(0, 16)}`;
    if (answer instanceof Error) throw answer;

    return {
      text: answer,
      model: request.model,
      usage: {
        inputTokens: estimateTokens(request.prompt) + estimateTokens(request.system ?? ''),
        outputTokens: script.outputTokens ?? estimateTokens(answer),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  },
};
