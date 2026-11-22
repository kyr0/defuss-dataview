import { describe, expect, it } from 'vitest';
import { forRows } from '../compute.js';
import { compileQuery } from '../query.js';
import { createArraySource } from '../stream.js';
import type { DataviewFilterOperator } from '../types.js';

// some(), every() and get() as the human approved them on 2026-11-22: predicateFn runs once when the expression is
// built and receives the element as an expression; a value that is no array gives false for both quantifiers, an
// empty array false for some() and true for every(); a non-Boolean predicate throws as in where.
type Item = { sku: string; qty: number; tags?: unknown };
type Row = { id: number; items?: unknown; tags?: unknown; want?: unknown; v?: unknown };
const q = forRows<Row>();
const source = (rows: readonly Row[]) => createArraySource(rows, { isolation: 'immutable' });
const select = async (exprs: Record<string, unknown>, rows: Row[], options: object = {}) =>
  (await q.rows({ select: exprs as never, ...options }).evaluate(source(rows))).rows as Record<string, unknown>[];

describe('some() and every()', () => {
  const rows: Row[] = [
    { id: 1, tags: ['a', 'b'] }, { id: 2, tags: [] }, { id: 3, tags: 'a' }, { id: 4 }, { id: 5, tags: ['b', 'b'] }, { id: 6, tags: [null, 'a'] },
  ];
  it('quantify over array elements and give false for values that are no array', async () => {
    const isA = (t: ReturnType<typeof q.field>) => q.eq(t, q.literal('a'));
    expect(await select({ some: q.some(q.field('tags'), isA), every: q.every(q.field('tags'), isA), notB: q.every(q.field('tags'), t => q.neq(t, q.literal('b'))) }, rows)).toEqual([
      { some: true, every: false, notB: false }, { some: false, every: true, notB: true }, { some: false, every: false, notB: false },
      { some: false, every: false, notB: false }, { some: false, every: false, notB: false }, { some: true, every: false, notB: true },
    ]);
  });
  it('filter rows in where, and stop at the first deciding element', async () => {
    const result = await q.rows({ select: { id: q.field('id') }, where: q.some(q.field('tags'), t => q.eq(t, q.literal('b'))) }).evaluate(source(rows));
    expect(result.rows).toEqual([{ id: 1 }, { id: 5 }]);
    // The second element would throw (a number has no lower()); some() decides at the first.
    expect(await select({ hit: q.some(q.field('tags'), t => q.eq(q.lower(t), q.literal('a'))) }, [{ id: 1, tags: ['A', 1] }])).toEqual([{ hit: true }]);
    await expect(select({ hit: q.some(q.field('tags'), t => q.eq(q.lower(t), q.literal('z'))) }, [{ id: 1, tags: ['A', 1] }])).rejects.toThrow('lower() needs a string');
  });
  it('nest, with the inner predicate reading the outer element through get()', async () => {
    const items: Item[] = [{ sku: 'x', qty: 1, tags: ['red'] }, { sku: 'y', qty: 5, tags: ['blue', 'y'] }];
    const data: Row[] = [{ id: 1, items }, { id: 2, items: [items[0]] }];
    // An item one of whose tags equals its own sku.
    const ownTag = q.some(q.field('items'), item => q.some(q.get(item, 'tags'), tag => q.eq(tag, q.get(item, 'sku'))));
    const many = q.some(q.field('items'), item => q.and(q.eq(q.get(item, 'sku'), q.literal('y')), q.gt(q.get(item, 'qty'), q.literal(2))));
    expect(await select({ ownTag, many }, data)).toEqual([{ ownTag: true, many: true }, { ownTag: false, many: false }]);
  });
  it('keep one element per level when predicates are built apart or with another forRows()', async () => {
    const other = forRows<{ x: number }>();
    // Built outside: its element is level 0, inside the outer predicate it shadows the outer element only within itself.
    const inner = q.some(q.field('tags'), t => q.eq(t, q.literal(2)));
    const outer = q.some(q.field('items'), item => q.and(inner, q.eq(item, q.literal(1))));
    const mixed = q.some(q.field('items'), item => other.some(q.field('tags') as never, t => q.eq(t as never, item)));
    expect(await select({ outer, mixed }, [{ id: 1, items: [0, 1], tags: [2] }, { id: 2, items: [3], tags: [1, 3] }])).toEqual([{ outer: true, mixed: false }, { outer: false, mixed: true }]);
  });
  it("share nodes between elements without carrying one element's value to the next", async () => {
    const isA = (t: ReturnType<typeof q.field>) => q.eq(q.upper(t), q.literal('A'));
    // The same upper(element) node appears in both quantifiers and twice in one predicate.
    const both = q.and(q.some(q.field('tags'), t => q.or(isA(t), isA(t))), q.every(q.field('items'), t => q.not(isA(t))));
    expect(await select({ both }, [{ id: 1, tags: ['b', 'a'], items: ['b', 'c'] }, { id: 2, tags: ['a'], items: ['a'] }])).toEqual([{ both: true }, { both: false }]);
  });
  it('stay plain data: the same build twice gives one plan signature, and JSON copies prepare alike', async () => {
    const build = () => forRows<Row>().aggregate({ groupBy: { hit: q.some(q.field('tags'), t => q.eq(t, q.literal('a'))) }, measures: { n: q.count() } });
    const a = build(), b = build();
    const parts = await Promise.all([a.partial(source(rows.slice(0, 3))), b.partial(source(rows.slice(3)))]);
    expect((await a.merge(parts)).rows).toEqual([{ hit: true, n: 2 }, { hit: false, n: 4 }]);
    const copy = JSON.parse(JSON.stringify({ select: { hit: q.every(q.field('tags'), t => q.isNullish(t)) } }));
    expect((await q.rows(copy).evaluate(source([{ id: 1, tags: [null] }]))).rows).toEqual([{ hit: true }]);
  });
  it('reject a missing predicateFn, a leaked element and a non-Boolean predicate', async () => {
    expect(() => q.some(q.field('tags'), 'a' as never)).toThrow('predicateFn');
    let leaked: unknown;
    q.some(q.field('tags'), t => { leaked = t; return q.literal(true); });
    expect(() => q.rows({ select: { x: leaked as never } })).toThrow('outside that predicate');
    expect(() => q.rows({ select: { x: { v: 1, op: 'some', args: [q.field('tags'), q.literal(true)], level: 99 } as never } })).toThrow(RangeError);
    await expect(select({ x: q.some(q.field('tags'), t => t as never) }, [{ id: 1, tags: ['a'] }])).rejects.toThrow('some() predicate must produce a Boolean');
  });
});

describe('get()', () => {
  it('reads own properties and array indexes of any value, undefined where the path does not lead', async () => {
    const v = q.field('v');
    expect(await select({ a: q.get(v, 'a.b'), first: q.get(v, '0') }, [
      { id: 1, v: { a: { b: 5 } } }, { id: 2, v: ['x', 'y'] }, { id: 3, v: 'text' }, { id: 4, v: Object.create({ a: { b: 1 } }) },
    ])).toEqual([{ a: 5, first: undefined }, { a: undefined, first: 'x' }, { a: undefined, first: undefined }, { a: undefined, first: undefined }]);
  });
  it('rejects unsafe paths when the plan is prepared', () => {
    expect(() => q.rows({ select: { x: q.get(q.field('v'), '__proto__.x') } })).toThrow(TypeError);
  });
});

describe('filter operators as expressions', () => {
  // The rule: every filter operator is also an expression with the same result, so a filter can move into where.
  const binary = new Uint8Array([1, 2]);
  const values: unknown[] = [false, true, -0, 1, NaN, 2n, 'ab', 'b', '', new Date(1), new Date(NaN), binary, {}, [], ['ab'], [1, 2], [[1]], null, undefined];
  const ops: DataviewFilterOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'endsWith'];
  it('give the result of the filter for every pair of values, in both equality modes', async () => {
    const rows = values.map((v, id) => ({ id, v }));
    for (const semantics of [{}, { equality: 'identity' as const }]) for (const op of ops) for (const operand of [...values, values]) {
      const filter = compileQuery({ filters: [{ field: 'v', op, value: operand }], semantics });
      const expr = (q as unknown as Record<string, (a: unknown, b: unknown) => unknown>)[op](q.field('v'), q.literal(operand));
      const got = await select({ r: expr }, rows, { semantics });
      expect(got.map(r => r.r), `${op} ${String(operand)} ${JSON.stringify(semantics)}`).toEqual(rows.map(row => filter.matches(row)));
    }
  });
  it('take any expression as the list of in(), including a field and a long literal list', async () => {
    const long = Array.from({ length: 40 }, (_, i) => i);
    expect(await select({ field: q.in(q.literal('b'), q.field('tags')), long: q.in(q.field('v'), q.literal(long)) }, [
      { id: 1, tags: ['a', 'b'], v: 39 }, { id: 2, tags: 'b', v: 40 }, { id: 3, v: -0 },
    ])).toEqual([{ field: true, long: true }, { field: false, long: false }, { field: false, long: true }]);
  });
});

describe('typeOf()', () => {
  it('names the value families of the typed order', async () => {
    const values = [undefined, null, true, 1, NaN, 1n, 's', new Date(NaN), new DataView(new ArrayBuffer(1)), new ArrayBuffer(1), [], {}, new Map()];
    const rows = values.map((v, id) => ({ id, v }));
    expect((await select({ t: q.typeOf(q.field('v')) }, rows)).map(r => r.t)).toEqual(
      ['undefined', 'null', 'boolean', 'number', 'number', 'bigint', 'string', 'date', 'binary', 'binary', 'array', 'object', 'object']);
  });
});
