import { config } from '../config.js';
import { anthropicProvider } from './providers/anthropic.js';
import { geminiProvider } from './providers/gemini.js';
import { groqProvider } from './providers/groq.js';
import { stubProvider } from './providers/stub.js';
import type { LlmTask, Provider } from './types.js';

/**
 * Which model answers which task, and what stands in when it cannot.
 *
 * The spec's whole point in putting this behind one interface is that models
 * become a config choice: to move note generation to a different model, change
 * LLM_MODEL_NOTES in .env and restart. No feature code knows a model name.
 */

export const PROVIDERS: Record<string, Provider> = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  groq: groqProvider,
  stub: stubProvider,
};

/** Descending preference, as §3 states it: Claude, then Gemini, then Groq. */
const FALLBACK_ORDER = ['anthropic', 'gemini', 'groq'] as const;

const TASK_MODELS: Record<LlmTask, () => string> = {
  hierarchy_proposal: () => config.llm.models.hierarchyProposal,
  concept_extraction: () => config.llm.models.conceptExtraction,
  transcript_cleanup: () => config.llm.models.transcriptCleanup,
  figure_caption: () => config.llm.models.figureCaption,
  note_generation: () => config.llm.models.noteGeneration,
  section_rewrite: () => config.llm.models.sectionRewrite,
  question_generation: () => config.llm.models.questionGeneration,
  examiner: () => config.llm.models.examiner,
};

/** Reasoning-heavy work gets extended thinking where the model supports it. */
const THINKING_TASKS = new Set<LlmTask>([
  'hierarchy_proposal',
  'concept_extraction',
  'note_generation',
  'section_rewrite',
  'question_generation',
]);

export function wantsThinking(task: LlmTask): boolean {
  return THINKING_TASKS.has(task);
}

export function modelForTask(task: LlmTask): string {
  return TASK_MODELS[task]();
}

/** A model id names its own provider, so the two never drift out of step. */
export function providerForModel(model: string): string {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('stub')) return 'stub';
  return 'groq';
}

export interface RouteStep {
  provider: Provider;
  model: string;
}

/**
 * The chain to try, in order, skipping providers with no API key. An
 * unconfigured provider is not a failure to report — it was never an option.
 */
export function routeFor(task: LlmTask): RouteStep[] {
  const model = modelForTask(task);

  if (config.llm.forceProvider) {
    const forced = PROVIDERS[config.llm.forceProvider];
    return forced && forced.configured() ? [{ provider: forced, model }] : [];
  }

  const primary = providerForModel(model);
  const steps: RouteStep[] = [];

  for (const name of [primary, ...FALLBACK_ORDER.filter((p) => p !== primary)]) {
    const provider = PROVIDERS[name];
    if (!provider?.configured()) continue;
    steps.push({
      provider,
      model:
        name === primary
          ? model
          : config.llm.fallbackModels[name as keyof typeof config.llm.fallbackModels],
    });
  }

  return steps;
}

export interface RoutingRow {
  task: LlmTask;
  /** What .env asks for. */
  configuredModel: string;
  configuredProvider: string;
  /** What will actually answer, which differs when the first choice has no key. */
  effectiveModel: string | null;
  effectiveProvider: string | null;
  chain: string[];
  available: boolean;
  /** True when the configured model is not the one that will run. */
  substituted: boolean;
}

/**
 * For the Settings panel. It reports the model that will actually answer, not
 * the one configured, because those differ the moment a provider has no key —
 * and a panel showing "Gemini" for work Claude is really doing would be worse
 * than showing nothing.
 */
export function routingTable(): RoutingRow[] {
  return (Object.keys(TASK_MODELS) as LlmTask[]).map((task) => {
    const chain = routeFor(task);
    const configuredModel = modelForTask(task);
    const first = chain[0];
    return {
      task,
      configuredModel,
      configuredProvider: providerForModel(configuredModel),
      effectiveModel: first?.model ?? null,
      effectiveProvider: first?.provider.name ?? null,
      chain: chain.map((step) => `${step.provider.name}/${step.model}`),
      available: chain.length > 0,
      substituted: Boolean(first) && first!.model !== configuredModel,
    };
  });
}
