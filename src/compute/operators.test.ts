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

describe('date, text, conditional and rounding operators', () => {
  type Any = { id: number; a?: unknown; b?: unknown };
  const t = forRows<Any>();
  const run = async (select: Record<string, ReturnType<typeof t.field>>, rows: Any[], invalidNumbers?: 'skip') =>
    (await t.rows({ select, ...(invalidNumbers ? { invalidNumbers } : {}) }).evaluate(createArraySource(rows, { isolation: 'immutable' }))).rows;
  const a = t.field('a');
  it('work on strings by code point, give null for nullish operands and reject other types', async () => {
    const select = { lower: t.lower(a), upper: t.upper(a), trim: t.trim(a), sub: t.substring(a, 1, 2), rest: t.substring(a, 2), joined: t.concat(a, t.literal('|'), a), size: t.length(a) };
    expect(await run(select as never, [{ id: 0, a: ' Ä😀b ' }, { id: 1, a: null }])).toEqual([
      { lower: ' ä😀b ', upper: ' Ä😀B ', trim: 'Ä😀b', sub: 'Ä😀', rest: '😀b ', joined: ' Ä😀b | Ä😀b ', size: 5 },
      { lower: null, upper: null, trim: null, sub: null, rest: null, joined: null, size: null },
    ]);
    expect(await run({ n: t.length(a) } as never, [{ id: 0, a: [1, 2, 3] }, { id: 1, a: '\ud800x' }])).toEqual([{ n: 3 }, { n: 2 }]);
    expect(await run({ j: t.concat(a, t.field('b')) } as never, [{ id: 0, a: 'x' }])).toEqual([{ j: null }]);
    for (const expr of [t.lower(a), t.substring(a, 0), t.concat(a), t.length(a)]) await expect(run({ x: expr } as never, [{ id: 0, a: 5 }])).rejects.toThrow(TypeError);
    for (const bad of [-1, 1.5, '1']) expect(() => t.rows({ select: { x: t.substring(a, bad as never) } })).toThrow(TypeError);
    expect(() => t.rows({ select: { x: t.substring(a, 0, -1) } })).toThrow(TypeError);
  });
  it('evaluate only the chosen cond branch and require a Boolean test', async () => {
    const safe = t.cond(t.isNullish(a), t.literal(0), t.div(t.literal(1), a as never));
    expect(await run({ x: safe } as never, [{ id: 0 }, { id: 1, a: 4 }])).toEqual([{ x: 0 }, { x: 0.25 }]);
    await expect(run({ x: t.cond(a as never, t.literal(1), t.literal(2)) } as never, [{ id: 0, a: 1 }])).rejects.toThrow(/cond\(\) test/);
  });
  it('round halves away from zero and follow the invalid-number policy', async () => {
    const select = { floor: t.floor(a as never), ceil: t.ceil(a as never), round: t.round(a as never), abs: t.abs(a as never) };
    expect(await run(select as never, [2.5, -2.5, 0.49999999999999994, -7.2, null].map((a, id) => ({ id, a })))).toEqual([
      { floor: 2, ceil: 3, round: 3, abs: 2.5 }, { floor: -3, ceil: -2, round: -3, abs: 2.5 }, { floor: 0, ceil: 1, round: 0, abs: 0.49999999999999994 },
      { floor: -8, ceil: -7, round: -7, abs: 7.2 }, { floor: null, ceil: null, round: null, abs: null },
    ]);
    await expect(run(select as never, [{ id: 0, a: 'x' }])).rejects.toThrow(TypeError);
    expect(await run({ r: t.round(a as never) } as never, [{ id: 0, a: Infinity }], 'skip')).toEqual([{ r: null }]);
  });
});

describe('distinct and percentile measures', () => {
  type Any = { id: number; k?: unknown; v?: unknown };
  const m = forRows<Any>();
  const v = m.field('v');
  const aggregate = async (measures: object, rows: Any[], semantics?: object, options?: object) =>
    (await m.aggregate({ measures, ...(semantics ? { semantics } : {}) } as never).evaluate(createArraySource(rows, { isolation: 'immutable' }), {}, options)).rows[0] as Record<string, unknown>;
  const rows = (values: unknown[]) => values.map((v, id) => ({ id, v }));
  it('count distinct values with the equality of group keys and keep the first of each', async () => {
    const bytes = new Uint8Array([1, 2]), date = new Date(5), object = { x: 1 };
    const values = [1, '1', 1n, true, NaN, NaN, 0, -0, null, undefined, new Date(5), date, bytes, new Uint8Array([1, 2]), object, { x: 1 }, object];
    const value = await aggregate({ n: m.countDistinct(v), all: m.distinct(v) }, rows(values));
    expect(value.n).toBe(10);
    expect((value.all as unknown[]).slice(0, 7)).toEqual([1, '1', 1n, true, NaN, 0, new Date(5)]);
    expect((value.all as unknown[])[7]).not.toBe(bytes);
    expect((value.all as unknown[])[8]).toBe(object);
    expect((await aggregate({ n: m.countDistinct(v) }, rows([date, new Date(5), bytes, new Uint8Array([1, 2])]), { equality: 'identity' })).n).toBe(4);
    expect(await aggregate({ n: m.countDistinct(v), all: m.distinct(v), p: m.median(v as never) }, [])).toEqual({ n: 0, all: [], p: null });
    await expect(aggregate({ n: m.countDistinct(v) }, rows([() => 1]))).rejects.toThrow(TypeError);
  });
  it('interpolate percentiles between the closest ranks and validate p', async () => {
    const value = await aggregate({ p0: m.percentile(v as never, 0), p25: m.percentile(v as never, 0.25), median: m.median(v as never), p1: m.percentile(v as never, 1), even: m.median(v as never, { where: m.neq(v, m.literal(40)) }) }, rows([40, 10, null, 30, 20, 1e9]));
    expect(value).toEqual({ p0: 10, p25: 20, median: 30, p1: 1e9, even: 25 });
    expect((await aggregate({ m: m.median(v as never) }, rows([Number.MAX_VALUE, -Number.MAX_VALUE]))).m).toBe(0);
    for (const p of [-0.1, 1.1, NaN, '0.5']) expect(() => m.aggregate({ measures: { x: m.percentile(v as never, p as never) } })).toThrow(TypeError);
    expect(() => m.aggregate({ measures: { x: { ...m.median(v as never), p: 0.2 } as never } })).toThrow(/unexpected property/);
    await expect(aggregate({ m: m.median(v as never) }, rows(['x']))).rejects.toThrow(TypeError);
  });
  it('reserve every kept value in working memory and reset it between ordered groups', async () => {
    const many = rows(Array.from({ length: 2000 }, (_, i) => `value ${i}`));
    await expect(aggregate({ n: m.countDistinct(v) }, many, undefined, { maxWorkingBytes: 64 * 1024 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(aggregate({ p: m.median(m.literal(1)) }, many, undefined, { maxWorkingBytes: 8 * 1024 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const data = [...'aabbbc'].map((k, id) => ({ id, k, v: id % 2 }));
    const ordered = createImmutableArraySource(data, { keyCache: {}, ordering: compileQuery({ sorters: [{ field: 'k' }] }).ordering });
    await ordered.prepareKeys(['k']);
    const plan = m.aggregate({ groupBy: { k: m.field('k') }, measures: { n: m.countDistinct(v), all: m.distinct(v), median: m.median(v as never) } });
    const result = await plan.evaluate(ordered);
    expect(result.summary.strategy).toBe('ordered-groups');
    expect(result.rows).toEqual([{ k: 'a', n: 2, all: [0, 1], median: 0.5 }, { k: 'b', n: 2, all: [0, 1], median: 0 }, { k: 'c', n: 1, all: [1], median: 1 }]);
  });
  it('merge from partials, and reject identity values and malformed lists', async () => {
    const plan = m.aggregate({ measures: { n: m.countDistinct(v), all: m.distinct(v), median: m.median(m.number(m.field('k'))) } });
    const part = (data: Any[]) => plan.partial(createArraySource(data, { isolation: 'immutable' }));
    const parts = [await part([{ id: 0, v: new Uint8Array([7]), k: 1 }, { id: 1, v: 'a', k: 5 }]), await part([{ id: 2, v: 'a', k: 3 }, { id: 3, v: new Date(1) }])];
    expect((await plan.merge(parts.map(p => structuredClone(p)))).rows).toEqual([{ n: 3, all: [new Uint8Array([7]), 'a', new Date(1)], median: 3 }]);
    await expect(part([{ id: 0, v: { x: 1 } }])).rejects.toThrow(/identity/);
    const [good] = parts, [distinct, numbers] = good.states as [{ offsets: Float64Array; items: unknown[] }, { offsets: Float64Array; numbers: Float64Array }];
    for (const [name, states] of [
      ['items type', [{ ...distinct, items: 'ab' }, numbers]], ['item', [{ ...distinct, items: [null, 'a'] }, numbers]], ['object item', [{ ...distinct, items: [{}, 'a'] }, numbers]],
      ['offsets', [{ ...distinct, offsets: new Float64Array([0, 1]) }, numbers]], ['number', [distinct, { ...numbers, numbers: new Float64Array([NaN, 5]) }]],
      ['numbers type', [distinct, { ...numbers, numbers: [1, 5] }]],
    ] as const) await expect(plan.merge([{ ...good, states } as never]), name).rejects.toThrow(TypeError);
  });
});

describe('each() group keys', () => {
  type Tagged = { id: number; k?: unknown; tags?: unknown };
  const e = forRows<Tagged>();
  const tags = e.field('tags');
  it('join one group per distinct element, none for an empty array, and group other values as they are', async () => {
    const data: Tagged[] = [{ id: 0, tags: ['a', 'b', 'a'] }, { id: 1, tags: [] }, { id: 2, tags: ['b'] }, { id: 3 }, { id: 4, tags: 'a' }, { id: 5, tags: [NaN, NaN, -0, 0] }];
    const plan = e.aggregate({ groupBy: { tag: e.each(tags) }, measures: { n: e.count(), ids: e.distinct(e.field('id')) } });
    expect((await plan.evaluate(createArraySource(data, { isolation: 'immutable' }))).rows).toEqual([
      { tag: 'a', n: 2, ids: [0, 4] }, { tag: 'b', n: 2, ids: [0, 2] }, { tag: undefined, n: 1, ids: [3] }, { tag: NaN, n: 1, ids: [5] }, { tag: -0, n: 1, ids: [5] },
    ]);
    expect(plan.explain().operators).toContain('unwind');
    const pairs = e.aggregate({ groupBy: { x: e.each(tags), y: e.each(e.field('k')) }, measures: { n: e.count() } });
    expect((await pairs.evaluate(createArraySource([{ id: 0, tags: [1, 2], k: ['p', 'q'] }], { isolation: 'immutable' }))).rows)
      .toEqual([{ x: 1, y: 'p', n: 1 }, { x: 1, y: 'q', n: 1 }, { x: 2, y: 'p', n: 1 }, { x: 2, y: 'q', n: 1 }]);
  });
  it('never run as ordered groups, stop early with first-seen groups and reject identity elements in partials', async () => {
    const data = [...'aabbc'].map((k, id) => ({ id, k, tags: [k, 'z'] }));
    const ordered = createImmutableArraySource(data, { keyCache: {}, ordering: compileQuery({ sorters: [{ field: 'tags' }] }).ordering });
    const plan = e.aggregate({ groupBy: { t: e.each(tags) }, measures: { n: e.count() } });
    const result = await plan.evaluate(ordered);
    expect(result.summary.strategy).toBe('hash');
    expect(result.rows).toEqual([{ t: 'a', n: 2 }, { t: 'z', n: 5 }, { t: 'b', n: 2 }, { t: 'c', n: 1 }]);
    const first = await e.aggregate({ groupBy: { t: e.each(tags) }, measures: {} }).evaluate(createArraySource(data, { isolation: 'immutable' }), { limit: 2 });
    expect(first.summary).toMatchObject({ strategy: 'first-seen', hasMore: true });
    expect(first.rows).toEqual([{ t: 'a' }, { t: 'z' }]);
    await expect(plan.partial(createArraySource([{ id: 0, tags: [{ x: 1 }] }], { isolation: 'immutable' }))).rejects.toThrow(/identity/);
    await expect(plan.evaluate(createArraySource([{ id: 0, tags: [() => 1, 2] }], { isolation: 'immutable' }))).rejects.toThrow(TypeError);
  });
  it('are whole group keys only', () => {
    for (const build of [
      () => e.rows({ select: { t: e.each(tags) } }),
      () => e.aggregate({ groupBy: { t: e.lower(e.each(tags) as never) }, measures: { n: e.count() } }),
      () => e.aggregate({ where: e.eq(e.each(tags), e.literal('a')), measures: { n: e.count() } }),
      () => e.aggregate({ measures: { n: e.countDistinct(e.each(tags)) } }),
      () => e.aggregate({ groupBy: { t: { ...e.each(tags), extra: 1 } as never }, measures: {} }),
      () => e.aggregate({ groupBy: { t: { v: 1, op: 'each', args: [] } as never }, measures: {} }),
      () => e.aggregate({ groupBy: { t: { op: 'each', args: [tags] } as never }, measures: {} }),
    ]) expect(build).toThrow(TypeError);
  });
});
