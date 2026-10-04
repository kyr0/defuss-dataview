import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { applyDataview, createDataview, evaluateDataview, updateRows, removeRows, addRows, setParent, toggleExpanded, toggleSelectedRow, setExpandedIds, updateMeta } from './index.js';
import { compareValues } from './query.js';

const tree = { idField: 'id', parentIdField: 'parentId' };
const ids = (entries: Array<{ row: { id: unknown } }>) => entries.map(entry => entry.row.id);

describe('upstream defect regressions', () => {
  it('terminates with rootless cycles and retains disconnected cycle components', () => {
    // A process deadline is necessary: a synchronous infinite loop cannot time out inside its own worker.
    const script = `import assert from 'node:assert/strict';import {createDataview,applyDataview} from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      for(const roots of [[],[{id:0,parentId:null}]]) {const rows=[...roots,{id:1,parentId:2},{id:2,parentId:1},{id:3,parentId:2}]; const result=applyDataview(rows,createDataview({tree:{idField:'id',parentIdField:'parentId'}}));assert.equal(result.length,rows.length);assert.equal(new Set(result.map(x=>x.row)).size,rows.length);}`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  });
  it('handles 50k-deep chains without recursion and reports counts before paging', () => {
    const rows = Array.from({ length: 50_000 }, (_, id) => ({ id, parentId: id ? id - 1 : null }));
    const result = evaluateDataview(rows, createDataview({ tree, page: 4999, pageSize: 10 }));
    expect(result.visibleRows).toBe(50_000); expect(result.entries[9].meta.depth).toBe(49_999);
    expect(result.entries[9].row).toBe(rows[49_999]);
  });
  it('handles wide descendant expansion without spread argument overflow', () => {
    // Width must be below a child: upstream used push(...children) at this level.
    const rows = Array.from({ length: 150_000 }, (_, id) => ({ id, parentId: id === 0 ? null : id === 1 ? 0 : 1 }));
    const result = evaluateDataview(rows, createDataview({ tree: { ...tree, includeDescendantsOfMatch: true }, filters: [{ field: 'id', op: 'eq', value: 0 }], pageSize: 2 }));
    expect(result.matchedRows).toBe(1); expect(result.visibleRows).toBe(rows.length); expect(result.entries).toHaveLength(2);
  });
  it('distinguishes default expansion from explicit empty, and toggles the last expanded node closed', () => {
    const rows = [{ id: 1, parentId: null }, { id: 2, parentId: 1 }];
    const view = createDataview({ tree });
    expect(ids(applyDataview(rows, view))).toEqual([1, 2]);
    expect(ids(applyDataview(rows, createDataview({ tree: { ...tree, expandedIds: [] } })))).toEqual([1]);
    expect(ids(applyDataview(rows, toggleExpanded(setExpandedIds(view, [1]), 1)))).toEqual([1]);
    const closed = toggleExpanded(view, 1);
    expect(closed.tree?.collapsedIds).toEqual([1]);
    expect(ids(applyDataview(rows, JSON.parse(JSON.stringify(closed))))).toEqual([1]);
    expect(ids(applyDataview(rows, toggleExpanded(closed, 1)))).toEqual([1, 2]);
  });
  it('matches structural IDs across selection, toggles, tree parents and patches', () => {
    const rows = [{ id: { tenant: 'a', key: 1 }, parentId: null, name: 'root' }, { id: { key: 2, tenant: 'a' }, parentId: { key: 1, tenant: 'a' }, name: 'child' }];
    let view = createDataview({ tree, meta: { selectedRowIds: [{ key: 2, tenant: 'a' }] } });
    const result = applyDataview(rows, view);
    expect(result[1].meta).toMatchObject({ depth: 1, isSelected: true });
    view = toggleSelectedRow(view, { tenant: 'a', key: 2 }); expect(view.meta.selectedRowIds).toEqual([]);
    expect(updateRows(rows, [{ key: 1, tenant: 'a' }], [{ name: 'renamed' }])[0].name).toBe('renamed');
    expect(removeRows(rows, [{ tenant: 'a', key: 2 }])).toEqual([rows[0]]);
    expect(addRows(rows, [rows[1]], { key: 1, tenant: 'a' }, 'before')[0]).toBe(rows[1]);
  });
  it('uses dot paths consistently for patches, removals, anchors and nested parent writes', () => {
    const rows = [{ key: { id: 1, parent: null as number | null }, name: 'a' }, { key: { id: 2, parent: 1 }, name: 'b' }];
    expect(updateRows(rows, [2], [{ name: 'new' }], 'key.id')[1].name).toBe('new');
    expect(removeRows(rows, [1], 'key.id')).toEqual([rows[1]]);
    expect(addRows(rows, [rows[1]], 1, 'before', 'key.id')[0]).toBe(rows[1]);
    const changed = setParent(rows, 2, null, 'key.id', 'key.parent');
    expect(changed[1].key).toEqual({ id: 2, parent: null });
    expect(rows[1].key.parent).toBe(1); expect(changed[0]).toBe(rows[0]);
  });
  it('preserves references for unchanged patches and metadata; retains subtype fields', () => {
    const rows = [{ id: 1, value: NaN }];
    expect(updateRows(rows, [1], [{ value: NaN }])).toBe(rows);
    expect(updateRows(rows, [1], [{}])).toBe(rows);
    const view = { ...createDataview(), application: { name: 'test' } };
    expect(updateMeta(view, {})).toBe(view);
    const next = updateMeta(view, { selectedRowIds: [1] });
    expect(next.application).toBe(view.application); expect(next.filters).toBe(view.filters); expect(next.sorters).toBe(view.sorters);
  });
  it('reads only own fields and rejects unsafe/malformed paths', () => {
    const row = Object.assign(Object.create({ score: 99 }), { id: 1 });
    expect(applyDataview([row], createDataview({ filters: [{ field: 'score', op: 'eq', value: 99 }] }))).toEqual([]);
    for (const field of ['__proto__.x', 'a.constructor.x', 'prototype', '.', 'a..b', 'a.']) {
      expect(() => createDataview({ sorters: [{ field }] })).toThrow();
      expect(() => updateRows([{ id: 1 }], [1], [{}], field)).toThrow();
    }
  });
  it('stably orders NaN/invalid dates and gives mixed values a transitive type order', () => {
    const rows = [{ id: 1, n: NaN }, { id: 2, n: NaN }];
    expect(ids(applyDataview(rows, createDataview({ sorters: [{ field: 'n', dir: 'desc' }] })))).toEqual([1, 2]);
    const values = [undefined, null, NaN, new Date('bad'), false, true, -Infinity, -2, 0, 10, Infinity, 2n, 10n, '2', '10', new Date(0), new Date(1), {}, []];
    for (const a of values) for (const b of values) {
      expect(compareValues(a, b)).not.toBeNaN();
      expect(Math.sign(compareValues(a, b)) + Math.sign(compareValues(b, a))).toBe(0);
      for (const c of values) if (compareValues(a, b) <= 0 && compareValues(b, c) <= 0) expect(compareValues(a, c)).toBeLessThanOrEqual(0);
    }
  });
});

describe('grid counts, validation and immutable moves', () => {
  it('reads only the requested rows for unfiltered, unsorted pagination', () => {
    const backing = Array.from({ length: 10000 }, (_, id) => ({ id }));
    const accessed: number[] = [];
    const rows = new Proxy(backing, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) accessed.push(Number(key));
      return Reflect.get(target, key, receiver);
    } });
    const result = evaluateDataview(rows, createDataview({ page: 100, pageSize: 2 }));
    expect(accessed).toEqual([200, 201]); expect(result.totalRows).toBe(10000); expect(result.visibleRows).toBe(10000);
  });
  it('returns exact flat counts without changing the old array contract', () => {
    const rows = Array.from({ length: 13 }, (_, id) => ({ id, active: id % 2 === 0 }));
    const view = createDataview({ filters: [{ field: 'active', op: 'eq', value: true }], pageSize: 3, page: 1 });
    const result = evaluateDataview(rows, view);
    expect(result).toMatchObject({ totalRows: 13, matchedRows: 7, visibleRows: 7, pageCount: 3, hasPreviousPage: true, hasNextPage: true });
    expect(ids(result.entries)).toEqual([6, 8, 10]); expect(result.entries).toEqual(applyDataview(rows, view));
    expect(evaluateDataview(rows, createDataview({ pageSize: 3, page: 99 }))).toMatchObject({ entries: [], pageCount: 5, hasNextPage: false });
    expect(evaluateDataview([], createDataview())).toMatchObject({ pageCount: 0, hasPreviousPage: false });
    expect(evaluateDataview(rows, createDataview({ page: 99 }))).toMatchObject({ pageCount: 1, hasPreviousPage: false, hasNextPage: false });
  });
  it('distinguishes tree matches, included ancestors and collapsed visibility', () => {
    const rows = [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }];
    const view = createDataview({ tree, filters: [{ field: 'id', op: 'eq', value: 3 }] });
    expect(evaluateDataview(rows, view)).toMatchObject({ matchedRows: 1, visibleRows: 3 });
    expect(evaluateDataview(rows, toggleExpanded(view, 1))).toMatchObject({ matchedRows: 1, visibleRows: 1 });
    expect(evaluateDataview(rows, createDataview({ ...view, tree: { ...tree, maxDepth: 0 } })).entries[0].meta.isExpanded).toBe(false);
  });
  it('uses explicit selection idField independently of tree identity', () => {
    const rows = [{ id: 1, selectedKey: 'a', parentId: null }];
    expect(applyDataview(rows, createDataview({ tree, idField: 'selectedKey', meta: { selectedRowIds: ['a'] } }))[0].meta.isSelected).toBe(true);
  });
  it('rejects self/descendant moves but accepts detach and missing parents', () => {
    const rows = [{ id: 1, parentId: null as number | null }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }];
    expect(() => setParent(rows, 1, 1)).toThrow('cycle'); expect(() => setParent(rows, 1, 3)).toThrow('cycle');
    expect(setParent(rows, 3, 99)[2].parentId).toBe(99);
    expect(setParent(rows, 2, null)[1].parentId).toBeNull(); expect(rows[1].parentId).toBe(1);
  });
  it('does not treat missing/null/NaN fields as relational matches', () => {
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
      expect(applyDataview([{}, { n: null }, { n: NaN }, { n: new Date('bad') }], createDataview({ filters: [{ field: 'n', op, value: 0 }] }))).toEqual([]);
    }
  });
  it('keeps strict in-filter semantics identical across the Set optimization threshold', () => {
    const small = [NaN], big = [...Array.from({ length: 17 }, (_, n) => n), NaN];
    for (const value of [small, big]) expect(applyDataview([{ n: NaN }], createDataview({ filters: [{ field: 'n', op: 'in', value }] }))).toEqual([]);
  });
  it('rejects unsafe paging and malformed runtime options', () => {
    for (const request of [{ page: Number.MAX_SAFE_INTEGER + 1 }, { page: Number.MAX_SAFE_INTEGER, pageSize: 2 }, { pageSize: Infinity }, { filters: {} }, { sorters: [{ field: 'id', direction: 1 }] }, { tree: { ...tree, expandAll: 'yes' } }, { tree: { ...tree, expandedIds: {} } }]) {
      expect(() => createDataview(request as never)).toThrow();
    }
  });
  it('rejects lossy or cyclic IDs instead of colliding with null or missing rows', () => {
    const cycle: Record<string, unknown> = {}; cycle.x = cycle;
    const values = [undefined, NaN, Infinity, 1n, new Date(), Symbol(), cycle, { x: undefined }];
    for (const id of values) {
      expect(() => createDataview({ meta: { selectedRowIds: [id as never] } })).toThrow();
      expect(() => removeRows([{ id: null }], [id])).toThrow();
    }
  });
  it('detaches caller expansion/selection inputs while keeping row references', () => {
    const ids = [{ key: 1 }];
    const view = createDataview({ tree: { ...tree, expandedIds: ids }, meta: { selectedRowIds: ids } });
    ids[0].key = 2; ids.push({ key: 3 });
    expect(view.tree?.expandedIds).toEqual([{ key: 1 }]); expect(view.meta.selectedRowIds).toEqual([{ key: 1 }]);
  });
  it('supports array IDs without collapsing numeric and string identifiers', () => {
    const rows = [{ id: [1, 'a'], parentId: null }, { id: ['1', 'a'], parentId: [1, 'a'] }];
    const view = createDataview({ tree, meta: { selectedRowIds: [['1', 'a']] } });
    expect(applyDataview(rows, view).map(entry => [entry.meta.depth, entry.meta.isSelected])).toEqual([[0, false], [1, true]]);
    expect(removeRows(rows, [[1, 'a']])).toEqual([rows[1]]);
  });
  it('rejects hidden, accessor and sparse identifier data without executing getters', () => {
    let invoked = false;
    const getter = { get key() { invoked = true; return 1; } };
    const sparse: unknown[] = []; sparse.length = 2;
    for (const id of [getter, sparse, Object.defineProperty({}, 'key', { value: 1 }), Object.assign([1], { extra: 2 }), { [Symbol('key')]: 1 }]) {
      expect(() => createDataview({ meta: { selectedRowIds: [id as never] } })).toThrow();
    }
    expect(invoked).toBe(false);
  });
  it('copies nested parent array paths and preserves other branches', () => {
    const rows = [{ id: 1, links: [{ parent: 2 }, { parent: 3 }], other: { untouched: true } }];
    const changed = setParent(rows, 1, null, 'id', 'links.0.parent');
    expect(changed[0].links[0].parent).toBeNull(); expect(rows[0].links[0].parent).toBe(2);
    expect(changed[0].links[1]).toBe(rows[0].links[1]); expect(changed[0].other).toBe(rows[0].other);
    expect(() => setParent(rows, 1, 99, 'id', 'links.bad.parent')).toThrow('Array');
  });
  it('moves class-instance rows like updateRows and 0.3.1 do', () => {
    class Node { constructor(public id: number, public parentId: number | null) {} }
    const rows = [new Node(1, null), new Node(2, null)] as Array<Node & Record<string, unknown>>;
    const changed = setParent(rows, 2, 1);
    expect(changed[1].parentId).toBe(1); expect(rows[1].parentId).toBeNull(); expect(changed[0]).toBe(rows[0]);
  });
});
