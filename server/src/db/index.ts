import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as sqliteVec from 'sqlite-vec';
import { config, ensureDirs, repoRoot } from '../config.js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let sqlite: Database.Database | null = null;
let db: Db | null = null;
/** Whether the sqlite-vec extension actually loaded, as opposed to being asked for. */
let vecAvailable = false;

export function isVecAvailable(): boolean {
  return vecAvailable;
}

export function getSqlite(): Database.Database {
  if (!sqlite) throw new Error('Database not initialised — call initDb() first');
  return sqlite;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not initialised — call initDb() first');
  return db;
}

/**
 * The vec0 virtual tables cannot be expressed in Drizzle, so they are created
 * here rather than in a generated migration. Each mirrors an entity table and
 * is addressed by the integer rowid held in vec_map.
 */
const VEC_TABLES = ['chunk', 'figure', 'concept', 'note_block', 'question'] as const;
export type VecKind = (typeof VEC_TABLES)[number];

function createVecTables(conn: Database.Database, dim: number): void {
  for (const kind of VEC_TABLES) {
    conn.exec(
      `create virtual table if not exists vec_${kind}s using vec0(embedding float[${dim}])`,
    );
  }
}

export interface InitOptions {
  /** Override the database file. Used by tests to run against a temp file. */
  dbPath?: string;
  migrationsFolder?: string;
}

export function initDb(options: InitOptions = {}): { db: Db; sqlite: Database.Database } {
  ensureDirs();
  const file = options.dbPath ?? config.dbPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  // A local-first single-user app never has real write contention, but WAL plus
  // a short busy timeout keeps concurrent reads during ingestion from erroring.
  conn.pragma('busy_timeout = 5000');

  if (config.vectorBackend === 'sqlite-vec') {
    try {
      sqliteVec.load(conn);
      createVecTables(conn, config.embeddings.dim);
      vecAvailable = true;
    } catch (error) {
      // Not fatal: search falls back to brute-force cosine, which is fast
      // enough for one person's material.
      console.warn(
        `[db] sqlite-vec unavailable (${(error as Error).message}); ` +
          'falling back to brute-force cosine search.',
      );
      vecAvailable = false;
    }
  }

  const instance = drizzle(conn, { schema });
  migrate(instance, {
    migrationsFolder: options.migrationsFolder ?? path.join(repoRoot, 'server/migrations'),
  });

  sqlite = conn;
  db = instance;
  return { db: instance, sqlite: conn };
}

export function closeDb(): void {
  sqlite?.close();
  sqlite = null;
  db = null;
  vecAvailable = false;
}

export { schema };
