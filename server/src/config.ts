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

  ingest: {
    chunkTargetChars: num('CHUNK_TARGET_CHARS', 1400),
    chunkOverlapChars: num('CHUNK_OVERLAP_CHARS', 180),
    figureMinDimension: num('FIGURE_MIN_DIMENSION', 90),
  },
} as const;

export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.mediaDir, config.embeddings.cacheDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
