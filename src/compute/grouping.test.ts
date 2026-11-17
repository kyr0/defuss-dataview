import { describe, expect, it } from 'vitest';
import { forRows } from '../compute.js';
import { compileQuery } from '../query.js';
import { createArraySource, createImmutableArraySource } from '../stream.js';
import type { RecordSource } from '../stream.js';

type Row = { id: number; key?: unknown; other?: unknown; amount?: number };
const q = forRows<Row>();
const source = (rows: readonly Row[]) => createArraySource(rows, { isolation: 'immutable' });
const byKey = (semantics?: { equality?: 'value' | 'identity'; strings?: 'locale'; locale?: string }) => q.aggregate({ groupBy: { key: q.field('key') }, measures: { n: q.count() }, ...(semantics ? { semantics } : {}) });
const keyRows = (keys: unknown[]) => keys.map((key, id) => ({ id, key }));

describe('group equality (T18-T21)', () => {
  it('joins missing with undefined, NaNs, and signed zeros; keeps null and every type apart', async () => {
    const rows: Row[] = [{ id: 0 }, { id: 1, key: undefined }, { id: 2, key: null }, { id: 3, key: NaN }, { id: 4, key: Number.NaN }, { id: 5, key: -0 }, { id: 6, key: 0 }, { id: 7, key: 1 }, { id: 8, key: 1n }, { id: 9, key: '1' }, { id: 10, key: true }];
    const { rows: groups } = await byKey().evaluate(source(rows));
    expect(groups.map(g => g.n)).toEqual([2, 1, 2, 2, 1, 1, 1, 1]);
    expect(Object.is(groups[3].key, -0)).toBe(true);
  });
  it('groups Dates and binary values by value or by identity, keeping a stable representative', async () => {
    const first = new Date(0), second = new Date(0), invalid = new Date(NaN);
    const buffer = new Uint8Array([9, 1, 2, 9]);
    const keys = [first, second, invalid, new Date(NaN), buffer.subarray(1, 3), new Uint8Array([1, 2]), new Uint8Array([1, 2]).buffer];
    const value = (await byKey().evaluate(source(keyRows(keys)))).rows;
    expect(value.map(g => g.n)).toEqual([2, 2, 3]);
    expect(value[0].key).toBe(first);
    expect(value[2].key).toEqual(new Uint8Array([1, 2]));
    expect((value[2].key as Uint8Array).buffer).not.toBe(buffer.buffer);
    const identity = (await byKey({ equality: 'identity' }).evaluate(source(keyRows(keys)))).rows;
    expect(identity.map(g => g.n)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
  it('never merges tuples that a delimiter or JSON encoding would confuse', async () => {
    const pairs = [['a|b', 'c'], ['a', 'b|c'], ['1', 1], [1, '1'], [null, 'null'], ['null', null], ['["x",1]', undefined], [['x', 1], undefined]];
    const plan = q.aggregate({ groupBy: { key: q.field('key'), other: q.field('other') }, measures: { n: q.count() } });
    const { rows } = await plan.evaluate(source(pairs.map(([key, other], id) => ({ id, key, other }))), {}, { count: 'exact' });
    expect(rows).toHaveLength(pairs.length);
  });
  it('keeps exact membership and first-encounter order across table growth', async () => {
    const keys = Array.from({ length: 20_000 }, (_, i) => (i * 7919) % 5000);
    const { rows } = await byKey().evaluate(source(keyRows(keys)), {}, { maxGroups: 5000 });
    expect(rows).toHaveLength(5000);
    expect(rows.slice(0, 3).map(g => g.key)).toEqual([0, 2919, 838]);
    expect(rows.every(g => g.n === 4)).toBe(true);
  });
  it('rejects functions and symbols as keys', async () => {
    await expect(byKey().evaluate(source(keyRows([() => 1])))).rejects.toThrow(TypeError);
    await expect(byKey().evaluate(source(keyRows([Symbol('s')])))).rejects.toThrow(TypeError);
  });
});

describe('result scope (T22)', () => {
  it('applies HAVING before ordering and paging, and counts groups after HAVING', async () => {
    const rows = [...'aabbbcdddd'].map((key, id) => ({ id, key, amount: id }));
    const plan = q.aggregate({ groupBy: { key: q.field('key') }, measures: { n: q.count(), total: q.sum(q.field('amount')) }, having: [{ field: 'n', op: 'gte', value: 2 }], orderBy: [{ field: 'total', direction: 'desc' }] });
    const page = await plan.evaluate(source(rows), { offset: 1, limit: 1 }, { count: 'exact' });
    expect(page.rows).toEqual([{ key: 'b', n: 3, total: 9 }]);
    expect(page.summary).toMatchObject({ totalResultRows: 3, hasMore: true, totalInputMatches: 10, strategy: 'hash' });
  });
});

describe('working memory and caps (T23-T26)', () => {
  it('copies value-mode binary keys instead of retaining huge backing stores; identity keys are charged in full', async () => {
    const big = new Uint8Array(16 * 1024 * 1024), view = big.subarray(0, 4);
    // Input accounting would charge the backing store too; a schema-specific sizeOf isolates group-key accounting.
    const sizeOf = () => 64;
    const value = await byKey().evaluate(source(keyRows([view, view])), {}, { maxWorkingBytes: 1024 * 1024, sizeOf });
    expect(value.rows[0].n).toBe(2);
    expect(value.summary.peakWorkingBytes).toBeLessThan(4096);
    await expect(byKey({ equality: 'identity' }).evaluate(source(keyRows([view])), {}, { maxWorkingBytes: 1024 * 1024, sizeOf })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const object = { shared: true };
    expect((await byKey({ equality: 'identity' }).evaluate(source(keyRows([object, { shared: true }, object])))).rows.map(g => g.n)).toEqual([2, 1]);
  });
  it('scales working memory with the number of groups and fails exactly at the caps, never dropping a group', async () => {
    const unique = (n: number) => source(keyRows(Array.from({ length: n }, (_, i) => i)));
    const small = await byKey().evaluate(unique(1000)), large = await byKey().evaluate(unique(10_000), {}, { maxOutputRows: 10_000 });
    const ratio = large.summary.peakWorkingBytes / small.summary.peakWorkingBytes;
    expect(ratio).toBeGreaterThan(5); expect(ratio).toBeLessThan(20);
    await expect(byKey().evaluate(unique(1000), {}, { maxGroups: 999 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await byKey().evaluate(unique(1000), {}, { maxGroups: 1000 })).rows).toHaveLength(1000);
    const peak = small.summary.peakWorkingBytes;
    expect((await byKey().evaluate(unique(1000), {}, { maxWorkingBytes: peak })).rows).toHaveLength(1000);
    await expect(byKey().evaluate(unique(1000), {}, { maxWorkingBytes: peak - 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('releases the session and pinned columns after a cap failure', async () => {
    const cached = createImmutableArraySource<Row>(keyRows(Array.from({ length: 100 }, (_, i) => i)), { keyCache: {} });
    await cached.prepareKeys(['key']);
    await expect(byKey().evaluate(cached, {}, { maxGroups: 10 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(cached.keyCacheStats?.pinnedEntries).toBe(0);
  });
});

describe('leased source columns (T27-T31, T53)', () => {
  const rows = keyRows(Array.from({ length: 500 }, (_, i) => i % 7)).map(r => ({ ...r, amount: r.id / 4 }));
  const plan = q.aggregate({ groupBy: { key: q.field('key') }, measures: { total: q.sum(q.field('amount')), n: q.count() }, orderBy: [{ field: 'total', direction: 'desc' }] });
  it('gives identical results with the cache off, cold, warm and unable to admit', async () => {
    const off = createImmutableArraySource(rows), cold = createImmutableArraySource(rows, { keyCache: {} });
    const warm = createImmutableArraySource(rows, { keyCache: {} }); await warm.prepareKeys(['key', 'amount']);
    const tiny = createImmutableArraySource(rows, { keyCache: { maxBytes: 64 } }); await tiny.prepareKeys(['key', 'amount']);
    const results = await Promise.all([off, cold, warm, tiny].map(s => plan.evaluate(s)));
    for (const result of results) expect(result.rows).toEqual(results[0].rows);
    expect(results.map(r => r.summary.cacheBytesPinned > 0)).toEqual([false, false, true, false]);
    expect(cold.keyCacheStats?.builds).toBe(0);
  });
  it('lets concurrent readers share columns and cancel independently', async () => {
    const warm = createImmutableArraySource(rows, { keyCache: {} }); await warm.prepareKeys(['key', 'amount']);
    const controller = new AbortController(); controller.abort();
    const [cancelled, survivor] = await Promise.allSettled([plan.evaluate(warm, {}, { signal: controller.signal }), plan.evaluate(warm)]);
    expect(cancelled.status).toBe('rejected');
    expect(survivor).toMatchObject({ status: 'fulfilled' });
    expect(warm.keyCacheStats).toMatchObject({ pinnedEntries: 0, builds: 2 });
  });
  it('finishes on the pinned revision after replacement and releases the retired columns', async () => {
    const warm = createImmutableArraySource(rows, { keyCache: {} }); await warm.prepareKeys(['key', 'amount']);
    const rowsPlan = q.rows({ select: { key: q.field('key') } });
    const seen: unknown[] = [];
    for await (const event of rowsPlan.stream(warm, { limit: 30 }, { batchSize: 10 })) {
      if (event.type === 'batch') { if (!seen.length) { warm.replace([{ id: 0, key: 'new', amount: 0 }]); warm.clearKeyCache(); } seen.push(...event.rows.map(r => r.key)); }
    }
    expect(seen).toEqual(rows.slice(0, 30).map(r => r.key));
    expect(warm.keyCacheStats).toMatchObject({ entries: 0, pinnedEntries: 0, bytes: 0 });
    expect((await rowsPlan.evaluate(warm)).rows).toEqual([{ key: 'new' }]);
  });
  it('isolates columns by source and revision', async () => {
    const a = createImmutableArraySource([{ id: 0, key: 'a' }], { keyCache: {} }), b = createImmutableArraySource([{ id: 0, key: 'b' }], { keyCache: {} });
    await a.prepareKeys(['key']); await b.prepareKeys(['key']);
    expect([(await byKey().evaluate(a)).rows[0].key, (await byKey().evaluate(b)).rows[0].key]).toEqual(['a', 'b']);
    a.replace([{ id: 0, key: 'c' }]);
    const after = await byKey().evaluate(a);
    expect(after.rows[0].key).toBe('c'); expect(after.summary.cacheBytesPinned).toBe(0);
  });
  it('never builds a column, so a throwing accessor on a rejected row stays unread', async () => {
    const trap = { id: 2 } as Row; Object.defineProperty(trap, 'amount', { get() { throw new Error('read a rejected row'); }, enumerable: true });
    const guarded = createImmutableArraySource<Row>([{ id: 1, amount: 3 }, trap], { keyCache: {} });
    const sums = q.aggregate({ measures: { total: q.sum(q.field('amount')) }, filters: [{ field: 'id', op: 'eq', value: 1 }] });
    const sizeOf = () => 64;
    expect((await sums.evaluate(guarded, {}, { sizeOf })).rows).toEqual([{ total: 3 }]);
    expect((await sums.evaluate(guarded, {}, { sizeOf })).rows).toEqual([{ total: 3 }]);
    expect(guarded.keyCacheStats?.builds).toBe(0);
  });
});

describe('group strategies (T32-T37, T54, T55)', () => {
  const ordering = (...fields: string[]) => compileQuery({ sorters: fields.map(field => ({ field })) }).ordering;
  async function prepared(rows: Row[], fields: string[], semantics?: object): Promise<RecordSource<Row>> {
    const s = createImmutableArraySource(rows, { keyCache: {}, ordering: semantics ? compileQuery({ sorters: fields.map(field => ({ field })), semantics }).ordering : ordering(...fields) });
    await s.prepareKeys(fields);
    return s;
  }
  it('uses ordered groups for a certified homogeneous tuple, with runs spanning batches', async () => {
    const rows = [...'aaabbbbbccddddddde'].map((key, id) => ({ id, key, other: id % 3 === 0, amount: id }));
    const plan = q.aggregate({ groupBy: { key: q.field('key') }, measures: { n: q.count(), total: q.sum(q.field('amount')) }, orderBy: [{ field: 'n', direction: 'desc' }] });
    const hashed = await plan.evaluate(source(rows), { limit: 3 }, { count: 'exact' });
    for (const batchSize of [1, 2, 4, 256]) {
      const ordered = await plan.evaluate(await prepared(rows, ['key']), { limit: 3 }, { batchSize, count: 'exact' });
      expect(ordered.rows).toEqual(hashed.rows);
      expect(ordered.summary).toMatchObject({ strategy: 'ordered-groups', totalResultRows: 5, peakGroups: 1, hasMore: true });
    }
    const unordered = q.aggregate({ groupBy: { key: q.field('key') }, measures: { n: q.count() } });
    expect((await unordered.evaluate(await prepared(rows, ['key']), { offset: 1, limit: 2 })).rows).toEqual([{ key: 'b', n: 5 }, { key: 'c', n: 2 }]);
  });
  it('falls back to hashing for nullish, mixed, locale and identity-Date domains', async () => {
    const nullish = [{ id: 0, key: null }, { id: 1, key: undefined }, { id: 2, key: null }];
    const result = await byKey().evaluate(await prepared(nullish, ['key']));
    expect(result.summary.strategy).toBe('hash'); expect(result.rows.map(r => r.n)).toEqual([2, 1]);
    const locale = await byKey({ strings: 'locale', locale: 'en' }).evaluate(await prepared([{ id: 0, key: 'A' }, { id: 1, key: 'a' }], ['key'], { strings: 'locale', locale: 'en', collatorOptions: { sensitivity: 'base' } }));
    expect(locale.summary.strategy).toBe('hash'); expect(locale.rows).toHaveLength(2);
    const dates = await byKey({ equality: 'identity' }).evaluate(await prepared([{ id: 0, key: new Date(0) }, { id: 1, key: new Date(0) }], ['key']));
    expect(dates.summary.strategy).toBe('hash'); expect(dates.rows).toHaveLength(2);
    expect((await byKey().evaluate(await prepared(keyRows([1, 2]), ['other']))).summary.strategy).toBe('hash');
  });
  it('stops a grouping-only first page at K+1 distinct groups and leaves the total unknown', async () => {
    const plan = q.aggregate({ groupBy: { key: q.field('key') }, measures: {} });
    const result = await plan.evaluate(source(keyRows([...'aabacdeeff'])), { limit: 2 });
    expect(result.rows).toEqual([{ key: 'a' }, { key: 'b' }]);
    expect(result.summary).toMatchObject({ strategy: 'first-seen', hasMore: true, totalResultRows: null, sourceExhausted: false, scannedRows: 5 });
    const complete = await plan.evaluate(source(keyRows([...'aab'])), { limit: 5 });
    expect(complete.summary).toMatchObject({ strategy: 'first-seen', hasMore: false, totalResultRows: 2 });
  });
  it('refuses the first-seen shortcut with measures, HAVING, ordering or exact counts', async () => {
    const rows = source(keyRows([...'aabac']));
    const cases = [
      [q.aggregate({ groupBy: { key: q.field('key') }, measures: { n: q.count() } }), {}],
      [q.aggregate({ groupBy: { key: q.field('key') }, measures: {}, having: [{ field: 'key', op: 'neq', value: 'a' }] }), {}],
      [q.aggregate({ groupBy: { key: q.field('key') }, measures: {}, orderBy: [{ field: 'key', direction: 'desc' }] }), {}],
      [q.aggregate({ groupBy: { key: q.field('key') }, measures: {} }), { count: 'exact' as const }],
    ] as const;
    for (const [plan, options] of cases) expect((await plan.evaluate(rows, { limit: 1 }, options)).summary.strategy).toBe('hash');
  });
  it('rejects a group ceiling beyond the uint32 id range before allocating', () => {
    expect(() => byKey().stream(source([]), {}, { maxGroups: 2 ** 32 - 1 })).toThrow(RangeError);
    expect(() => byKey().stream(source([]), {}, { maxGroups: 2 ** 32 - 2 })).not.toThrow();
  });
});
