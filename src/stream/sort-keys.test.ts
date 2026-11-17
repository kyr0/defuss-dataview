import { describe, it, expect } from 'vitest';
import { createIndexedArraySource } from './indexed.js';
import { compileQuery } from '../query.js';

describe('bounded opt-in sort-key projection', () => {
  it('preserves typed ordering, stable ties, locale and row identity', async () => {
    const values = [undefined, null, NaN, -0, 4, Infinity, 3n, 'z', 'ä', true, false, new Date(0), new Date(NaN), new Uint8Array([2]), new Uint8Array([1, 2]), {}];
    const rows = Array.from({ length: 1000 }, (_, id) => ({ id, a: { b: values[(id * 17) % values.length] }, c: id % 5 }));
    for (const direction of ['asc', 'desc'] as const) {
      const query = { sorters: [{ field: 'a.b', direction }, { field: 'c', direction }] };
      const expected = [...rows].sort(compileQuery(query).compare);
      const index = createIndexedArraySource(rows, query, { cacheSortKeys: true });
      const result = await index.readPage({ limit: 1000 });
      expect(result.rows).toEqual(expected);
      result.rows.forEach(row => expect(row).toBe(rows[row.id]));
      expect(index.sortKeyBytes).toBe(28128);
      expect(index.replace(rows.slice(0, 10))).toBe(1n);
      expect(index.sortKeyBytes).toBe(408);
    }
    const query = { sorters: [{ field: 's' }], semantics: { strings: 'locale' as const, locale: 'de' } };
    const strings = ['ä', 'z', 'a', 'A'].map((s, id) => ({ s, id }));
    expect((await createIndexedArraySource(strings, query, { cacheSortKeys: true }).readPage()).rows).toEqual([...strings].sort(compileQuery(query).compare));
  });
  it('extracts each pure key once, accounts scratch and falls back below the exact cap', async () => {
    let calls = 0;
    const rows = Array.from({ length: 50 }, (_, id) => ({ id, get value() { calls++; return 50 - id; } }));
    const descriptor = { sorters: [{ field: 'value' }] };
    const fast = createIndexedArraySource(rows, descriptor, { cacheSortKeys: true, maxSortKeyBytes: 1096 });
    expect(calls).toBe(50); expect(fast.sortKeyBytes).toBe(1096);
    for (const options of [{ cacheSortKeys: true, maxSortKeyBytes: 1095 }, { cacheSortKeys: true, maxSortKeyBytes: 0 }, {}]) {
      calls = 0;
      const index = createIndexedArraySource(rows, descriptor, options);
      expect(index.sortKeyBytes).toBe(0); expect(calls).toBeGreaterThan(50);
      expect((await index.readPage({ limit: 50 }, { sizeOf: () => 64 })).rows.map(r => r.id)).toEqual((await fast.readPage({ limit: 50 }, { sizeOf: () => 64 })).rows.map(r => r.id));
    }
    expect(createIndexedArraySource([], descriptor, { cacheSortKeys: true }).sortKeyBytes).toBe(0);
    expect(createIndexedArraySource(rows, {}, { cacheSortKeys: true }).sortKeyBytes).toBe(0);
    expect(() => createIndexedArraySource(rows, descriptor, { maxSortKeyBytes: -1 })).toThrow();
    expect(() => createIndexedArraySource(rows, descriptor, { cacheSortKeys: 'yes' as never })).toThrow();
  });
  it('keeps the published revision intact when an opted-in getter throws during replacement', async () => {
    const index = createIndexedArraySource([{ id: 1, value: 2 }], { sorters: [{ field: 'value' }] }, { cacheSortKeys: true });
    expect(() => index.replace([{ id: 2, get value(): number { throw new Error('failed extraction'); } }])).toThrow('failed extraction');
    expect(index.revision).toBe(0n);
    expect((await index.readPage()).rows).toEqual([{ id: 1, value: 2 }]);
  });
});
