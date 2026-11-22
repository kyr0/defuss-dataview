import { describe, expect, it } from 'vitest';
import { forRows } from '../compute.js';
import { compileQuery, compareValues, createValueOperations } from '../query.js';
import { createArraySource } from '../stream.js';

// Lists are values (human decision 2026-11-22, defuss-dataview 0.10.0): under the default equality 'value' two arrays
// are equal when their elements are pairwise equal, sort element by element with a proper prefix first, and group,
// deduplicate and merge as one value. equality: 'identity' keeps arrays apart unless they are the same object.
type Row = { id: number; tags?: unknown };
const q = forRows<Row>();
const source = (rows: readonly Row[]) => createArraySource(rows, { isolation: 'immutable' });
const matches = (filter: object, rows: Row[], semantics?: object) => {
  const query = compileQuery({ filters: [filter as never], semantics: semantics as never });
  return rows.filter(row => query.matches(row)).map(row => row.id);
};

describe('lists compare by value', () => {
  it('are equal element by element, with the equality of their elements', () => {
    const { equal } = createValueOperations();
    expect(equal([1, 'a', null], [1, 'a', null])).toBe(true);
    expect(equal([NaN, -0, new Date(5), new Uint8Array([1])], [NaN, 0, new Date(5), new DataView(new Uint8Array([1]).buffer)])).toBe(true);
    expect(equal([[1, [2]]], [[1, [2]]])).toBe(true);
    expect(equal([1, 2], [2, 1])).toBe(false);
    expect(equal([1], [1, undefined])).toBe(false);
    expect(equal([null], [undefined])).toBe(false);
    expect(equal([{}], [{}])).toBe(false);
    expect(equal([1], 1)).toBe(false);
    expect(createValueOperations({ equality: 'identity' }).equal([1], [1])).toBe(false);
  });
  it('sort element by element after binary values and before other objects, a proper prefix first', () => {
    const sorted = [[2], {}, [1, 0], 'z', [], new Uint8Array([9]), [1], [[0]], [1, null], null].sort(compareValues);
    expect(sorted.map(v => JSON.stringify(v))).toEqual(['"z"', '{"0":9}', '[]', '[1]', '[1,0]', '[1,null]', '[2]', '[[0]]', '{}', 'null']);
    expect(compareValues([1, 'a'], [1, 'a'])).toBe(0);
  });
  it('throw for an array that contains itself, but not for a shared element', () => {
    const a: unknown[] = [1], b: unknown[] = [1];
    a.push(a); b.push(b);
    expect(() => createValueOperations().equal(a, b)).toThrow(TypeError);
    expect(() => compareValues(a, b)).toThrow('contains itself');
    expect(createValueOperations().equal(a, a)).toBe(true);
    const shared = [1];
    expect(createValueOperations().equal([shared, shared], [[1], [1]])).toBe(true);
  });
  it('filter by value: eq, neq, in, ranges, and snapshot array operands', () => {
    const rows: Row[] = [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: ['a'] }, { id: 3, tags: 'a' }, { id: 4, tags: ['b'] }, { id: 5 }];
    expect(matches({ field: 'tags', op: 'eq', value: ['a', 'b'] }, rows)).toEqual([1]);
    expect(matches({ field: 'tags', op: 'neq', value: ['a', 'b'] }, rows)).toEqual([2, 3, 4, 5]);
    expect(matches({ field: 'tags', op: 'in', value: [['a'], ['b']] }, rows)).toEqual([2, 4]);
    expect(matches({ field: 'tags', op: 'gt', value: ['a'] }, rows)).toEqual([1, 4]);
    expect(matches({ field: 'tags', op: 'eq', value: ['a', 'b'] }, rows, { equality: 'identity' })).toEqual([]);
    const operand = ['a'];
    const query = compileQuery({ filters: [{ field: 'tags', op: 'eq', value: operand }] });
    operand.push('b');
    expect(query.matches({ tags: ['a'] })).toBe(true);
  });
  it('group, count distinct values and find extremes by value', async () => {
    const rows: Row[] = [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: ['a', 'b'] }, { id: 3, tags: ['b'] }, { id: 4, tags: [] }, { id: 5, tags: ['a', 'b'] }];
    const grouped = await q.aggregate({ groupBy: { tags: q.field('tags') }, measures: { n: q.count() } }).evaluate(source(rows));
    expect(grouped.rows).toEqual([{ tags: ['a', 'b'], n: 3 }, { tags: ['b'], n: 1 }, { tags: [], n: 1 }]);
    const totals = await q.aggregate({ measures: { kinds: q.countDistinct(q.field('tags')), values: q.distinct(q.field('tags')), low: q.min(q.field('tags')), high: q.max(q.field('tags')) } }).evaluate(source(rows));
    expect(totals.rows).toEqual([{ kinds: 3, values: [['a', 'b'], ['b'], []], low: [], high: ['b'] }]);
    const identity = await q.aggregate({ groupBy: { tags: q.field('tags') }, measures: { n: q.count() }, semantics: { equality: 'identity' } }).evaluate(source(rows));
    expect(identity.rows).toHaveLength(5);
  });
  it('unwind arrays of arrays into one group per distinct element', async () => {
    const rows: Row[] = [{ id: 1, tags: [[1], [1], [2]] }, { id: 2, tags: [[2]] }];
    const result = await q.aggregate({ groupBy: { tag: q.each(q.field('tags')) }, measures: { n: q.count() } }).evaluate(source(rows));
    expect(result.rows).toEqual([{ tag: [1], n: 1 }, { tag: [2], n: 2 }]);
  });
  it('merge partials whose keys and distinct values are arrays; arrays of objects stay rejected', async () => {
    const rows: Row[] = [{ id: 1, tags: ['a', new Date(1)] }, { id: 2, tags: ['b'] }, { id: 3, tags: ['a', new Date(1)] }, { id: 4, tags: ['b'] }];
    const plan = q.aggregate({ groupBy: { tags: q.field('tags') }, measures: { n: q.count(), ids: q.distinct(q.field('tags')) } });
    const parts = await Promise.all([rows.slice(0, 2), rows.slice(2)].map(part => plan.partial(source(part))));
    const merged = await plan.merge(parts.map(p => structuredClone(p)));
    expect(merged.rows).toEqual([{ tags: ['a', new Date(1)], n: 2, ids: [['a', new Date(1)]] }, { tags: ['b'], n: 2, ids: [['b']] }]);
    await expect(plan.partial(source([{ id: 1, tags: [{}] }]))).rejects.toThrow('identity');
  });
});
