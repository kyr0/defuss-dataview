import { describe, it, expect } from 'vitest';
import { AccountingCache } from './accounting-cache.js';
import { createImmutableArraySource } from './array.js';
import { evaluateStream } from './executor.js';
import { estimateRowBytes } from './common.js';

describe('immutable accounting blocks', () => {
  it('lends only complete pages and respects partial-cap boundaries', () => {
    const rows = Array.from({ length: 4200 }, (_, id) => ({ id }));
    const cache = new AccountingCache(rows, 4100 * 8);
    expect(cache.block(0, 100)).toBeUndefined();
    for (let i = 0; i < 4095; i++) cache.size(i);
    expect(cache.block(0, 100)).toBeUndefined();
    cache.size(4095); cache.size(4095);
    expect(cache.block(4090, 100)?.length).toBe(6);
    expect(cache.block(0, 17)?.length).toBe(17);
    for (let i = 4096; i < 4100; i++) cache.size(i);
    expect(cache.block(4099, 100)?.length).toBe(1);
    expect(cache.block(4100, 100)).toBeUndefined();
    expect(cache.block(8192, 100)).toBeUndefined();
    expect(cache.size(4101)).toBe(estimateRowBytes(rows[4101]));
    expect(cache.bytes).toBe(32800); expect(cache.measuredRows).toBe(4100);
  });
  it('keeps warm/cold results equivalent across page, byte and source-cap boundaries', async () => {
    const rows = Array.from({ length: 4203 }, (_, id) => ({ id, text: 'x'.repeat(id % 9) }));
    const source = createImmutableArraySource(rows, { maxCachedBytes: 4100 * 8 });
    await source.prepare();
    for (const batchSize of [1, 127, 4097]) for (const maxBatchBytes of [400, 1000000]) {
      const options = { batchSize, maxBatchBytes, count: 'exact' as const };
      const query = { filters: [{ field: 'id', op: 'gte' as const, value: 4090 }], limit: 200 };
      const warm = await evaluateStream(source, query, options);
      const cold = await evaluateStream(createImmutableArraySource(rows, { maxCachedBytes: 0 }), query, options);
      expect(warm.rows).toEqual(cold.rows);
      expect(warm.summary.totalMatches).toBe(cold.summary.totalMatches);
      expect(warm.summary.scannedRows).toBe(rows.length);
    }
  });
  it('validates a whole warm batch before filtering or early page termination', async () => {
    const rows = [{ id: 1 }, { id: 2, text: 'x'.repeat(1000) }];
    const source = createImmutableArraySource(rows); await source.prepare();
    await expect(evaluateStream(source, { limit: 1 }, { maxRowBytes: 100 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(evaluateStream(source, { limit: 1 }, { maxBatchBytes: 100 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    let calls = 0;
    await evaluateStream(source, {}, { sizeOf: () => { calls++; return 0; } });
    expect(calls).toBe(2);
    const signal = { aborted: true, reason: new Error('cancelled') };
    await expect(evaluateStream(source, {}, { signal })).rejects.toThrow('cancelled');
  });
});
