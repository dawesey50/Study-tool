import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Works from both src (tsx) and dist (built). */
export const repoRoot = path.resolve(here, '../..');

/** Minimal .env reader — avoids a dependency for something this small. */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(repoRoot, '.env'));

const str = (key: string, fallback: string): string => process.env[key]?.trim() || fallback;
const num = (key: string, fallback: number): number => {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(repoRoot, p));

const dataDir = resolve(str('DATA_DIR', './data'));

export const config = {
  port: num('PORT', 5174),
  host: str('HOST', '127.0.0.1'),

  dataDir,
  /** Extracted figures and stored originals live under here. */
  mediaDir: path.join(dataDir, 'media'),
  dbPath: path.join(dataDir, 'processor.db'),

  embeddings: {
    provider: str('EMBEDDINGS_PROVIDER', 'local') as 'local' | 'hash',
    model: str('EMBEDDING_MODEL', 'Xenova/all-MiniLM-L6-v2'),
    dim: num('EMBEDDING_DIM', 384),
    cacheDir: resolve(str('MODEL_CACHE_DIR', './.models')),
  },

  vectorBackend: str('VECTOR_BACKEND', 'sqlite-vec') as 'sqlite-vec' | 'brute',

  /**
   * Largest single upload, in megabytes. Scanned textbooks are routinely
   * hundreds of megabytes, and the old 200 MB ceiling rejected them with a
   * message that did not say what the limit was.
   */
  maxUploadMb: num('MAX_UPLOAD_MB', 500),

  /**
   * Restore points kept per module. They cost a copy of the notes' text and
   * nothing else, but unbounded history would grow with every generation run
   * and nobody reaches for one from forty runs ago.
   */
  snapshotsKept: num('SNAPSHOTS_KEPT', 20),

  /**
   * The plausibility check on a section's concept count. Every number here is
   * a guess until real lecture material has been through, which is why they
   * are settings rather than constants.
   */
  concepts: {
    charsPerConcept: num('CONCEPT_CHARS_EACH', 900),
    plausibleLow: num('CONCEPT_PLAUSIBLE_LOW', 0.2),
    plausibleHigh: num('CONCEPT_PLAUSIBLE_HIGH', 4),
    minCharsToJudge: num('CONCEPT_MIN_CHARS', 2500),
  },

  /**
   * Note generation. Both thresholds are guesses and the coverage one deserves
   * particular suspicion, because it decides whether the badge tells the truth:
   * set it too low and the notes read as fully covered while concepts are only
   * mentioned in passing.
   */
  generation: {
    coverageThreshold: num('COVERAGE_THRESHOLD', 0.62),
    figureThreshold: num('FIGURE_MATCH_THRESHOLD', 0.5),
    maxOutputTokens: num('NOTE_MAX_OUTPUT_TOKENS', 8000),
    /** Replaces the built-in note format wholesale when set. */
    noteFormat: str('NOTE_FORMAT', ''),
  },

  /**
   * Matching past-paper questions to concepts. Untuned like the rest: set it
   * too low and half the module gets flagged examinable, which is the same as
   * flagging none of it.
   */
  pastPapers: {
    matchThreshold: num('PAST_PAPER_MATCH_THRESHOLD', 0.55),
  },

  /**
   * The question engine's gates — §7.3. These are the spec's own numbers and
   * they are the riskiest guesses in the system: they decide whether a bank of
   * fifty questions contains fifty different questions or five wearing hats.
   * Plan v2's Step 7a exists to test exactly this before more is built on it.
   */
  questions: {
    cosineLimit: num('QUESTION_COSINE_LIMIT', 0.85),
    trigramLimit: num('QUESTION_TRIGRAM_LIMIT', 0.4),
    /** Tighter against real exam questions: reproducing one is the worst case. */
    pastPaperLimit: num('QUESTION_PAST_PAPER_LIMIT', 0.75),
    /** Attempts at one blueprint before resampling it entirely. */
    strikesPerBlueprint: num('QUESTION_STRIKES', 3),
    /**
     * Failed blueprints tolerated per question asked for, before the run gives
     * up and says the material is exhausted.
     *
     * The worst case in model calls is `count * (this + 1) * strikes`, since
     * the questions that do succeed cost calls as well as the ones that do
     * not — at the defaults, twenty-seven calls per question requested. That
     * is the real ceiling on what one request can spend, and it is a large
     * number: it is a backstop against a pathological model, not a budget.
     */
    blueprintAttemptsEach: num('QUESTION_BLUEPRINT_ATTEMPTS', 8),
    /** Average examiner score below which a question is rejected. */
    examinerFloor: num('QUESTION_EXAMINER_FLOOR', 4),
  },

  ingest: {
    chunkTargetChars: num('CHUNK_TARGET_CHARS', 1400),
    chunkOverlapChars: num('CHUNK_OVERLAP_CHARS', 180),
    figureMinDimension: num('FIGURE_MIN_DIMENSION', 90),
  },

  llm: {
    /**
     * Which model runs which task. The spec's routing table, as config, so
     * changing the note-generation model is an edit to .env rather than a code
     * change. Each task falls back down the provider chain if its first choice
     * cannot be reached.
     */
    models: {
      hierarchyProposal: str('LLM_MODEL_HIERARCHY', 'claude-sonnet-5'),
      conceptExtraction: str('LLM_MODEL_CONCEPTS', 'gemini-2.5-flash'),
      transcriptCleanup: str('LLM_MODEL_TRANSCRIPT', 'gemini-2.5-flash'),
      figureCaption: str('LLM_MODEL_FIGURE_CAPTION', 'gemini-2.5-flash'),
      noteGeneration: str('LLM_MODEL_NOTES', 'claude-sonnet-5'),
      sectionRewrite: str('LLM_MODEL_REWRITE', 'claude-sonnet-5'),
      questionGeneration: str('LLM_MODEL_QUESTIONS', 'claude-sonnet-5'),
      examiner: str('LLM_MODEL_EXAMINER', 'claude-haiku-4-5'),
    },

    /**
     * What each provider runs when it is standing in for another. Exposed
     * because provider model names change more often than this code will.
     */
    fallbackModels: {
      anthropic: str('LLM_FALLBACK_MODEL_ANTHROPIC', 'claude-haiku-4-5'),
      gemini: str('LLM_FALLBACK_MODEL_GEMINI', 'gemini-2.5-flash'),
      groq: str('LLM_FALLBACK_MODEL_GROQ', 'llama-3.3-70b-versatile'),
    },

    keys: {
      anthropic: str('ANTHROPIC_API_KEY', ''),
      gemini: str('GEMINI_API_KEY', ''),
      groq: str('GROQ_API_KEY', ''),
    },

    /** Forces every task onto one provider. 'stub' answers offline, for tests. */
    forceProvider: str('LLM_PROVIDER', '') as '' | 'anthropic' | 'gemini' | 'groq' | 'stub',

    /**
     * The three brakes. Accounting says what was spent; these stop it being
     * spent. A coverage loop that never converges is the failure mode they
     * exist for — it costs real money overnight with nothing to show.
     */
    maxTokensPerRun: num('LLM_MAX_TOKENS_PER_RUN', 400_000),
    monthlyCapGbpPerModule: num('LLM_MONTHLY_CAP_GBP', 15),
    maxIterations: num('LLM_MAX_ITERATIONS', 3),

    /** Ceiling on one response. Individual tasks ask for less. */
    maxOutputTokens: num('LLM_MAX_OUTPUT_TOKENS', 8000),
    /** Above this, stream, so a long answer cannot hit the request timeout. */
    streamAboveTokens: num('LLM_STREAM_ABOVE_TOKENS', 8000),
    timeoutMs: num('LLM_TIMEOUT_MS', 120_000),

    /** Reuse identical answers rather than paying for them twice. */
    cache: str('LLM_CACHE', 'on') !== 'off',

    /** Only for display. The bill arrives in dollars; the budget is in pounds. */
    usdToGbp: num('USD_TO_GBP', 0.79),
  },
} as const;

export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.mediaDir, config.embeddings.cacheDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
