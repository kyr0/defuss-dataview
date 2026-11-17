import { describe, it, expect } from 'vitest';
import { createDataview, evaluateDataview } from './dataview.js';
import { compileQuery } from './query.js';

describe('shallow flat top-k equivalence', () => {
  it('matches native stable sorting across typed keys, selectivity, pages and tie patterns', () => {
    const values = [undefined, null, NaN, -0, 0, 4, Infinity, -Infinity, 3n, 'z', 'ä', true, false, new Date(0), new Date(NaN), new Uint8Array([2]), new Uint8Array([1, 2]), {}];
    let seed = 0x314159;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const rows = Array.from({ length: 4096 }, (_, id) => ({ id, a: { b: values[next() % values.length] }, score: next() % 19 }));
    for (const direction of ['asc', 'desc'] as const) for (const pageSize of [1, 17, 64, 257]) for (const page of [0, 1, 3, 1000]) for (const cutoff of [0, 10, 18, 19]) {
      const view = createDataview({ page, pageSize, sorters: [{ field: 'a.b', direction }, { field: 'score', direction }], filters: [{ field: 'score', op: 'gte', value: cutoff }], meta: { selectedRowIds: [1, 5, 27] } });
      const query = compileQuery(view), ordered = rows.filter(query.matches).sort(query.compare);
      const actual = evaluateDataview(rows, view);
      const expected = evaluateDataview(ordered, createDataview({ page, pageSize, meta: view.meta }));
      expect(actual).toEqual({ ...expected, totalRows: rows.length });
      actual.entries.forEach(entry => expect(entry.row).toBe(rows[entry.row.id]));
    }
  });
  it('handles all ties, sorted/reverse inputs, no filters and safe-integer end overflow', () => {
    for (const reverse of [false, true]) {
      const rows = Array.from({ length: 2048 }, (_, id) => ({ id, score: id % 2 }));
      if (reverse) rows.reverse();
      for (const field of ['score', 'id', 'missing']) {
        const view = createDataview({ sorters: [{ field }], pageSize: 20, page: 2 });
        expect(evaluateDataview(rows, view).entries.map(e => e.row)).toEqual([...rows].sort(compileQuery(view).compare).slice(40, 60));
      }
      expect(evaluateDataview(rows, createDataview({ sorters: [{ field: 'id' }], page: 1, pageSize: Number.MAX_SAFE_INTEGER })).entries).toEqual([]);
    }
  });
});
