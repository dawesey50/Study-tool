/**
 * Typed wrapper over the Fastify API. Same-origin paths throughout: the Vite
 * dev server proxies them, and in production the same process serves both.
 */

export interface Module {
  id: string;
  code: string | null;
  title: string;
  year: number | null;
  notes: string | null;
  createdAt: number;
  sectionCount?: number;
  sourceCount?: number;
}

export type SectionStatus = 'empty' | 'drafted' | 'edited' | 'complete';

export interface SectionNode {
  id: string;
  moduleId: string;
  parentId: string | null;
  title: string;
  position: number;
  path: number[];
  /** Derived from position — "1.2.1". Never stored. */
  number: string;
  depth: number;
  status: SectionStatus;
  learningOutcomes: string[] | null;
  children: SectionNode[];
}

export type SourceType = 'slides' | 'transcript' | 'textbook' | 'notes' | 'past_paper';
export type SourceStatus = 'uploaded' | 'ingesting' | 'ingested' | 'failed';

export interface SectionMapping {
  sectionId: string;
  sectionNumber: string;
  sectionTitle: string;
  score: number;
  chunkIds: string[];
  confirmed: boolean;
}

export interface Source {
  id: string;
  moduleId: string;
  type: SourceType;
  title: string;
  filename: string;
  lectureDate: string | null;
  ingestedAt: number | null;
  status: SourceStatus;
  error: string | null;
  pageCount: number | null;
  sections: SectionMapping[];
}

export interface SourceDetail extends Source {
  figures: Figure[];
  chunkCount: number;
}

export interface Figure {
  id: string;
  sourceId: string;
  url: string;
  pageNo: number | null;
  width: number | null;
  height: number | null;
  captionExtracted: string | null;
  captionAi: string | null;
  altText: string | null;
  type: string | null;
}

export interface Chunk {
  id: string;
  text: string;
  pageNo: number | null;
  slideNo: number | null;
  timestamp: number | null;
  position: number;
  embedded: boolean;
  /** Ready-made citation, e.g. "L07 Action Potentials slide 14". */
  location: string;
}

export type NoteBlockType =
  | 'heading'
  | 'prose'
  | 'list'
  | 'table'
  | 'diagram'
  | 'figure'
  | 'callout'
  | 'summary'
  | 'crossref';

export type NoteBlockOrigin = 'ai_generated' | 'user_written' | 'user_edited';

export interface NoteBlock {
  id: string;
  sectionId: string;
  position: number;
  type: NoteBlockType;
  markdown: string;
  figureId: string | null;
  targetSectionId: string | null;
  conceptIds: string[] | null;
  sourceRefs: string[] | null;
  origin: NoteBlockOrigin;
  locked: boolean;
  generatedAt: number | null;
  updatedAt: number;
  embedded: boolean;
}

export interface SearchHit {
  kind: 'chunk' | 'note_block' | 'figure' | 'section';
  id: string;
  title: string;
  snippet: string;
  score: number;
  moduleId: string;
  sectionId?: string;
  sourceId?: string;
  location?: string;
}

export interface IngestResult {
  sourceId: string;
  chunks: number;
  figures: number;
  embedded: boolean;
  proposedSections: number;
  warnings: string[];
  /** The document was a scan, so almost no text could be read from it. */
  likelyScanned: boolean;
}

export type IngestPhase =
  | 'queued'
  | 'parsing'
  | 'embedding'
  | 'mapping'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Ingestion runs in the background; this is how its progress is followed. */
export interface IngestJob {
  sourceId: string;
  phase: IngestPhase;
  done: number;
  total: number;
  message: string;
  startedAt: number;
  finishedAt?: number;
  result?: IngestResult;
  error?: string;
}

export interface Health {
  ok: boolean;
  embeddings:
    | { state: 'ready'; provider: string; dim: number }
    | { state: 'unavailable'; provider: string; dim: number; reason: string };
  vectorIndex: string;
  vectorBackendRequested: string;
  dataDir: string;
  maxUploadMb: number;
}

export type LlmTask =
  | 'hierarchy_proposal'
  | 'concept_extraction'
  | 'transcript_cleanup'
  | 'figure_caption'
  | 'note_generation'
  | 'section_rewrite'
  | 'question_generation'
  | 'examiner';

export interface LlmStatus {
  providers: Array<{ name: string; configured: boolean }>;
  forced: string | null;
  routing: Array<{
    task: LlmTask;
    configuredModel: string;
    configuredProvider: string;
    effectiveModel: string | null;
    effectiveProvider: string | null;
    chain: string[];
    available: boolean;
    substituted: boolean;
  }>;
  caps: {
    maxTokensPerRun: number;
    monthlyCapGbpPerModule: number;
    maxIterations: number;
  };
  cache: boolean;
  usdToGbp: number;
}

export interface LlmModuleUsage {
  moduleId: string;
  title: string;
  calls: number;
  cachedCalls: number;
  failedCalls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costGbp: number;
  savedGbp: number;
  capGbp: number;
  remainingGbp: number;
}

export interface LlmUsage {
  month: string;
  capGbp: number;
  usdToGbp: number;
  totalGbp: number;
  savedGbp: number;
  calls: number;
  cachedCalls: number;
  unpricedCalls: number;
  modules: LlmModuleUsage[];
  byTask: Array<{ task: string; calls: number; costGbp: number }>;
  recent: Array<{
    createdAt: number;
    task: string;
    provider: string;
    model: string;
    status: string;
    inputTokens: number;
    outputTokens: number;
    costGbp: number | null;
    latencyMs: number | null;
    error: string | null;
  }>;
}

export type ConceptType =
  | 'fact'
  | 'mechanism'
  | 'pathway'
  | 'relationship'
  | 'calculation'
  | 'clinical'
  | 'experimental'
  | 'anatomy';

export interface Concept {
  id: string;
  sectionId: string;
  statement: string;
  type: ConceptType;
  bloomCeiling: string | null;
  difficulty: number | null;
  examinableFlag: boolean;
  emphasisScore: number | null;
  sourceChunkIds: string[] | null;
  examinableEvidence: Array<{
    chunkId: string;
    location: string;
    score: number;
    excerpt: string;
  }> | null;
  createdAt: number;
  embedded: boolean;
  citations: string[];
  ownedElsewhere: {
    conceptId: string;
    sectionId: string;
    sectionNumber: string;
    sectionTitle: string;
    note: string | null;
  } | null;
}

export interface PlausibilityWarning {
  concepts: number;
  sourceChars: number;
  expected: number;
  verdict: 'too_few' | 'too_many';
  message: string;
}

export interface SectionConcepts {
  sectionId: string;
  sourceChars: number;
  sourceChunks: number;
  plausibility: PlausibilityWarning | null;
  concepts: Concept[];
}

export interface ExaminableResult {
  moduleId: string;
  papers: number;
  questions: number;
  conceptsConsidered: number;
  flagged: number;
  alreadyFlagged: number;
  unmeasured: boolean;
}

export interface ConceptJob {
  moduleId: string;
  phase: 'queued' | 'extracting' | 'linking' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  message: string;
  results: Array<{ sectionId: string; kept: number; merged: number; uncited: number }>;
  skipped: Array<{ sectionId: string; sectionPath: string; reason: string }>;
  links?: number;
  costGbp?: number;
  error?: string;
  running?: boolean;
}

export interface Coverage {
  total: number;
  covered: number;
  uncovered: Array<{
    conceptId: string;
    statement: string;
    examinable: boolean;
    score: number;
  }>;
  passes: number;
  hitPassLimit: boolean;
  stoppedEarly: boolean;
  measured: boolean;
}

export interface GenerationResult {
  sectionId: string;
  blocksWritten: number;
  blocksPreserved: number;
  figuresPlaced: number;
  coverage: Coverage;
  snapshotId: string;
  costUsd: number;
}

export type SnapshotReason = 'before_generation' | 'before_restore' | 'manual';

export interface Snapshot {
  id: string;
  moduleId: string;
  sectionId: string | null;
  label: string;
  reason: SnapshotReason;
  blockCount: number;
  seq: number;
  createdAt: number;
}

export interface RestorePreview {
  removed: number;
  removedUserWritten: number;
  removedLocked: number;
  changed: number;
  restored: number;
}

export interface LlmTestResult {
  ok: boolean;
  provider?: string;
  model?: string;
  text?: string;
  costGbp?: number | null;
  error?: string;
}

const BACKEND_UNREACHABLE =
  'Cannot reach the Processor server. Check the terminal running `npm run dev` — ' +
  'the server half should say "Server listening at http://127.0.0.1:5174".';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // The JSON content-type is only correct when there is actually a JSON body.
  // Sending it with an empty body makes Fastify reject the request outright,
  // which silently breaks every bodyless POST such as ingest.
  const isJsonBody = init?.body !== undefined && !(init.body instanceof FormData);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: isJsonBody
        ? { 'content-type': 'application/json', ...init?.headers }
        : init?.headers,
    });
  } catch {
    // fetch only rejects when the request never got a response at all.
    throw new ApiError(BACKEND_UNREACHABLE, 0);
  }

  if (!response.ok) {
    // Surface the server's own message where there is one; it is written for
    // a human and is more useful than the status text.
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // A non-JSON error body from an /api path means nothing on the other end
      // parsed the request — in dev that is the Vite proxy reporting that it
      // could not reach Fastify. Saying so beats "Internal Server Error",
      // which sends you looking for a bug in the wrong process.
      if (response.status >= 500) message = BACKEND_UNREACHABLE;
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export type QuestionFormat = 'mcq' | 'saq' | 'essay' | 'data_interp' | 'calculation' | 'ema';

export interface McqOption {
  text: string;
  correct: boolean;
  whyWrong?: string;
}

export interface Question {
  id: string;
  moduleId: string;
  blueprintJson: Record<string, unknown> | null;
  conceptIds: string[] | null;
  sectionIds: string[] | null;
  format: QuestionFormat;
  stem: string;
  optionsJson: McqOption[] | null;
  correctAnswer: string | null;
  workedAnswer: string | null;
  markScheme: string | null;
  figureId: string | null;
  bloomLevel: string | null;
  difficultyEst: number | null;
  source: 'generated' | 'past_paper';
  timesServed: number;
  timesCorrect: number;
  criticScore: number | null;
  createdAt: number;
  sectionPaths: string[];
  accuracy: number | null;
}

export interface QuestionBank {
  questions: Question[];
  /** Set-level properties no single question can show. */
  answerKeys: { distribution: number[]; longestRun: number; counted: number };
}

export interface QuestionJob {
  moduleId: string;
  phase: 'queued' | 'generating' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  message: string;
  startedAt: number;
  finishedAt?: number;
  costGbp?: number;
  error?: string;
  result?: {
    accepted: number;
    requested: number;
    rejected: Array<{ stem: string; reason: string; detail?: string }>;
    blueprintsResampled: number;
    admittedWithoutEmbeddings: number;
    stoppedBecause: 'asked_for' | 'ran_out_of_blueprints' | 'cancelled';
  };
}

/** A question as practice serves it — deliberately without the answer. */
export interface PracticeQuestion {
  id: string;
  format: QuestionFormat;
  stem: string;
  bloomLevel: string | null;
  figureId: string | null;
  sectionPaths: string[];
  options: string[];
}

export interface AttemptResult {
  attemptId: string;
  correct: boolean | null;
  marked: boolean;
  correctIndex: number | null;
  options: McqOption[] | null;
  correctAnswer: string | null;
  workedAnswer: string | null;
  markScheme: string | null;
  confidentlyWrong: boolean;
  conceptIds: string[];
}

// ---------------------------------------------------------------------------
// Revision — §8
// ---------------------------------------------------------------------------

export interface SectionMastery {
  sectionId: string;
  sectionPath: string;
  concepts: number;
  reviewed: number;
  mastery: number;
  due: number;
  confidentlyWrong: number;
  /** This section plus everything beneath it. */
  subtree: {
    concepts: number;
    reviewed: number;
    mastery: number;
    due: number;
    confidentlyWrong: number;
  };
}

export interface Misconception {
  conceptId: string;
  sectionId: string;
  sectionPath: string;
  statement: string;
  confidentlyWrong: number;
  lapses: number;
}

export interface RevisionSummary {
  moduleId: string;
  sections: SectionMastery[];
  due: number;
  dueNew: number;
  dueOverdue: number;
  concepts: number;
  reviewed: number;
  mastery: number;
  misconceptions: Misconception[];
}

export interface DueConcept {
  conceptId: string;
  sectionId: string;
  statement: string;
  dueDate: number | null;
  isNew: boolean;
  stability: number | null;
  lapses: number;
  confidentlyWrong: number;
}

export const api = {
  health: () => request<Health>('/api/health'),

  listModules: () => request<Module[]>('/api/modules'),
  getModule: (id: string) => request<Module & { sections: SectionNode[] }>(`/api/modules/${id}`),
  createModule: (body: { title: string; code?: string; year?: number }) =>
    request<Module>('/api/modules', { method: 'POST', body: JSON.stringify(body) }),
  deleteModule: (id: string) => request<void>(`/api/modules/${id}`, { method: 'DELETE' }),
  /** The export is a file download, so it goes through the browser directly. */
  exportModuleUrl: (id: string) => `/api/modules/${id}/export`,
  importModule: (form: FormData) =>
    request<{
      moduleId: string;
      title: string;
      sections: number;
      sources: number;
      chunks: number;
      noteBlocks: number;
      missingFiles: string[];
      remapped: boolean;
    }>('/api/modules/import', { method: 'POST', body: form }),

  getSections: (moduleId: string) => request<SectionNode[]>(`/api/modules/${moduleId}/sections`),
  replaceTree: (moduleId: string, tree: unknown[]) =>
    request<SectionNode[]>(`/api/modules/${moduleId}/sections`, {
      method: 'PUT',
      body: JSON.stringify({ tree }),
    }),
  createSection: (body: { moduleId: string; title: string; parentId?: string | null }) =>
    request<SectionNode>('/api/sections', { method: 'POST', body: JSON.stringify(body) }),
  getSection: (id: string) =>
    request<SectionNode & { number: string }>(`/api/sections/${id}`),
  updateSection: (id: string, body: { title?: string; status?: SectionStatus }) =>
    request<SectionNode>(`/api/sections/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  moveSection: (id: string, parentId: string | null, position: number) =>
    request<SectionNode[]>(`/api/sections/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ parentId, position }),
    }),
  deleteSection: (id: string) => request<void>(`/api/sections/${id}`, { method: 'DELETE' }),

  listSources: (moduleId: string) => request<Source[]>(`/api/modules/${moduleId}/sources`),
  getSource: (id: string) => request<SourceDetail>(`/api/sources/${id}`),
  uploadSource: (moduleId: string, form: FormData) =>
    request<Source>(`/api/modules/${moduleId}/sources`, { method: 'POST', body: form }),
  /** Starts ingestion and returns immediately; follow it with ingestStatus. */
  ingestSource: (id: string) => request<IngestJob>(`/api/sources/${id}/ingest`, { method: 'POST' }),
  ingestStatus: (id: string) => request<IngestJob>(`/api/sources/${id}/ingest`),
  cancelIngest: (id: string) =>
    request<{ cancelling: boolean }>(`/api/sources/${id}/ingest`, { method: 'DELETE' }),
  getChunks: (id: string) => request<Chunk[]>(`/api/sources/${id}/chunks`),
  setSourceSections: (id: string, sectionIds: string[]) =>
    request<SectionMapping[]>(`/api/sources/${id}/sections`, {
      method: 'PUT',
      body: JSON.stringify({ sectionIds }),
    }),
  deleteSource: (id: string) => request<void>(`/api/sources/${id}`, { method: 'DELETE' }),

  getSectionFigures: (sectionId: string) =>
    request<Figure[]>(`/api/sections/${sectionId}/figures`),

  getNotes: (sectionId: string) => request<NoteBlock[]>(`/api/sections/${sectionId}/notes`),
  createNote: (
    sectionId: string,
    body: {
      id?: string;
      type?: NoteBlockType;
      markdown?: string;
      position?: number;
      figureId?: string | null;
      targetSectionId?: string | null;
    },
  ) =>
    request<NoteBlock>(`/api/sections/${sectionId}/notes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateNote: (
    id: string,
    body: {
      markdown?: string;
      type?: NoteBlockType;
      locked?: boolean;
      figureId?: string | null;
      targetSectionId?: string | null;
    },
  ) => request<NoteBlock>(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  reorderNotes: (sectionId: string, orderedIds: string[]) =>
    request<NoteBlock[]>(`/api/sections/${sectionId}/notes/order`, {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),

  search: (params: { q: string; moduleId?: string; kinds?: string; limit?: number }) => {
    const query = new URLSearchParams({ q: params.q });
    if (params.moduleId) query.set('moduleId', params.moduleId);
    if (params.kinds) query.set('kinds', params.kinds);
    if (params.limit) query.set('limit', String(params.limit));
    return request<SearchHit[]>(`/api/search?${query}`);
  },

  backfillEmbeddings: () =>
    request<{
      chunks: { pending: number; embedded: number };
      noteBlocks: { pending: number; embedded: number };
    }>('/api/embeddings/backfill', { method: 'POST', body: JSON.stringify({}) }),

  generateNotes: (sectionId: string, body: { fresh?: boolean } = {}) =>
    request<GenerationResult>(`/api/sections/${sectionId}/notes/generate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getConcepts: (sectionId: string) =>
    request<SectionConcepts>(`/api/sections/${sectionId}/concepts`),
  extractConcepts: (moduleId: string, body: { sectionIds?: string[]; fresh?: boolean } = {}) =>
    request<ConceptJob>(`/api/modules/${moduleId}/concepts/extract`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getConceptJob: (moduleId: string) =>
    request<ConceptJob>(`/api/modules/${moduleId}/concepts/job`),
  cancelExtraction: (moduleId: string) =>
    request<{ cancelled: boolean }>(`/api/modules/${moduleId}/concepts/cancel`, {
      method: 'POST',
    }),
  updateConcept: (
    id: string,
    body: { statement?: string; type?: ConceptType; examinableFlag?: boolean },
  ) => request<Concept>(`/api/concepts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteConcept: (id: string) => request<void>(`/api/concepts/${id}`, { method: 'DELETE' }),
  markExaminable: (moduleId: string) =>
    request<ExaminableResult>(`/api/modules/${moduleId}/concepts/examinable`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getConceptSources: (id: string) =>
    request<Array<{ id: string; text: string; location: string }>>(
      `/api/concepts/${id}/sources`,
    ),

  listSnapshots: (moduleId: string) => request<Snapshot[]>(`/api/modules/${moduleId}/snapshots`),
  takeSnapshot: (moduleId: string, body: { sectionId?: string; label?: string } = {}) =>
    request<Snapshot>(`/api/modules/${moduleId}/snapshots`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  previewRestore: (id: string) => request<RestorePreview>(`/api/snapshots/${id}/preview`),
  restoreSnapshot: (id: string) =>
    request<{ moduleId: string; sectionId: string | null; blocks: number; undoSnapshotId: string }>(
      `/api/snapshots/${id}/restore`,
      { method: 'POST' },
    ),
  deleteSnapshot: (id: string) => request<void>(`/api/snapshots/${id}`, { method: 'DELETE' }),

  listQuestions: (
    moduleId: string,
    query: { sectionId?: string; format?: string; source?: string } = {},
  ) => {
    const params = new URLSearchParams(
      Object.entries(query).filter(([, value]) => Boolean(value)) as [string, string][],
    );
    const suffix = params.toString() ? `?${params}` : '';
    return request<QuestionBank>(`/api/modules/${moduleId}/questions${suffix}`);
  },
  generateQuestions: (
    moduleId: string,
    body: { count: number; sectionIds?: string[]; skipExaminer?: boolean },
  ) =>
    request<QuestionJob>(`/api/modules/${moduleId}/questions/generate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getQuestionJob: (moduleId: string) =>
    request<QuestionJob>(`/api/modules/${moduleId}/questions/job`),
  cancelQuestions: (moduleId: string) =>
    request<{ cancelling: boolean }>(`/api/modules/${moduleId}/questions/cancel`, {
      method: 'POST',
    }),
  deleteQuestion: (id: string) => request<void>(`/api/questions/${id}`, { method: 'DELETE' }),

  getPractice: (moduleId: string, query: { count?: number; sectionId?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.count) params.set('count', String(query.count));
    if (query.sectionId) params.set('sectionId', query.sectionId);
    const suffix = params.toString() ? `?${params}` : '';
    return request<{ questions: PracticeQuestion[] }>(
      `/api/modules/${moduleId}/practice${suffix}`,
    );
  },
  submitAttempt: (
    questionId: string,
    body: { optionIndex?: number; text?: string; confidence?: number; secondsTaken?: number },
  ) =>
    request<AttemptResult>(`/api/questions/${questionId}/attempt`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  markAttempt: (attemptId: string, correct: boolean) =>
    request<{ attemptId: string; correct: boolean; conceptIds: string[] }>(
      `/api/attempts/${attemptId}/mark`,
      { method: 'POST', body: JSON.stringify({ correct }) },
    ),

  getRevision: (moduleId: string) =>
    request<RevisionSummary>(`/api/modules/${moduleId}/revision`),
  getDue: (moduleId: string, limit = 100) =>
    request<{ concepts: DueConcept[] }>(`/api/modules/${moduleId}/due?limit=${limit}`),

  llmStatus: () => request<LlmStatus>('/api/llm/status'),
  llmUsage: () => request<LlmUsage>('/api/llm/usage'),
  llmTest: () => request<LlmTestResult>('/api/llm/test', { method: 'POST' }),
  clearLlmCache: () =>
    request<{ cleared: number }>('/api/llm/cache/clear', { method: 'POST' }),
};

/** Flatten a section tree into display order. */
export function flattenSections(nodes: SectionNode[]): SectionNode[] {
  return nodes.flatMap((node) => [node, ...flattenSections(node.children)]);
}
