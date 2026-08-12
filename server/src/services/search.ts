import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { searchVectors } from '../db/vectorIndex.js';
import { embedSafely } from '../embeddings/index.js';
import { flatten, getTree } from './sections.js';

/**
 * Global search across chunks, note blocks, figures and section titles.
 *
 * Semantic and keyword search fail in opposite directions — one misses exact
 * terms like "Na+/K+ ATPase", the other misses paraphrase — so both run and the
 * results are merged. When embeddings are unavailable the keyword half still
 * works on its own, which is the difference between degraded search and none.
 */

export type SearchKind = 'chunk' | 'note_block' | 'figure' | 'section';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string;
  score: number;
  moduleId: string;
  sectionId?: string;
  sourceId?: string;
  /** Human-readable provenance, e.g. "Slides L07 p.14". */
  location?: string;
}

export interface SearchOptions {
  moduleId?: string;
  kinds?: SearchKind[];
  limit?: number;
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const text = query.trim();
  if (!text) return [];

  const limit = options.limit ?? 30;
  const kinds = new Set<SearchKind>(options.kinds ?? ['chunk', 'note_block', 'figure', 'section']);
  const [vector] = await embedSafely([text]);

  const merged = new Map<string, SearchHit>();
  const add = (hit: SearchHit) => {
    const key = `${hit.kind}:${hit.id}`;
    const existing = merged.get(key);
    // A result found by both halves is a stronger result than one found by either.
    if (existing) existing.score = Math.max(existing.score, hit.score) + 0.05;
    else merged.set(key, hit);
  };

  for (const hit of keywordSearch(text, kinds, options.moduleId, limit)) add(hit);
  if (vector) {
    for (const hit of semanticSearch(vector, kinds, options.moduleId, limit)) add(hit);
  }

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------

function keywordSearch(
  query: string,
  kinds: Set<SearchKind>,
  moduleId: string | undefined,
  limit: number,
): SearchHit[] {
  const conn = getDb().$client;
  const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const hits: SearchHit[] = [];

  if (kinds.has('chunk')) {
    const rows = conn
      .prepare(
        `select c.id, c.text, c.page_no as pageNo, c.slide_no as slideNo, c.timestamp,
                s.id as sourceId, s.title as sourceTitle, s.type as sourceType, s.module_id as moduleId
           from chunks c join sources s on s.id = c.source_id
          where c.text like ? escape '\\' ${moduleId ? 'and s.module_id = ?' : ''}
          limit ?`,
      )
      .all(...[like, ...(moduleId ? [moduleId] : []), limit]) as ChunkRow[];

    for (const row of rows) {
      hits.push({
        kind: 'chunk',
        id: row.id,
        title: row.sourceTitle,
        snippet: snippetAround(row.text, query),
        score: 0.6,
        moduleId: row.moduleId,
        sourceId: row.sourceId,
        location: describeLocation(row),
      });
    }
  }

  if (kinds.has('note_block')) {
    const rows = conn
      .prepare(
        `select n.id, n.markdown, n.section_id as sectionId, sec.title as sectionTitle,
                sec.module_id as moduleId
           from note_blocks n join sections sec on sec.id = n.section_id
          where n.markdown like ? escape '\\' ${moduleId ? 'and sec.module_id = ?' : ''}
          limit ?`,
      )
      .all(...[like, ...(moduleId ? [moduleId] : []), limit]) as NoteRow[];

    for (const row of rows) {
      hits.push({
        kind: 'note_block',
        id: row.id,
        title: row.sectionTitle,
        snippet: snippetAround(row.markdown, query),
        score: 0.7,
        moduleId: row.moduleId,
        sectionId: row.sectionId,
      });
    }
  }

  if (kinds.has('figure')) {
    const rows = conn
      .prepare(
        `select f.id, f.path, f.page_no as pageNo, f.caption_extracted as captionExtracted,
                f.caption_ai as captionAi, s.title as sourceTitle, s.id as sourceId,
                s.module_id as moduleId
           from figures f join sources s on s.id = f.source_id
          where (coalesce(f.caption_extracted,'') || ' ' || coalesce(f.caption_ai,''))
                like ? escape '\\' ${moduleId ? 'and s.module_id = ?' : ''}
          limit ?`,
      )
      .all(...[like, ...(moduleId ? [moduleId] : []), limit]) as FigureRow[];

    for (const row of rows) {
      hits.push({
        kind: 'figure',
        id: row.id,
        title: row.captionExtracted ?? row.captionAi ?? 'Figure',
        snippet: row.captionExtracted ?? row.captionAi ?? '',
        score: 0.5,
        moduleId: row.moduleId,
        sourceId: row.sourceId,
        location: row.pageNo ? `${row.sourceTitle} p.${row.pageNo}` : row.sourceTitle,
      });
    }
  }

  if (kinds.has('section')) {
    const rows = conn
      .prepare(
        `select id, title, module_id as moduleId from sections
          where title like ? escape '\\' ${moduleId ? 'and module_id = ?' : ''} limit ?`,
      )
      .all(...[like, ...(moduleId ? [moduleId] : []), limit]) as SectionRow[];

    const numbers = sectionNumbers(rows.map((r) => r.moduleId));
    for (const row of rows) {
      hits.push({
        kind: 'section',
        id: row.id,
        title: row.title,
        snippet: '',
        score: 0.8,
        moduleId: row.moduleId,
        sectionId: row.id,
        location: numbers.get(row.id),
      });
    }
  }

  return hits;
}

function semanticSearch(
  vector: Float32Array,
  kinds: Set<SearchKind>,
  moduleId: string | undefined,
  limit: number,
): SearchHit[] {
  const db = getDb();
  const hits: SearchHit[] = [];

  if (kinds.has('chunk')) {
    const neighbours = searchVectors('chunk', vector, { limit, minScore: 0.2 });
    if (neighbours.length) {
      const rows = db
        .select({
          id: schema.chunks.id,
          text: schema.chunks.text,
          pageNo: schema.chunks.pageNo,
          slideNo: schema.chunks.slideNo,
          timestamp: schema.chunks.timestamp,
          sourceId: schema.sources.id,
          sourceTitle: schema.sources.title,
          sourceType: schema.sources.type,
          moduleId: schema.sources.moduleId,
        })
        .from(schema.chunks)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.chunks.sourceId))
        .where(
          inArray(
            schema.chunks.id,
            neighbours.map((n) => n.entityId),
          ),
        )
        .all();

      const scores = new Map(neighbours.map((n) => [n.entityId, n.score]));
      for (const row of rows) {
        if (moduleId && row.moduleId !== moduleId) continue;
        hits.push({
          kind: 'chunk',
          id: row.id,
          title: row.sourceTitle,
          snippet: row.text.slice(0, 260),
          score: scores.get(row.id) ?? 0,
          moduleId: row.moduleId,
          sourceId: row.sourceId,
          location: describeLocation(row),
        });
      }
    }
  }

  if (kinds.has('note_block')) {
    const neighbours = searchVectors('note_block', vector, { limit, minScore: 0.2 });
    if (neighbours.length) {
      const rows = db
        .select({
          id: schema.noteBlocks.id,
          markdown: schema.noteBlocks.markdown,
          sectionId: schema.noteBlocks.sectionId,
          sectionTitle: schema.sections.title,
          moduleId: schema.sections.moduleId,
        })
        .from(schema.noteBlocks)
        .innerJoin(schema.sections, eq(schema.sections.id, schema.noteBlocks.sectionId))
        .where(
          inArray(
            schema.noteBlocks.id,
            neighbours.map((n) => n.entityId),
          ),
        )
        .all();

      const scores = new Map(neighbours.map((n) => [n.entityId, n.score]));
      for (const row of rows) {
        if (moduleId && row.moduleId !== moduleId) continue;
        hits.push({
          kind: 'note_block',
          id: row.id,
          title: row.sectionTitle,
          snippet: row.markdown.slice(0, 260),
          score: scores.get(row.id) ?? 0,
          moduleId: row.moduleId,
          sectionId: row.sectionId,
        });
      }
    }
  }

  return hits;
}

/** "Slides L07 p.14" / "Transcript 34:20" — the citation the notes will show. */
export function describeLocation(row: {
  sourceTitle: string;
  sourceType: string;
  pageNo: number | null;
  slideNo: number | null;
  timestamp: number | null;
}): string {
  if (row.timestamp !== null && row.timestamp !== undefined) {
    return `${row.sourceTitle} ${formatTimestamp(row.timestamp)}`;
  }
  if (row.slideNo) return `${row.sourceTitle} slide ${row.slideNo}`;
  if (row.pageNo) return `${row.sourceTitle} p.${row.pageNo}`;
  return row.sourceTitle;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function snippetAround(text: string, query: string, radius = 120): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function sectionNumbers(moduleIds: string[]): Map<string, string> {
  const numbers = new Map<string, string>();
  for (const moduleId of new Set(moduleIds)) {
    for (const node of flatten(getTree(moduleId))) numbers.set(node.id, node.number);
  }
  return numbers;
}

interface ChunkRow {
  id: string;
  text: string;
  pageNo: number | null;
  slideNo: number | null;
  timestamp: number | null;
  sourceId: string;
  sourceTitle: string;
  sourceType: string;
  moduleId: string;
}
interface NoteRow {
  id: string;
  markdown: string;
  sectionId: string;
  sectionTitle: string;
  moduleId: string;
}
interface FigureRow {
  id: string;
  path: string;
  pageNo: number | null;
  captionExtracted: string | null;
  captionAi: string | null;
  sourceTitle: string;
  sourceId: string;
  moduleId: string;
}
interface SectionRow {
  id: string;
  title: string;
  moduleId: string;
}
