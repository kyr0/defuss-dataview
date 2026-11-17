import { describe, expect, it } from 'vitest';
import { compileQuery } from '../query.js';
import { createIndexedArraySource, evaluateStream } from '../stream.js';

describe('materialized immutable indexes', () => {
  it('matches stable typed filter/order results across all cursor pages and batch tails', async () => {
    let seed = 17;
    const rows = Array.from({ length: 513 }, (_, id) => ({ id, n: (seed = (seed * 1664525 + 1013904223) >>> 0) % 31, at: new Date(id % 7) }));
    const descriptor = { filters: [{ field: 'at', op: 'gte' as const, value: new Date(2) }], sorters: [{ field: 'n', direction: 'desc' as const }] };
    const q = compileQuery(descriptor), expected = rows.filter(q.matches).sort(q.compare);
    const source = createIndexedArraySource(rows, descriptor);
    expect(source.count).toBe(expected.length); expect(source.inputRows).toBe(rows.length);
    let after; const found = [];
    do {
      const page = await source.readPage({ after, limit: 17 }, { batchSize: 7 });
      found.push(...page.rows); after = page.nextCursor;
      expect(page.indexRows).toBe(expected.length);
      expect(page.summary.scannedRows).toBeLessThanOrEqual(page.rows.length + 1);
      expect(page.summary.sourceRows).toBe(expected.length - (found.length - page.rows.length));
    } while (after);
    expect(found).toEqual(expected);
    expect((await evaluateStream(source, { limit: 21 })).rows).toEqual(expected.slice(0, 21));
    expect((await source.prepare()).cachedRows).toBe(expected.length);
  });
  it('rejects foreign, copied and stale cursors and preserves admitted revision reads', async () => {
    const source = createIndexedArraySource([{ n: 0 }, { n: 1 }, { n: 2 }]);
    const first = await source.readPage({ limit: 1 });
    const other = createIndexedArraySource([{ n: 10 }, { n: 11 }]);
    await expect(other.readPage({ after: first.nextCursor })).rejects.toThrow('cursor');
    await expect(source.readPage({ after: { ...first.nextCursor! } })).rejects.toThrow('cursor');
    const pending = source.readPage({ after: first.nextCursor, limit: 1 });
    expect(source.replace([{ n: 9 }])).toBe(1n);
    expect((await pending).rows).toEqual([{ n: 1 }]);
    await expect(source.readPage({ after: first.nextCursor })).rejects.toThrow('stale');
    expect((await source.readPage()).rows).toEqual([{ n: 9 }]);
  });
  it('publishes replacement atomically and enforces distinct index, cache and query budgets', async () => {
    const source = createIndexedArraySource([{ n: 1 }], {}, { maxIndexRows: 2, maxIndexBytes: 16, maxCachedBytes: 0 });
    expect(() => source.replace([{ n: 2 }, { n: 3 }, { n: 4 }])).toThrow('budget');
    expect(source.revision).toBe(0n); expect((await source.readPage()).rows).toEqual([{ n: 1 }]);
    expect((await source.prepare()).cachedBytes).toBe(0);
    expect(() => createIndexedArraySource([{ n: 1 }], {}, { maxIndexBytes: 7 })).toThrow('budget');
    expect(() => createIndexedArraySource([null as never])).toThrow('record');
    expect(() => createIndexedArraySource([], {}, { maxIndexRows: -1 })).toThrow(RangeError);
    await expect(source.readPage({}, { maxRowBytes: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(source.readPage({}, { signal: { aborted: true } })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(source.readPage({ limit: -1 })).rejects.toThrow(RangeError);
  });
  it('handles empty indexes and zero pages without consuming a cursor position', async () => {
    expect(await createIndexedArraySource([]).readPage()).toMatchObject({ rows: [], indexRows: 0, nextCursor: undefined });
    const source = createIndexedArraySource([{ n: 1 }, { n: 2 }]);
    const empty = await source.readPage({ limit: 0 });
    expect(empty.rows).toEqual([]); expect(empty.nextCursor?.position).toBe(0);
    expect((await source.readPage({ after: empty.nextCursor })).rows).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
