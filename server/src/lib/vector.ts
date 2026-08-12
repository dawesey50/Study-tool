/**
 * Embeddings are stored as raw little-endian float32 BLOBs. Same bytes the
 * sqlite-vec extension expects, so a vector can go straight from a table column
 * into a KNN query without a conversion step.
 */

export function toBlob(vec: Float32Array | number[]): Buffer {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function fromBlob(blob: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!blob || blob.byteLength === 0) return null;
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/**
 * Assumes both vectors are unit length, which every embedding provider here
 * guarantees, so the dot product is the cosine similarity.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function normalise(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / magnitude;
  return out;
}
