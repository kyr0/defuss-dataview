import { expect, it } from 'vitest';
import { applyDataview, createDataview } from './index.js';
import { applyDataview as originalApply, createDataview as originalCreate } from '../tests/fixtures/upstream-src/index.js';

it('agrees with upstream on 160 seeded valid forest/filter/sort/paging cases', () => {
  let seed = 20260930;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let run = 0; run < 160; run++) {
    const rows = Array.from({ length: 60 }, (_, id) => ({ id, parentId: id > 0 && random() < 0.8 ? Math.floor(random() * id) : null, score: Math.floor(random() * 5) }));
    const request = {
      tree: { idField: 'id', parentIdField: 'parentId', expandedIds: run % 2 ? undefined : [0, 1, 2, 3, 4, 5, 6], includeAncestors: run % 3 !== 0, includeDescendantsOfMatch: run % 5 === 0 },
      filters: run % 4 ? [{ field: 'score', op: 'gte' as const, value: 3 }] : [],
      sorters: run % 3 ? [{ field: 'score', direction: 'desc' as const }] : [],
      pageSize: run % 7 ? 7 : undefined, page: run % 3,
      meta: { selectedRowIds: [0, 3, 5, 8] },
    };
    const before = structuredClone(rows);
    expect(applyDataview(rows, createDataview(request))).toEqual(originalApply(rows, originalCreate(request)));
    expect(rows).toEqual(before);
  }
});
