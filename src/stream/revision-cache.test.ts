import { describe, expect, it } from 'vitest';
import { createArraySource, createImmutableArraySource, estimateRowBytes, evaluateStream, prepareStreamQuery, streamQuery } from '../stream.js';

describe('revision accounting and prepared execution', () => {
  it('amortizes default accounting and bypasses custom estimators without identity guesses', async () => {
    let visits = 0;
    const rows = Array.from({ length: 8 }, (_, id) => new Proxy(Object.freeze({ id }), {
      getOwnPropertyDescriptor(target, key) { visits++; return Reflect.getOwnPropertyDescriptor(target, key); },
    }));
    const source = createImmutableArraySource(rows);
    expect(source.cachedBytes).toBe(0);
    expect(await source.prepare()).toEqual({ revision: 0n, cachedRows: 8, cachedBytes: 64 });
    expect(visits).toBe(8);
    for (let i = 0; i < 2; i++) expect((await evaluateStream(source)).rows).toEqual(rows);
    expect(visits).toBe(8);
    let custom = 0;
    await evaluateStream(source, {}, { sizeOf: () => { custom++; return 1; } });
    await evaluateStream(source, {}, { sizeOf: () => { custom++; return 2; } });
    expect(custom).toBe(16);
    expect(source.replace(rows)).toBe(1n); expect(source.cachedBytes).toBe(0);
    await source.prepare(); expect(visits).toBe(16);
  });
  it('caps cache payload and measures rows outside its prefix on each query', async () => {
    let visits = 0;
    const rows = Array.from({ length: 3 }, (_, n) => new Proxy({ n }, { getOwnPropertyDescriptor(t, k) { visits++; return Reflect.getOwnPropertyDescriptor(t, k); } }));
    const source = createImmutableArraySource(rows, { maxCachedBytes: 16 });
    await source.prepare(); expect(visits).toBe(2); expect(source.cachedBytes).toBe(16);
    await evaluateStream(source); await evaluateStream(source); expect(visits).toBe(4);
    const off = createImmutableArraySource(rows, { maxCachedBytes: 0 });
    expect(await off.prepare()).toEqual({ revision: 0n, cachedRows: 0, cachedBytes: 0 });
    await evaluateStream(off); expect(visits).toBe(7);
    expect(() => createImmutableArraySource([], { maxCachedBytes: -1 })).toThrow(RangeError);
  });
  it('rechecks per-query row/batch limits against cached sizes', async () => {
    const rows = [{ bytes: new Uint8Array(1000).subarray(0, 1) }], source = createImmutableArraySource(rows);
    await source.prepare();
    await expect(evaluateStream(source, {}, { maxRowBytes: 999 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(evaluateStream(source, {}, { maxBatchBytes: 999 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await evaluateStream(source)).rows).toEqual(rows);
    expect(estimateRowBytes(rows[0])).toBeGreaterThan(1000);
  });
  it('prepares a pinned revision through concurrent replacement and supports cancellation', async () => {
    const source = createImmutableArraySource(Array.from({ length: 20000 }, (_, n) => ({ n })));
    const preparing = source.prepare(); source.replace([{ n: -1 }]);
    const prior = await preparing;
    expect(prior).toEqual({ revision: 0n, cachedRows: 20000, cachedBytes: 160000 });
    expect(source.cachedBytes).toBe(0);
    expect((await evaluateStream(source)).rows).toEqual([{ n: -1 }]);
    await expect(source.prepare({ signal: { aborted: true } })).rejects.toMatchObject({ code: 'ABORTED' });
    const controller = new AbortController();
    const big = createImmutableArraySource(Array.from({ length: 100000 }, (_, n) => ({ n })));
    const timer = setTimeout(() => controller.abort(), 0);
    try { await expect(big.prepare({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' }); }
    finally { clearTimeout(timer); }
  });
  it('preserves getter rejection and invalid-record validation when preparing', async () => {
    await expect(createImmutableArraySource([{ get n() { throw Error('not called'); } }]).prepare()).rejects.toThrow('data properties');
    await expect(createImmutableArraySource([null as never]).prepare()).rejects.toMatchObject({ code: 'SOURCE_CONTRACT' });
  });
  it('captures reusable query operands while pagination and resource ownership stay per execution', async () => {
    const date = new Date(2), descriptor = { filters: [{ field: 'at', op: 'gte' as const, value: date }], sorters: [{ field: 'n', direction: 'desc' as const }] };
    const plan = prepareStreamQuery<{ n: number; at: Date }>(descriptor);
    date.setTime(99); descriptor.filters.length = 0;
    const source = createArraySource(Array.from({ length: 6 }, (_, n) => ({ n, at: new Date(n) })));
    const [a, b] = await Promise.all([plan.evaluate(source, { limit: 2 }), plan.evaluate(source, { offset: 2, limit: 2 })]);
    expect(a.rows.map(r => r.n)).toEqual([5, 4]); expect(b.rows.map(r => r.n)).toEqual([3, 2]);
    expect(a.summary.totalMatches).toBe(4); expect(b.summary.totalMatches).toBe(4);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() => plan.stream(source, { limit: -1 })).toThrow(RangeError);
    let count = 0;
    for await (const event of plan.stream(source, { limit: 1 })) if (event.type === 'batch') count += event.rows.length;
    expect(count).toBe(1);
  });
  it('does not expose reused scratch/spans through public output or public scans', async () => {
    const source = createImmutableArraySource(Array.from({ length: 13 }, (_, n) => ({ n })));
    const collected: (readonly { n: number }[])[] = [];
    for await (const event of streamQuery(source, {}, { batchSize: 3 })) if (event.type === 'batch') collected.push(event.rows);
    expect(collected.map(a => a.map(r => r.n))).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11], [12]]);
    const session = await source.open();
    const direct: (readonly { n: number }[])[] = [];
    for await (const batch of session.scan({ batchSize: 4, maxBatchBytes: 1000, maxRowBytes: 1000, sizeOf: estimateRowBytes })) direct.push(batch);
    await session.close();
    expect(direct.map(a => a.length)).toEqual([4, 4, 4, 1]);
    expect(direct.flat()).toEqual(collected.flat());
  });
});
