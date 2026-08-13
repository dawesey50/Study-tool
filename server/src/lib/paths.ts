import path from 'node:path';
import { config } from '../config.js';

/**
 * Paths stored in the database are relative to DATA_DIR and always use forward
 * slashes, whatever the host platform.
 *
 * That matters because the whole point of this design is that `data/` is a
 * portable folder you can back up and move. If Windows wrote
 * `media\figures\x.png` into the database, the same file would be unreachable
 * after copying the folder to a Mac or a Linux box — the backslashes would be
 * read as part of the filename. Normalising on write and resolving on read
 * keeps the database honest on every platform.
 */

/** Absolute path on this machine → the portable form stored in the database. */
export function toStoredPath(absolutePath: string): string {
  return path.relative(config.dataDir, absolutePath).split(path.sep).join('/');
}

/** Build a stored path from segments, without touching the filesystem. */
export function storedPath(...segments: string[]): string {
  return segments.join('/');
}

/** Stored path → an absolute path usable on this machine. */
export function fromStoredPath(stored: string): string {
  // Split on either separator, so a database written by an older build or on
  // another platform still resolves.
  return path.resolve(config.dataDir, ...stored.split(/[\\/]+/).filter(Boolean));
}

/**
 * Stored path → the URL the frontend requests. Media is served from
 * DATA_DIR/media under the /media prefix, so the `media/` segment is dropped.
 */
export function toMediaUrl(stored: string): string {
  const normalised = stored.split(/[\\/]+/).filter(Boolean).join('/');
  return `/media/${normalised.replace(/^media\//, '')}`;
}
