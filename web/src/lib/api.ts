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
}

export type IngestPhase = 'queued' | 'parsing' | 'embedding' | 'mapping' | 'done' | 'failed';

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

export const api = {
  health: () => request<Health>('/api/health'),

  listModules: () => request<Module[]>('/api/modules'),
  getModule: (id: string) => request<Module & { sections: SectionNode[] }>(`/api/modules/${id}`),
  createModule: (body: { title: string; code?: string; year?: number }) =>
    request<Module>('/api/modules', { method: 'POST', body: JSON.stringify(body) }),
  deleteModule: (id: string) => request<void>(`/api/modules/${id}`, { method: 'DELETE' }),

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
  createNote: (sectionId: string, body: { type?: NoteBlockType; markdown?: string; position?: number }) =>
    request<NoteBlock>(`/api/sections/${sectionId}/notes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateNote: (
    id: string,
    body: { markdown?: string; type?: NoteBlockType; locked?: boolean },
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
};

/** Flatten a section tree into display order. */
export function flattenSections(nodes: SectionNode[]): SectionNode[] {
  return nodes.flatMap((node) => [node, ...flattenSections(node.children)]);
}
