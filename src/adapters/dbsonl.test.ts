import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDbsonl, openDbsonl as openPublished, createMemoryBackend } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
import type { Backend } from 'defuss-dbsonl';
import { createDbsonlSource } from './dbsonl.js';
import { createImmutableArraySource, evaluateStream, streamQuery } from '../stream.js';
import { resolveOptions } from '../stream/common.js';
import { measuredScan } from '../stream/measured.js';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fileBackend(): Promise<Backend> {
  const dir = await mkdtemp(join(tmpdir(), 'dataview-dbsonl-')); directories.push(dir);
  return createFileBackend(dir);
}
// A provider without scanBatches (defuss-dbsonl before 0.6.0, or any row-only database) takes the adapter's
// row-batching fallback; hiding the method on each real snapshot runs that path against the same storage.
const openRowOnly: typeof openPublished = async <T,>(...args: Parameters<typeof openPublished>) => {
  const db = await openPublished<T>(...args), beginRead = db.beginRead.bind(db);
  return Object.assign(db, { beginRead: async () => Object.defineProperty(await beginRead(), 'scanBatches', { value: undefined }) });
};
for (const [name, makeBackend, openDbsonl] of [
  ['memory', async () => createMemoryBackend(), openPublished], ['native', fileBackend, openPublished],
  ['row-only memory', async () => createMemoryBackend(), openRowOnly], ['row-only native', fileBackend, openRowOnly],
] as const) {
  describe(`DBSONL ${name}`, () => {
    it('queries real persisted DSON values, ranges, updates, deletes and reopen', async () => {
      const backend = await makeBackend();
      let db = await openDbsonl<unknown>(backend, 'records', { create: true });
      try {
        await db.batch([
          { operation: 'put', key: 'Z', value: { amount: 100n, at: new Date(100), binary: new Uint8Array([4, 5]) } },
          { operation: 'put', key: 'a', value: { amount: 2n, at: new Date(200), binary: new Uint8Array([6]) } },
          { operation: 'put', key: 'b', value: undefined },
          { operation: 'put', key: 'delete', value: 1 },
        ]);
        await db.delete('delete');
        await db.put('a', { amount: 3n, at: new Date(200), binary: new Uint8Array([6]) });
        await db.close(); db = await openDbsonl(backend, 'records');
        const result = await evaluateStream(createDbsonlSource(db), {
          filters: [{ field: 'value.amount', op: 'gte', value: 0n }], sorters: [{ field: 'value.amount' }], limit: 2,
        }, { count: 'exact', batchSize: 1 });
        expect(result.rows.map(r => r.key)).toEqual(['a', 'Z']);
        expect(result.summary).toMatchObject({ totalMatches: 2, sourceRows: 3, strategy: 'top-k', sourceExhausted: true });
        const bytes = await evaluateStream(createDbsonlSource(db), { filters: [{ field: 'value.binary', op: 'eq', value: new Uint8Array([4, 5]).buffer }] });
        expect(bytes.rows.map(r => r.key)).toEqual(['Z']);
        const dates = await evaluateStream(createDbsonlSource(db), { filters: [{ field: 'value.at', op: 'eq', value: new Date(200) }] });
        expect(dates.rows.map(r => r.key)).toEqual(['a']);
        const ranged = await evaluateStream(createDbsonlSource(db, { gte: 'a', lt: 'c' }), {}, { count: 'exact' });
        expect(ranged.summary.sourceRows).toBe(2);
        expect(ranged.rows).toContainEqual(expect.objectContaining({ key: 'b', value: undefined }));
        expect((await evaluateStream(createDbsonlSource(db, { gte: 'a', lt: 'c' }), { limit: 1 }, { batchSize: 1 })).summary).toMatchObject({ sourceRows: null, totalMatches: null, hasMore: true });
        const ordered = await evaluateStream(createDbsonlSource(db), { sorters: [{ field: 'key' }], limit: 1 }, { batchSize: 1 });
        expect(ordered.rows[0].key).toBe('Z'); expect(ordered.summary.strategy).toBe('ordered');
        expect(ordered.summary.scannedRows).toBe(1);
      } finally { await db.close(); }
    });
    it('pins a stable revision through concurrent writes, compaction and collection, then releases it', async () => {
      const backend = await makeBackend();
      const db = await openDbsonl<{ n: number }>(backend, 'snapshots', { create: true });
      const writer = await openDbsonl<{ n: number }>(backend, 'snapshots');
      try {
        await db.batch(Array.from({ length: 6 }, (_, n) => ({ operation: 'put' as const, key: String(n), value: { n } })));
        const iterator = streamQuery(createDbsonlSource(db), {}, { batchSize: 1 });
        const first = await iterator.next(); expect(first.value).toMatchObject({ rows: [{ key: '0', value: { n: 0 } }] });
        await writer.put('2', { n: 99 }); await writer.delete('3'); await writer.put('new', { n: 100 });
        await writer.compact();
        const pinned = await db.collect(); expect(pinned.retained.length).toBeGreaterThan(0);
        const rest = []; let revision: number | string | bigint | undefined;
        for await (const event of iterator) {
          if (event.type === 'batch') rest.push(...event.rows);
          else revision = event.summary.revision;
        }
        expect(revision).toBe(1);
        expect(rest.find(r => r.key === '2')?.value.n).toBe(2);
        expect(rest.some(r => r.key === '3')).toBe(true);
        expect(rest.some(r => r.key === 'new')).toBe(false);
        const released = await db.collect(); expect(released.removed.length).toBeGreaterThan(0);
        const latest = await evaluateStream(createDbsonlSource(db));
        expect(latest.summary.revision).toBe(4);
        expect(latest.rows.find(r => r.key === '2')?.value.n).toBe(99);
      } finally { await writer.close(); await db.close(); }
    });
    it('releases generation pins after early break and cancellation', async () => {
      const db = await openDbsonl<number>(await makeBackend(), 'cleanup', { create: true });
      try {
        await db.batch(Array.from({ length: 8 }, (_, n) => ({ operation: 'put' as const, key: String(n), value: n })));
        const iterator = streamQuery(createDbsonlSource(db), {}, { batchSize: 1 });
        await iterator.next(); await db.compact(); await iterator.return(undefined);
        expect((await db.collect()).removed.length).toBeGreaterThan(0);
        const controller = new AbortController();
        const cancelled = streamQuery(createDbsonlSource(db), {}, { batchSize: 1, signal: controller.signal });
        await cancelled.next(); await db.compact(); controller.abort();
        await expect(cancelled.next()).rejects.toMatchObject({ code: 'ABORTED' });
        expect((await db.collect()).removed.length).toBeGreaterThan(0);
      } finally { await db.close(); }
    });
  });
}
it('validates DBSONL key ranges and releases cancellation during snapshot acquisition', async () => {
  const db = await openDbsonl(createMemoryBackend(), 'validation', { create: true });
  try {
    expect(() => createDbsonlSource(db, { gte: 'z', lt: 'a' })).toThrow(RangeError);
    expect(() => createDbsonlSource(db, { gte: 'a'.repeat(4097) })).toThrow(TypeError);
    const signal = { aborted: false }; let closed = false;
    const source = createDbsonlSource({ async beginRead() {
      const session = await db.beginRead(); signal.aborted = true;
      return { revision: session.revision, count: session.count, scan: session.scan.bind(session), async close() { closed = true; await session.close(); } };
    } });
    await expect(evaluateStream(source, {}, { signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(closed).toBe(true);
  } finally { await db.close(); }
});

it('measures each decoded DBSONL row once across adapter, executor and collector', async () => {
  const db = await openDbsonl<number>(createMemoryBackend(), 'measured', { create: true });
  try {
    await db.batch(Array.from({ length: 100 }, (_, n) => ({ operation: 'put' as const, key: String(n).padStart(3, '0'), value: n })));
    let calls = 0;
    const result = await evaluateStream(createDbsonlSource(db), { sorters: [{ field: 'value', direction: 'desc' }], limit: 5 }, { sizeOf: () => { calls++; return 100; }, batchSize: 7 });
    expect(calls).toBe(100);
    expect(result.rows.map(r => r.value)).toEqual([99, 98, 97, 96, 95]);
  } finally { await db.close(); }
});

it('keeps the public DBSONL batch protocol usable independently of the executor', async () => {
  const db = await openDbsonl<number>(createMemoryBackend(), 'public-scan', { create: true });
  try {
    await db.put('a', 1); await db.put('b', 2);
    const session = await createDbsonlSource(db).open();
    const request = { batchSize: 1, maxBatchBytes: 1000, maxRowBytes: 1000, sizeOf: () => 100 };
    const iterator = session.scan(request)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual([{ key: 'a', value: 1, revision: 1 }]);
    await iterator.return?.(); await session.close(); await session.close();
    expect(() => session.scan(request)).toThrow('closed');
  } finally { await db.close(); }
});

it('independently validates native batches and closes after structural-provider failures', async () => {
  for (const rows of [[], [null], [{ key: 'a', revision: 1, value: new Uint8Array(2000) }]]) {
    let closed = false, returned = false;
    const source = createDbsonlSource({ async beginRead() { return {
      revision: 1, count: 1,
      scan(): AsyncIterable<never> { throw Error('native capability was ignored'); },
      async *scanBatches() { try { yield rows as never; } finally { returned = true; } },
      async close() { closed = true; },
    }; } });
    await expect(evaluateStream(source, { limit: 1 }, { maxRowBytes: 1000 })).rejects.toThrow();
    expect(returned).toBe(true); expect(closed).toBe(true);
  }
});

it('native batches call sizeOf once per row and yield spans within the byte budget', async () => {
  const db = await openDbsonl<number>(createMemoryBackend(), 'accounting', { create: true });
  try {
    await db.batch(Array.from({ length: 100 }, (_, n) => ({ operation: 'put' as const, key: String(n).padStart(3, '0'), value: n })));
    let calls = 0;
    const session = await createDbsonlSource(db).open();
    const spans: number[][] = [];
    try {
      for await (const batch of measuredScan(session)!(resolveOptions({ sizeOf: () => { calls++; return 10; }, batchSize: 7, maxBatchBytes: 30 }))) {
        const offset = batch.offset ?? 0, length = batch.length ?? batch.rows.length;
        expect(batch.bytes).toBeLessThanOrEqual(30);
        spans.push(batch.rows.slice(offset, offset + length).map(row => row.value));
      }
    } finally { await session.close(); }
    expect(spans.flat()).toEqual(Array.from({ length: 100 }, (_, n) => n));
    expect(Math.max(...spans.map(span => span.length))).toBe(3);
    expect(calls).toBe(100);
  } finally { await db.close(); }
});

it('lets defuss-dbsonl scan large native snapshots in its worker pool, with the rows and early stops of one thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dataview-dbsonl-')); directories.push(dir);
  const backend = await createFileBackend(dir, { scanWorkers: 2, scanThreshold: 100 });
  const db = await openDbsonl<{ n: number }>(backend, 'pool', { create: true });
  const rowOnly = await openRowOnly<{ n: number }>(backend, 'pool');
  try {
    await db.batch(Array.from({ length: 600 }, (_, n) => ({ operation: 'put' as const, key: String(n).padStart(3, '0'), value: { n: (n * 7919) % 600 } })));
    const top = { filters: [{ field: 'value.n', op: 'gte' as const, value: 100 }], sorters: [{ field: 'value.n', direction: 'desc' as const }], limit: 5 };
    const scans = () => backend.parallel!.scans, before = scans();
    const pooled = await evaluateStream(createDbsonlSource(db), top, { count: 'exact', batchSize: 16 });
    expect(scans()).toBe(before + 1);
    expect(pooled).toEqual(await evaluateStream(createDbsonlSource(rowOnly), top, { count: 'exact', batchSize: 16 }));
    const page = { sorters: [{ field: 'key' }], limit: 1 }, first = await evaluateStream(createDbsonlSource(db), page, { batchSize: 16 });
    expect(scans()).toBe(before + 2);
    expect(first.summary).toMatchObject({ strategy: 'ordered', sourceExhausted: false });
    expect(first).toEqual(await evaluateStream(createDbsonlSource(rowOnly), page, { batchSize: 16 }));
    await db.put('new', { n: 0 }); await db.compact();
    expect((await db.collect()).removed.length).toBeGreaterThan(0);
  } finally { await rowOnly.close(); await db.close(); }
});

it('reads the first 4096 native rows in this thread and continues after them, so a short page never starts the pool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dataview-dbsonl-')); directories.push(dir);
  const backend = await createFileBackend(dir, { scanWorkers: 2 });
  const db = await openDbsonl<number>(backend, 'prefix', { create: true });
  // The prefix ends at a key of the maximum length, after which no key is short enough to be a bound.
  const key = (n: number) => String(n).padStart(5, '0') + (n === 4095 ? 'x'.repeat(4091) : '');
  const values = Array.from({ length: 10_000 }, (_, n) => n);
  try {
    for (let s = 0; s < values.length; s += 2500) await db.batch(values.slice(s, s + 2500).map(n => ({ operation: 'put' as const, key: key(n), value: n })));
    const scans = () => backend.parallel!.scans, before = scans();
    const page = await evaluateStream(createDbsonlSource(db), { limit: 50 }, { batchSize: 1000 });
    expect(scans()).toBe(before);
    expect(page.rows.map(row => row.value)).toEqual(values.slice(0, 50));
    const all = await evaluateStream(createDbsonlSource(db), {}, { batchSize: 1000 });
    expect(scans()).toBe(before + 1);
    expect(all.rows.map(row => row.value)).toEqual(values);
    const ignoring = { async beginRead() {
      const session = await db.beginRead();
      return { revision: session.revision, count: session.count, scan: session.scan.bind(session), close: () => session.close(), scanBatches: (options: object) => session.scanBatches({ ...options, limit: undefined }) };
    } };
    expect((await evaluateStream(createDbsonlSource(ignoring), {}, { batchSize: 1000 })).rows.map(row => row.value)).toEqual(values);
  } finally { await db.close(); }
});

it('pins every execution to a given snapshot head, so ranges of one snapshot read it after later writes', async () => {
  for (const backend of [createMemoryBackend(), await fileBackend()]) {
    const db = await openDbsonl<{ n: number }>(backend, 'pinned', { create: true });
    try {
      await db.batch(Array.from({ length: 20 }, (_, n) => ({ operation: 'put' as const, key: String(n).padStart(2, '0'), value: { n } })));
      const session = await db.beginRead();
      const parts = await session.split(3);
      await db.put('05', { n: 500 }); await db.put('new', { n: 1000 });
      const pinned = await Promise.all(parts.map(({ gte, lt }) => evaluateStream(createDbsonlSource(db, { gte, lt, at: session.head }), {})));
      expect(pinned.map(result => result.summary.revision)).toEqual(parts.map(() => session.revision));
      expect(pinned.flatMap(result => result.rows.map(row => row.value.n))).toEqual(Array.from({ length: 20 }, (_, n) => n));
      const whole = await evaluateStream(createDbsonlSource(db, { at: session.head }), {}, { count: 'exact' });
      expect(whole.summary).toMatchObject({ revision: session.revision, sourceRows: 20 });
      await session.close(); await db.compact(); await db.collect();
      await expect(evaluateStream(createDbsonlSource(db, { at: session.head }), {})).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(() => createDbsonlSource(db, { at: 'head' as never })).toThrow(TypeError);
    } finally { await db.close(); }
  }
});

it('the first rows of each key range, merged in key order, equal one pass, with ties, an offset and the exact count', async () => {
  const db = await openDbsonl<{ g: number }>(createMemoryBackend(), 'merged-pages', { create: true });
  try {
    await db.batch(Array.from({ length: 300 }, (_, n) => ({ operation: 'put' as const, key: String(n).padStart(3, '0'), value: { g: (n * 7) % 5 } })));
    const session = await db.beginRead();
    try {
      // Sorting by g alone leaves ties, which one pass returns in key order.
      const request = { filters: [{ field: 'value.g', op: 'gte' as const, value: 1 }], sorters: [{ field: 'value.g', direction: 'desc' as const }], offset: 7, limit: 30 };
      const ranges = await session.split(4);
      const parts = await Promise.all(ranges.map(({ gte, lt }) => evaluateStream(createDbsonlSource(db, { gte, lt, at: session.head }), { ...request, offset: 0, limit: request.offset + request.limit }, { count: 'exact' })));
      const merged = await evaluateStream(createImmutableArraySource(parts.flatMap(part => part.rows)), { sorters: request.sorters, offset: request.offset, limit: request.limit });
      const single = await evaluateStream(createDbsonlSource(db, { at: session.head }), request, { count: 'exact' });
      expect(ranges.length).toBe(4);
      expect(merged.rows).toEqual(single.rows);
      expect(parts.reduce((sum, part) => sum + part.summary.totalMatches!, 0)).toBe(single.summary.totalMatches);
    } finally { await session.close(); }
  } finally { await db.close(); }
});
