import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * What a call costs, and what a model can do.
 *
 * Prices are per million tokens in US dollars, because that is the unit the
 * bill arrives in. The spec budgets in pounds, so the interface converts using
 * a rate you can set and which it states next to the number — a converted
 * figure presented as if it were authoritative would be worse than no figure.
 *
 * A model missing from this table is not free, it is unpriced: its calls record
 * a null cost and the interface counts them separately. Add rates for Gemini
 * and Groq in data/model-prices.json when you sign up, since those change more
 * often than this file will.
 */
export interface ModelInfo {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Whether `thinking: { type: 'adaptive' }` is accepted. Sending it elsewhere is a 400. */
  adaptiveThinking?: boolean;
}

/** Anthropic list prices, from the Claude API reference dated 2026-06-24. */
const ANTHROPIC_MODELS: Record<string, ModelInfo> = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, adaptiveThinking: true },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, adaptiveThinking: true },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, adaptiveThinking: true },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25, adaptiveThinking: true },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, adaptiveThinking: true },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, adaptiveThinking: true },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, adaptiveThinking: true },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Reading a cached prefix costs about a tenth of a fresh token; writing one
 * costs about a quarter more. Approximate, and treated as such — they move the
 * total by pennies, not pounds.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

let overrides: Record<string, ModelInfo> | null = null;

function loadOverrides(): Record<string, ModelInfo> {
  if (overrides) return overrides;
  const file = path.join(config.dataDir, 'model-prices.json');
  try {
    if (fs.existsSync(file)) {
      overrides = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, ModelInfo>;
      return overrides;
    }
  } catch {
    // A malformed price file must not stop the app. Unpriced is the safe read.
  }
  overrides = {};
  return overrides;
}

/** Test seam, and the way to pick up an edited price file without a restart. */
export function reloadPrices(): void {
  overrides = null;
}

export function modelInfo(model: string): ModelInfo | null {
  return loadOverrides()[model] ?? ANTHROPIC_MODELS[model] ?? null;
}

export function supportsAdaptiveThinking(model: string): boolean {
  return modelInfo(model)?.adaptiveThinking === true;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Null when no price is on file — never zero, which would read as free. */
export function costUsd(model: string, tokens: TokenCounts): number | null {
  const info = modelInfo(model);
  if (!info) return null;
  const input =
    tokens.inputTokens +
    tokens.cacheReadTokens * CACHE_READ_MULTIPLIER +
    tokens.cacheWriteTokens * CACHE_WRITE_MULTIPLIER;
  return (input * info.inputPerMTok + tokens.outputTokens * info.outputPerMTok) / 1_000_000;
}

export function usdToGbp(usd: number): number {
  return usd * config.llm.usdToGbp;
}

export function pricedModels(): string[] {
  return [...new Set([...Object.keys(ANTHROPIC_MODELS), ...Object.keys(loadOverrides())])].sort();
}
