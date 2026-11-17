import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDbsonl, createMemoryBackend } from 'defuss-dbsonl';
import type { Backend, Dbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
import { createDbsonlSource } from './dbsonl.js';
import type { DbsonlRecord } from './dbsonl.js';
import { estimateRowBytes, evaluateStream, streamQuery } from '../stream.js';
import type { StreamOptions, StreamRequest } from '../stream.js';

type Doc = { title: string; score: number; meta?: { rank?: unknown } } | number | null;
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const backends: Array<[string, () => Promise<Backend>]> = [
  ['memory', async () => createMemoryBackend()],
  ['native', async () => { const dir = await mkdtemp(join(tmpdir(), 'dataview-projection-')); directories.push(dir); return createFileBackend(dir); }],
];
// Mixed shapes: missing, primitive and nested fields must resolve exactly as on the stored rows.
const doc = (n: number): Doc => n % 97 === 0 ? n : n % 89 === 0 ? null
  : { title: `doc ${n}`, score: (n * 7919) % 100, ...(n % 3 ? { meta: n % 5 ? { rank: n % 7 } : { rank: `r${n % 4}` } } : {}) };
async function seed(backend: Backend, rows = 2000): Promise<Dbsonl<Doc>> {
  const db = await openDbsonl<Doc>(backend, 'projection', { create: true });
  for (let start = 0; start < rows; start += 500) await db.batch(Array.from({ length: Math.min(500, rows - start) }, (_, i) => ({ operation: 'put' as const, key: `k${String(start + i).padStart(5, '0')}`, value: doc(start + i) })));
  return db;
}
/** Counts native scans, so a test can tell the projection from a full decode. */
function counting<T>(db: Dbsonl<T>) {
  const counter = { scans: 0 };
  const beginRead = db.beginRead.bind(db);
  return { counter, database: { async beginRead() {
    const snapshot = await beginRead(), scanBatches = snapshot.scanBatches.bind(snapshot);
    return Object.defineProperty(snapshot, 'scanBatches', { value: (...args: Parameters<typeof scanBatches>) => { counter.scans++; return scanBatches(...args); } });
  } } };
}
const queries: Array<[string, StreamRequest, StreamOptions<DbsonlRecord<Doc>>]> = [
  ['top-k with exact count', { filters: [{ field: 'value.score', op: 'gte', value: 50 }], sorters: [{ field: 'value.score', direction: 'desc' }, { field: 'key' }], limit: 25 }, { count: 'exact' }],
  ['offset page', { sorters: [{ field: 'value.score' }], offset: 40, limit: 10 }, {}],
  ['nested and mixed values', { filters: [{ field: 'value.meta.rank', op: 'in', value: [1, 3, 'r2'] }], sorters: [{ field: 'value.meta.rank', direction: 'desc' }], limit: 30 }, { count: 'exact' }],
  ['filter only, in key order', { filters: [{ field: 'value.meta.rank', op: 'gte', value: 5 }], limit: 20 }, { count: 'exact' }],
  ['count only', { filters: [{ field: 'value.score', op: 'lt', value: 10 }], limit: 0 }, { count: 'exact' }],
];
const comparable = (result: Awaited<ReturnType<typeof evaluateStream>>) => ({ rows: result.rows, ...result.summary, peakBufferedRows: 0, peakBufferedBytes: 0 });

for (const [name, makeBackend] of backends) describe(`DBSONL projection on ${name} storage`, () => {
  it('answers repeated pages from the projection with the same rows and summary as a full scan', async () => {
    const db = await seed(await makeBackend());
    try {
      const { counter, database } = counting(db);
      const plain = createDbsonlSource(db), projected = createDbsonlSource(database, { projection: { fields: ['value.score', 'value.meta', 'value.meta.rank'] } });
      expect(projected.projected).toBeUndefined();
      for (const [label, request, options] of queries) {
        const expected = comparable(await evaluateStream(plain, request, options));
        const cold = comparable(await evaluateStream(projected, request, options));
        const scans = counter.scans;
        const warm = comparable(await evaluateStream(projected, request, options));
        expect(cold, label).toEqual(expected);
        expect(warm, label).toEqual(expected);
        expect(counter.scans, `${label} decoded every document again`).toBe(scans);
      }
      expect(projected.projected).toMatchObject({ revision: 4, rows: 2000 });
    } finally { await db.close(); }
  });

  it('scans again after a write and keeps the new revision', async () => {
    const db = await seed(await makeBackend());
    try {
      const { counter, database } = counting(db);
      const source = createDbsonlSource(database, { projection: { fields: ['value.score'] } });
      const top = { filters: [{ field: 'value.score', op: 'gte' as const, value: 0 }], sorters: [{ field: 'value.score', direction: 'desc' as const }, { field: 'key' }], limit: 3 };
      expect(await source.prepare()).toMatchObject({ revision: 4, rows: 2000 });
      await db.put('k00007', { title: 'new', score: 1000 });
      const scans = counter.scans;
      const result = await evaluateStream(source, top);
      expect(counter.scans).toBe(scans + 1);
      expect(result.rows[0]).toEqual({ key: 'k00007', revision: 5, value: { title: 'new', score: 1000 } });
      expect(source.projected?.revision).toBe(5);
      expect(comparable(await evaluateStream(source, top))).toEqual(comparable(await evaluateStream(createDbsonlSource(db), top)));
      expect(counter.scans).toBe(scans + 1);
    } finally { await db.close(); }
  });
});

describe('DBSONL projection boundaries', () => {
  it('scans for unprojected fields, large pages, custom estimators and scopes over the byte cap', async () => {
    const db = await seed(createMemoryBackend());
    try {
      const { counter, database } = counting(db);
      const source = createDbsonlSource(database, { projection: { fields: ['value.score'] } });
      await source.prepare();
      const cases: Array<[StreamRequest, StreamOptions<DbsonlRecord<Doc>>]> = [
        [{ filters: [{ field: 'value.title', op: 'eq', value: 'doc 5' }], limit: 1 }, { count: 'exact' }],
        [{ sorters: [{ field: 'value.score' }], limit: 200 }, {}],
        [{ sorters: [{ field: 'value.score' }], limit: 5 }, { sizeOf: () => 64 }],
      ];
      for (const [request, options] of cases) {
        const scans = counter.scans;
        expect(comparable(await evaluateStream(source, request, options))).toEqual(comparable(await evaluateStream(createDbsonlSource(db), request, options)));
        expect(counter.scans).toBe(scans + 1);
      }
      const tight = createDbsonlSource(db, { projection: { fields: ['value.score'], maxBytes: 1000 } });
      expect(await tight.prepare()).toBeUndefined();
      expect(await createDbsonlSource(db).prepare()).toBeUndefined();
    } finally { await db.close(); }
  });

  it('re-measures the stored rows it returns and splits them under the batch byte budget', async () => {
    const db = await openDbsonl<{ score: number; body: string }>(createMemoryBackend(), 'wide', { create: true });
    try {
      await db.batch(Array.from({ length: 400 }, (_, n) => ({ operation: 'put' as const, key: `k${String(n).padStart(3, '0')}`, value: { score: n, body: 'x'.repeat(900) } })));
      const source = createDbsonlSource(db, { projection: { fields: ['value.score'] } });
      await source.prepare();
      const request = { sorters: [{ field: 'value.score', direction: 'desc' as const }], limit: 20 }, options = { maxBatchBytes: 4000 };
      const batches: Array<readonly DbsonlRecord<{ score: number; body: string }>[]> = [];
      for await (const event of streamQuery(source, request, options)) if (event.type === 'batch') batches.push(event.rows);
      expect(batches.flat().map(row => row.value.score)).toEqual(Array.from({ length: 20 }, (_, i) => 399 - i));
      expect(batches.length).toBeGreaterThan(1);
      for (const batch of batches) expect(batch.reduce((sum, row) => sum + estimateRowBytes(row), 0)).toBeLessThanOrEqual(4000);
      await expect(evaluateStream(source, request, { maxRowBytes: 500 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    } finally { await db.close(); }
  });

  it('rejects invalid projection options', () => {
    const db = { async beginRead(): Promise<never> { throw Error('not opened'); } };
    expect(() => createDbsonlSource(db, { projection: { fields: [] } })).toThrow(TypeError);
    expect(() => createDbsonlSource(db, { projection: { fields: ['value.__proto__'] } })).toThrow(TypeError);
    expect(() => createDbsonlSource(db, { projection: { fields: ['value.a'], maxBytes: -1 } })).toThrow();
  });
});
