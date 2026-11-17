import { describe, expect, it } from 'vitest';
import { forRows, MAX_PLAN_NODES } from '../compute.js';
import { compileQuery } from '../query.js';
import { createArraySource, createImmutableArraySource } from '../stream.js';

type Row = { id: number; a?: unknown; b?: unknown; when?: Date };
const q = forRows<Row>();
const source = (rows: readonly Row[]) => createArraySource(rows, { isolation: 'immutable' });
const one = async (expr: ReturnType<typeof q.literal>, row: Row = { id: 0 }) => (await q.rows({ select: { x: expr } }).evaluate(source([row]))).rows[0].x;

describe('expression operators', () => {
  it('evaluates every arithmetic, comparison and logical operator', async () => {
    const a = q.field('a') as never, b = q.field('b') as never, row = { id: 0, a: 7, b: 2 };
    expect(await Promise.all([q.add(a, b), q.sub(a, b), q.mul(a, b), q.div(a, b)].map(e => one(e as never, row)))).toEqual([9, 5, 14, 3.5]);
    expect(await Promise.all([q.eq(a, b), q.neq(a, b), q.gt(a, b), q.gte(a, b), q.lt(a, b), q.lte(a, b)].map(e => one(e as never, row)))).toEqual([false, true, true, true, false, false]);
    expect(await Promise.all([q.isNullish(q.field('b')), q.isNullish(q.field('when')), q.or(q.literal(false), q.lt(a, b)), q.or(q.literal(false), q.gt(a, b)), q.not(q.literal(true))].map(e => one(e as never, { id: 0, a: 7, b: null }))))
      .toEqual([true, true, false, false, false]);
    expect(await one(q.add(a, b) as never, { id: 0, a: 1, b: null })).toBeNull();
    expect(await one(q.coalesce(q.field('a'), q.field('b')) as never, { id: 0 })).toBeUndefined();
    expect(await one(q.lt(q.field('a'), q.literal(5)) as never, { id: 0, a: NaN })).toBe(false);
    await expect(one(q.or(q.field('a') as never) as never, { id: 0, a: 1 })).rejects.toThrow(TypeError);
  });
  it('interns literals by type, copies value-mode literal Dates and keeps object literals by identity', async () => {
    const plan = q.rows({ select: { z: q.literal(-0), p: q.literal(0), s: q.literal('0'), n: q.literal(0n), u: q.literal(undefined), nil: q.literal(null), t: q.literal(true) } });
    expect(plan.explain().requiredFields).toEqual([]);
    const [row] = (await plan.evaluate(source([{ id: 0 }]))).rows;
    expect(Object.is(row.z, -0)).toBe(true);
    expect(row).toMatchObject({ p: 0, s: '0', n: 0n, u: undefined, nil: null, t: true });
    const date = new Date(5), bytes = new Uint8Array([1]), object = { k: 1 };
    const [copied] = (await q.rows({ select: { d: q.literal(date), b: q.literal(bytes), o: q.literal(object) } }).evaluate(source([{ id: 0 }]))).rows;
    expect(copied.d).toEqual(date); expect(copied.d).not.toBe(date); expect(copied.b).not.toBe(bytes); expect(copied.o).toBe(object);
    const [kept] = (await q.rows({ select: { d: q.literal(date) }, semantics: { equality: 'identity' } }).evaluate(source([{ id: 0 }]))).rows;
    expect(kept.d).toBe(date);
  });
});

describe('descriptor and option validation', () => {
  it('rejects malformed descriptors with TypeErrors', () => {
    const symbolic = { [Symbol('s')]: q.field('id') };
    const bad: Array<() => unknown> = [
      () => q.rows(null as never),
      () => q.rows({ select: [] as never }),
      () => q.rows({ select: symbolic as never }),
      () => q.rows({ select: { x: q.field('id') }, numberMode: 'fast' as never }),
      () => q.rows({ select: { x: q.field('id') }, invalidNumbers: 'coerce' as never }),
      () => q.rows({ select: { x: q.field('id') }, orderBy: {} as never }),
      () => q.rows({ select: { x: q.field('id') }, orderBy: [null as never] }),
      () => q.rows({ select: { x: q.field('id') }, orderBy: [{ expr: q.field('id'), direction: 'up' as never }] }),
      () => q.aggregate({ measures: { n: q.count() }, orderBy: [{ field: 1 as never }] }),
      () => q.view({ select: { x: q.field('id') }, totals: {} }),
      () => q.rows({ select: { x: q.field('id') }, having: [] } as never),
      () => q.aggregate({ measures: { n: q.count() }, having: {} as never }),
      () => q.aggregate({ measures: { n: q.field('id') as never } }),
      () => q.aggregate({ measures: { n: { v: 1, op: 'sum' } as never } }),
      () => q.rows({ select: { x: { v: 1, op: 'path', path: 1 } as never } }),
      () => q.rows({ select: { x: { v: 1, op: 'literal' } as never } }),
      () => q.rows({ select: { x: { v: 1, op: 'add', args: [q.literal(1)] } as never } }),
      () => q.rows({ select: { x: { v: 1, op: 'field', key: 'id', extra: true } as never } }),
    ];
    bad.forEach((build, i) => expect(build, `case ${i}`).toThrow(TypeError));
  });
  it('caps the number of distinct expression nodes', () => {
    const literals = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`x${i}`, q.literal(i)]));
    expect(() => q.rows({ select: literals(MAX_PLAN_NODES) })).not.toThrow();
    expect(() => q.rows({ select: literals(MAX_PLAN_NODES + 1) })).toThrow(RangeError);
  });
  it('rejects malformed pages and options synchronously', () => {
    const plan = q.rows({ select: { id: q.field('id') } });
    expect(() => plan.stream(source([]), null as never)).toThrow(TypeError);
    expect(() => plan.stream(source([]), {}, null as never)).toThrow(TypeError);
    expect(() => plan.stream(source([]), {}, { sizeOfOutput: 1 as never })).toThrow(TypeError);
    expect(() => plan.stream(source([]), {}, { profile: 'yes' as never })).toThrow(TypeError);
  });
});

describe('measures and strategies at their edges', () => {
  it('applies the invalid-number policy to sumBigInt', async () => {
    const rows = [{ id: 0, a: 1n }, { id: 1, a: 2 }, { id: 2, a: null }];
    const plan = (invalidNumbers: 'error' | 'skip') => q.aggregate({ measures: { s: q.sumBigInt(q.field('a') as never) }, invalidNumbers });
    await expect(plan('error').evaluate(source(rows))).rejects.toThrow(TypeError);
    expect((await plan('skip').evaluate(source(rows))).rows).toEqual([{ s: 1n }]);
  });
  it('throws when a compensated sum or mean overflows only at finalization', async () => {
    // Each addition rounds back to MAX_VALUE; the correction term carries the excess past it.
    const rows = [Number.MAX_VALUE, 9e291, 9e291].map((a, id) => ({ id, a }));
    await expect(q.aggregate({ measures: { s: q.sum(q.field('a') as never) } }).evaluate(source(rows))).rejects.toThrow(/finalized/);
    await expect(q.aggregate({ measures: { m: q.avg(q.field('a') as never) } }).evaluate(source(rows))).rejects.toThrow(/finalized/);
    expect((await q.aggregate({ measures: { s: q.sum(q.field('a') as never) }, numberMode: 'sequential' }).evaluate(source(rows))).rows).toEqual([{ s: Number.MAX_VALUE }]);
  });
  it('resets min, max and BigInt state between ordered groups and pages them by output order', async () => {
    const rows = [...'aabbbc'].map((key, id) => ({ id, a: key, b: id, when: new Date(id) }));
    const ordered = createImmutableArraySource(rows, { keyCache: {}, ordering: compileQuery({ sorters: [{ field: 'a' }] }).ordering });
    await ordered.prepareKeys(['a']);
    const plan = q.aggregate({ groupBy: { a: q.field('a') }, measures: { lo: q.min(q.field('b')), hi: q.max(q.field('when')), big: q.sumBigInt(q.literal(2n)) }, orderBy: [{ field: 'lo', direction: 'desc' }] });
    const result = await plan.evaluate(ordered, { limit: 2 }, { count: 'exact' });
    expect(result.summary.strategy).toBe('ordered-groups');
    expect(result.rows).toEqual([{ a: 'c', lo: 5, hi: new Date(5), big: 2n }, { a: 'b', lo: 2, hi: new Date(4), big: 6n }]);
    expect((await plan.evaluate(ordered, { limit: 0 }, { count: 'exact' })).summary).toMatchObject({ returnedRows: 0, totalResultRows: 3, hasMore: true });
    expect((await plan.evaluate(createImmutableArraySource<Row>([], { ordering: compileQuery({ sorters: [{ field: 'a' }] }).ordering }))).rows).toEqual([]);
  });
  it('sorts every row without a limit, and scans in order when the source ordering satisfies orderBy', async () => {
    const rows = [3, 1, 2].map(id => ({ id }));
    const plan = q.rows({ select: { id: q.field('id') }, orderBy: [{ expr: q.field('id') }] });
    const sorted = await plan.evaluate(source(rows));
    expect(sorted).toMatchObject({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], summary: { strategy: 'sort' } });
    const ordered = createImmutableArraySource([1, 2, 3].map(id => ({ id })), { ordering: compileQuery({ sorters: [{ field: 'id' }] }).ordering });
    expect(await plan.evaluate(ordered, { limit: 2 })).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], summary: { strategy: 'ordered', sourceExhausted: false, hasMore: true } });
  });
  it('never evaluates sort keys when the page is empty', async () => {
    const plan = q.rows({ select: { id: q.field('id') }, orderBy: [{ expr: q.div(q.literal(1), q.field('a') as never) }] });
    const rows = [{ id: 0, a: 0 }, { id: 1, a: 1 }];
    expect((await plan.evaluate(source(rows), { limit: 0 }, { count: 'exact' })).summary).toMatchObject({ returnedRows: 0, totalResultRows: 2, strategy: 'top-k' });
    await expect(plan.evaluate(source(rows), { limit: 1 })).rejects.toThrow(RangeError);
  });
  it('enforces the scan budget and splits output batches by bytes', async () => {
    const rows = Array.from({ length: 10 }, (_, id) => ({ id }));
    await expect(q.aggregate({ measures: { n: q.count() } }).evaluate(source(rows), {}, { maxScannedRows: 5 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const sizes: number[] = [];
    for await (const event of q.rows({ select: { id: q.field('id') } }).stream(source(rows), {}, { sizeOfOutput: () => 40, maxBatchBytes: 100 })) if (event.type === 'batch') sizes.push(event.rows.length);
    expect(sizes).toEqual([2, 2, 2, 2, 2]);
  });
  it('groups ArrayBuffer and DataView keys by bytes and keeps private copies', async () => {
    const buffer = new Uint8Array([7, 8]).buffer;
    const keys = [buffer, new DataView(new Uint8Array([0, 7, 8]).buffer, 1, 2), new Uint8Array([7, 8])];
    const { rows } = await q.aggregate({ groupBy: { a: q.field('a') }, measures: { n: q.count() } }).evaluate(source(keys.map((a, id) => ({ id, a }))));
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(3);
    expect(rows[0].a).not.toBe(buffer);
  });
  it('counts reads from leased columns when profiling', async () => {
    const cached = createImmutableArraySource<Row>([{ id: 1, a: 2 }, { id: 2, a: 3 }], { keyCache: {} });
    await cached.prepareKeys(['a']);
    const result = await q.aggregate({ measures: { s: q.sum(q.field('a') as never) } }).evaluate(cached, {}, { profile: true });
    expect(result).toMatchObject({ rows: [{ s: 5 }], summary: { fieldReads: 2 } });
    expect(result.summary.cacheBytesPinned).toBeGreaterThan(0);
  });
});
