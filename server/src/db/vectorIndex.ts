/**
 * Nearest-neighbour search over stored embeddings.
 *
 * Two backends behind one interface. sqlite-vec is the default and does the
 * work in C; the brute-force path scans the entity table in JS. At the scale of
 * one degree's material the difference is milliseconds, so the fallback is a
 * genuine option rather than a broken mode — which matters, because the
 * extension is a native binary that will not load everywhere.
 */
import { getSqlite, isVecAvailable, type VecKind } from './index.js';
import { cosine, fromBlob, toBlob } from '../lib/vector.js';

export interface Neighbour {
  entityId: string;
  /** Cosine similarity in [-1, 1]. Higher is closer, for both backends. */
  score: number;
}

/** Entity table and id column backing each vector kind. */
const ENTITY_TABLE: Record<VecKind, string> = {
  chunk: 'chunks',
  figure: 'figures',
  concept: 'concepts',
  note_block: 'note_blocks',
  question: 'questions',
};

function rowidFor(kind: VecKind, entityId: string, create: boolean): bigint | null {
  const conn = getSqlite();
  const existing = conn
    .prepare('select rowid from vec_map where kind = ? and entity_id = ?')
    .get(kind, entityId) as { rowid: number } | undefined;
  if (existing) return BigInt(existing.rowid);
  if (!create) return null;
  const result = conn
    .prepare('insert into vec_map (kind, entity_id) values (?, ?)')
    .run(kind, entityId);
  return BigInt(result.lastInsertRowid);
}

/**
 * Write an embedding into the KNN index. The vector is also stored on the
 * entity row itself by the caller — that column is the source of truth, and
 * this index is a derived structure that can be rebuilt from it.
 */
export function indexVector(kind: VecKind, entityId: string, vec: Float32Array): void {
  if (!isVecAvailable()) return;
  const conn = getSqlite();
  const rowid = rowidFor(kind, entityId, true)!;
  const blob = toBlob(vec);
  // vec0 tables have no upsert, so replace explicitly.
  conn.prepare(`delete from vec_${kind}s where rowid = ?`).run(rowid);
  conn.prepare(`insert into vec_${kind}s (rowid, embedding) values (?, ?)`).run(rowid, blob);
}

export function removeVector(kind: VecKind, entityId: string): void {
  if (!isVecAvailable()) return;
  const conn = getSqlite();
  const rowid = rowidFor(kind, entityId, false);
  if (rowid === null) return;
  conn.prepare(`delete from vec_${kind}s where rowid = ?`).run(rowid);
  conn.prepare('delete from vec_map where rowid = ?').run(rowid);
}

export interface SearchOptions {
  limit?: number;
  /** Restrict the candidate set, e.g. to one module's chunks. */
  entityIds?: string[];
  /** Drop anything below this cosine similarity. */
  minScore?: number;
}

export function searchVectors(
  kind: VecKind,
  query: Float32Array,
  options: SearchOptions = {},
): Neighbour[] {
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? -1;
  const allowed = options.entityIds ? new Set(options.entityIds) : null;
  if (allowed && allowed.size === 0) return [];

  const results = isVecAvailable()
    ? searchWithVec(kind, query, limit, allowed)
    : searchBruteForce(kind, query, limit, allowed);

  return results.filter((r) => r.score >= minScore).slice(0, limit);
}

function searchWithVec(
  kind: VecKind,
  query: Float32Array,
  limit: number,
  allowed: Set<string> | null,
): Neighbour[] {
  const conn = getSqlite();
  // Over-fetch when filtering, since the KNN scan itself cannot see the filter.
  const k = allowed ? Math.max(limit * 4, Math.min(allowed.size, 500)) : limit;
  const rows = conn
    .prepare(
      `select v.rowid as rowid, v.distance as distance, m.entity_id as entityId
         from vec_${kind}s v
         join vec_map m on m.rowid = v.rowid
        where v.embedding match ? and k = ?`,
    )
    .all(toBlob(query), k) as Array<{ rowid: number; distance: number; entityId: string }>;

  const out: Neighbour[] = [];
  for (const row of rows) {
    if (allowed && !allowed.has(row.entityId)) continue;
    // vec0 reports L2 distance. For unit vectors, cos = 1 - d^2 / 2.
    out.push({ entityId: row.entityId, score: 1 - (row.distance * row.distance) / 2 });
  }
  return out;
}

function searchBruteForce(
  kind: VecKind,
  query: Float32Array,
  limit: number,
  allowed: Set<string> | null,
): Neighbour[] {
  const conn = getSqlite();
  const rows = conn
    .prepare(`select id, embedding from ${ENTITY_TABLE[kind]} where embedding is not null`)
    .all() as Array<{ id: string; embedding: Buffer }>;

  const scored: Neighbour[] = [];
  for (const row of rows) {
    if (allowed && !allowed.has(row.id)) continue;
    const vec = fromBlob(row.embedding);
    if (!vec) continue;
    scored.push({ entityId: row.id, score: cosine(query, vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Rebuild the KNN index for one kind from the embeddings already stored on the
 * entity rows. Needed after switching backends, changing model, or restoring a
 * database file that was written without the extension available.
 */
export function reindexKind(kind: VecKind): number {
  if (!isVecAvailable()) return 0;
  const conn = getSqlite();
  const rows = conn
    .prepare(`select id, embedding from ${ENTITY_TABLE[kind]} where embedding is not null`)
    .all() as Array<{ id: string; embedding: Buffer }>;

  let count = 0;
  const run = conn.transaction(() => {
    conn.prepare(`delete from vec_${kind}s`).run();
    for (const row of rows) {
      const vec = fromBlob(row.embedding);
      if (!vec) continue;
      indexVector(kind, row.id, vec);
      count++;
    }
  });
  run();
  return count;
}
