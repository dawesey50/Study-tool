import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { repoRoot } from '../src/config.js';
import { closeDb, getDb, initDb, isVecAvailable, schema } from '../src/db/index.js';
import { indexVector, removeVector, searchVectors } from '../src/db/vectorIndex.js';
import { newId } from '../src/lib/ids.js';
import { cosine, fromBlob, normalise, toBlob } from '../src/lib/vector.js';

let tempDir: string;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-vector-'));
  initDb({
    dbPath: path.join(tempDir, 'test.db'),
    migrationsFolder: path.join(repoRoot, 'server/migrations'),
  });
});

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a vector survives the round trip through a BLOB unchanged', () => {
  const original = Float32Array.from([0.5, -0.25, 0.125, 1]);
  const restored = fromBlob(toBlob(original));

  assert.ok(restored);
  assert.deepEqual(Array.from(restored), Array.from(original));
});

test('fromBlob treats empty and missing blobs as no vector', () => {
  assert.equal(fromBlob(null), null);
  assert.equal(fromBlob(undefined), null);
  assert.equal(fromBlob(Buffer.alloc(0)), null);
});

test('cosine of unit vectors behaves as expected', () => {
  const a = normalise(Float32Array.from([1, 1, 0, 0]));
  const b = normalise(Float32Array.from([1, 1, 0, 0]));
  const orthogonal = normalise(Float32Array.from([0, 0, 1, 0]));

  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6, 'identical vectors score 1');
  assert.ok(Math.abs(cosine(a, orthogonal)) < 1e-6, 'orthogonal vectors score 0');
});

test('normalise produces a unit vector and leaves zero alone', () => {
  const unit = normalise(Float32Array.from([3, 4, 0, 0]));
  const magnitude = Math.sqrt(unit.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-6);

  const zero = normalise(new Float32Array(4));
  assert.deepEqual(Array.from(zero), [0, 0, 0, 0]);
});

/**
 * The index is exercised through the chunks table because both backends read
 * real rows: sqlite-vec through its shadow table, brute force through the
 * entity column. Whichever is active here, the ranking contract is the same.
 */
test('nearest-neighbour search ranks the closest vector first', async (t) => {
  const db = getDb();
  const dim = 384;
  const moduleId = newId();
  const sourceId = newId();

  db.insert(schema.modules).values({ id: moduleId, title: 'Test module' }).run();
  db.insert(schema.sources)
    .values({
      id: sourceId,
      moduleId,
      type: 'slides',
      title: 'Test source',
      filename: 'test.pdf',
      path: 'media/sources/test.pdf',
    })
    .run();

  const make = (first: number, second: number) => {
    const vec = new Float32Array(dim);
    vec[0] = first;
    vec[1] = second;
    return normalise(vec);
  };

  const target = make(1, 0);
  const near = make(0.95, 0.31);
  const far = make(0, 1);

  const ids = { target: newId(), near: newId(), far: newId() };
  for (const [name, vector] of [
    ['target', target],
    ['near', near],
    ['far', far],
  ] as const) {
    db.insert(schema.chunks)
      .values({
        id: ids[name],
        sourceId,
        text: name,
        embedding: toBlob(vector),
        position: 0,
      })
      .run();
    indexVector('chunk', ids[name], vector);
  }

  if (!isVecAvailable()) {
    t.diagnostic('sqlite-vec not loaded; exercising the brute-force backend');
  }

  const results = searchVectors('chunk', target, { limit: 3 });
  assert.equal(results.length, 3);
  assert.equal(results[0]?.entityId, ids.target);
  assert.equal(results[1]?.entityId, ids.near);
  assert.ok((results[0]?.score ?? 0) > (results[2]?.score ?? 1));
  assert.ok(Math.abs((results[0]?.score ?? 0) - 1) < 1e-3, 'an exact match scores about 1');

  // Restricting the candidate set must actually restrict it.
  const restricted = searchVectors('chunk', target, { limit: 3, entityIds: [ids.far] });
  assert.deepEqual(
    restricted.map((r) => r.entityId),
    [ids.far],
  );

  removeVector('chunk', ids.near);
  db.delete(schema.chunks).run();
});
