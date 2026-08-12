import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

/**
 * Filesystem-safe version of a title, for generated filenames.
 * NFKD splits accented letters into base + combining mark, and the
 * alphanumeric filter then drops the mark, so "Bézier" becomes "bezier".
 */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}
