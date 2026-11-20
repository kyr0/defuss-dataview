import { describe, expect, it } from 'vitest';
import { openDbsonl, createMemoryBackend } from 'defuss-dbsonl';
import { forRows } from '../compute.js';
import { StateColumns, Ledger } from './aggregate.js';
import { createArraySource, createImmutableArraySource, DataviewError } from '../stream.js';
import type { RecordSession, RecordSource } from '../stream.js';
import { createDbsonlSource } from '../adapters/dbsonl.js';

type Row = { id: number; amount?: number | null; qty?: number; zero?: number; flag?: boolean; tag?: unknown };
const q = forRows<Row>();
const data: Row[] = [{ id: 1, amount: 10, qty: 2, zero: 1 }, { id: 2, amount: null, qty: 1, zero: 0 }, { id: 3, qty: 3, zero: 1 }, { id: 4, amount: 5.5, qty: 0, zero: 0 }];
const source = (rows: readonly object[] = data) => createArraySource(rows as Row[], { isolation: 'immutable' });
/** A real, separately implemented source whose session and iterator lifecycle the test can observe and break. */
function scripted(batches: unknown[], hooks: { count?: number; closeError?: Error; returnError?: Error; onPull?: (index: number) => void } = {}) {
  const log = { opened: 0, closed: 0, returned: 0 };
  const src: RecordSource<Row> = {
    async open() {
      log.opened++;
      const session: RecordSession<Row> = {
        consistency: 'snapshot', revision: 1, count: hooks.count,
        scan() {
          let i = 0;
          return { [Symbol.asyncIterator]: () => ({
            async next() { hooks.onPull?.(i); return i < batches.length ? { done: false, value: batches[i++] as readonly Row[] } : { done: true, value: undefined }; },
            async return() { log.returned++; if (hooks.returnError) throw hooks.returnError; return { done: true, value: undefined }; },
          }) };
        },
        async close() { log.closed++; if (hooks.closeError) throw hooks.closeError; },
      };
      return session;
    },
  };
  return { src, log };
}

describe('descriptors and expressions (T02, T03)', () => {
  it('rejects unsafe paths, aliases, malformed and cyclic trees before any source opens', () => {
    const cyclic: any = { v: 1, op: 'not', args: [] }; cyclic.args.push(cyclic);
    const deep = Array.from({ length: 70 }).reduce<any>(e => q.not(e), q.literal(true));
    const bad: Array<() => unknown> = [
      () => q.rows({ select: { x: q.path('a.__proto__') } }),
      () => q.rows({ select: { x: { v: 1, op: 'field', key: 'a.b' } as never } }),
      () => q.rows({ select: { 'a.b': q.field('id') } }),
      () => q.rows({ select: { __proto__: q.field('id') } as never }),
      () => q.rows({ select: JSON.parse('{"__proto__": {"v": 1, "op": "field", "key": "id"}}') }),
      () => q.rows({ select: { x: { v: 2, op: 'field', key: 'id' } as never } }),
      () => q.rows({ select: { x: { v: 1, op: 'eval', args: [] } as never } }),
      () => q.rows({ select: { x: q.field('id') }, where: cyclic }),
      () => q.rows({ select: { x: deep } }),
      () => q.rows({ select: { x: q.field('id') }, extra: 1 } as never),
      () => q.aggregate({ measures: {} }),
      () => q.aggregate({ groupBy: { n: q.field('id') }, measures: { n: q.count() } }),
      () => q.aggregate({ measures: { n: q.count() }, having: [{ field: 'id', op: 'eq', value: 1 }] }),
      () => q.aggregate({ measures: { n: q.count() }, orderBy: [{ field: 'missing' }] }),
      () => q.aggregate({ measures: { n: { v: 1, op: 'count', arg: undefined } as never } }),
    ];
    bad.forEach((build, i) => expect(build, `case ${i}`).toThrow(/./));
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('runs one prepared plan concurrently with independent state and sessions', async () => {
    const plan = q.aggregate({ measures: { total: q.sum(q.field('amount')), n: q.count() } });
    const a = scripted([[{ id: 1, amount: 1 }], [{ id: 2, amount: 2 }]]), b = scripted([[{ id: 3, amount: 40 }]]);
    const [ra, rb] = await Promise.all([plan.evaluate(a.src), plan.evaluate(b.src)]);
    expect(ra.rows).toEqual([{ total: 3, n: 2 }]); expect(rb.rows).toEqual([{ total: 40, n: 1 }]);
    expect([a.log, b.log]).toEqual([{ opened: 1, closed: 1, returned: 1 }, { opened: 1, closed: 1, returned: 1 }]);
    expect(plan.explain()).toMatchObject({ kind: 'aggregate', requiredFields: ['amount'], strategies: ['scalar'], states: 2 });
  });
});

describe('projection (T04-T08, T52)', () => {
  it('keeps missing, null and undefined apart as own properties, in alias order, without copying nested values', async () => {
    const nested = { deep: 1 };
    const plan = q.rows({ select: { tag: q.field('tag'), amount: q.field('amount'), id: q.field('id') } });
    const { rows } = await plan.evaluate(source([{ id: 1, tag: nested }, { id: 2, amount: null, tag: undefined }]));
    expect(rows.map(r => Object.keys(r))).toEqual([['tag', 'amount', 'id'], ['tag', 'amount', 'id']]);
    expect(rows[0].tag).toBe(nested); expect(rows[0].amount).toBeUndefined(); expect(rows[1].amount).toBeNull();
  });
  it('never evaluates an output-only expression on a filtered or out-of-page row', async () => {
    const plan = q.rows({ select: { id: q.field('id'), inverse: q.div(q.literal(1), q.field('zero')) }, filters: [{ field: 'zero', op: 'eq', value: 1 }] });
    expect((await plan.evaluate(source())).rows).toEqual([{ id: 1, inverse: 1 }, { id: 3, inverse: 1 }]);
    const sorted = q.rows({ select: { inverse: q.div(q.literal(1), q.field('zero')) }, orderBy: [{ expr: q.field('zero'), direction: 'desc' }] });
    expect((await sorted.evaluate(source(), { limit: 2 })).rows).toEqual([{ inverse: 1 }, { inverse: 1 }]);
    const constant = q.rows({ select: { bad: q.div(q.literal(1), q.literal(0)) }, where: q.literal(false) });
    expect((await constant.evaluate(source())).rows).toEqual([]);
    await expect(constant.evaluate(source(), {}, {})).resolves.toBeDefined();
    await expect(q.rows({ select: { bad: q.div(q.literal(1), q.literal(0)) } }).evaluate(source())).rejects.toThrow(RangeError);
  });
  it('shares a repeated expression per row only where it is demanded', async () => {
    const risky = q.div(q.literal(1), q.field('zero'));
    const plan = q.rows({ select: { safe: q.coalesce(q.field('amount'), risky), guarded: q.and(q.eq(q.field('zero'), q.literal(1)), q.gt(risky, q.literal(0))) } });
    const result = await plan.evaluate(source([{ id: 1, amount: 3, zero: 0 }, { id: 2, zero: 1 }]), {}, { profile: true });
    expect(result.rows).toEqual([{ safe: 3, guarded: false }, { safe: 1, guarded: true }]);
    // zero is read once per row although three expressions reference it; amount once per row.
    expect(result.summary.fieldReads).toBe(4);
  });
  it('sorts on hidden expressions and returns only the selected aliases', async () => {
    const plan = q.rows({ select: { id: q.field('id') }, orderBy: [{ expr: q.mul(q.field('qty'), q.literal(-1)) }, { expr: q.field('id'), direction: 'desc' }] });
    const result = await plan.evaluate(source(), { offset: 1, limit: 2 }, { count: 'exact' });
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.summary).toMatchObject({ strategy: 'top-k', totalResultRows: 4, hasMore: true, returnedRows: 2 });
  });
  it('pages with limit 0 and deep offsets and keeps page validation', async () => {
    const plan = q.rows({ select: { id: q.field('id') } });
    expect((await plan.evaluate(source(), { limit: 0 }, { count: 'exact' })).summary).toMatchObject({ returnedRows: 0, totalResultRows: 4, hasMore: true });
    expect((await plan.evaluate(source(), { offset: 99, limit: 5 })).rows).toEqual([]);
    expect(() => plan.stream(source(), { offset: -1 })).toThrow(RangeError);
    expect(() => plan.stream(source(), {}, { maxGroups: 2 ** 32 })).toThrow(RangeError);
  });
  it('fails on output larger than its own budget, independent of the input estimate, without completing', async () => {
    const plan = q.rows({ select: { id: q.field('id') } });
    await expect(plan.evaluate(source(), {}, { sizeOfOutput: () => 1000, maxOutputBytes: 2500 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(plan.evaluate(source(), {}, { maxOutputRows: 3 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const seen: string[] = [];
    await expect((async () => { for await (const event of plan.stream(source(), {}, { sizeOfOutput: () => 10 * 1024 * 1024 })) seen.push(event.type); })()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(seen).not.toContain('complete');
  });
});

describe('scalar aggregation (T09-T15)', () => {
  const total = q.field('amount');
  it('returns one global row on empty input and no rows for empty groups', async () => {
    const plan = q.aggregate({ measures: { n: q.count(), values: q.count(total), sum: q.sum(total), avg: q.avg(total), min: q.min(total), max: q.max(total), big: q.sumBigInt(q.literal(null)) } });
    expect((await plan.evaluate(source([]))).rows).toEqual([{ n: 0, values: 0, sum: null, avg: null, min: null, max: null, big: null }]);
    expect((await plan.evaluate(source([{ id: 1 }, { id: 2, amount: null }]))).rows).toEqual([{ n: 2, values: 0, sum: null, avg: null, min: null, max: null, big: null }]);
    expect((await q.aggregate({ groupBy: { id: q.field('id') }, measures: { n: q.count() } }).evaluate(source([]), {}, { count: 'exact' })).summary.totalResultRows).toBe(0);
  });
  it('applies the invalid-number policy to sums while count(x) counts every non-nullish value', async () => {
    const odd = [{ id: 1, tag: NaN }, { id: 2, tag: Infinity }, { id: 3, tag: '4' }, { id: 4, tag: true }, { id: 5, tag: 2 }];
    const plan = (invalidNumbers: 'error' | 'skip') => q.aggregate({ measures: { n: q.count(q.field('tag')), sum: q.sum(q.field('tag') as never), max: q.max(q.field('tag')) }, invalidNumbers });
    await expect(plan('error').evaluate(source(odd))).rejects.toThrow(TypeError);
    expect((await plan('skip').evaluate(source(odd))).rows).toEqual([{ n: 5, sum: 2, max: '4' }]);
    await expect(q.aggregate({ measures: { max: q.max(q.field('tag')) } }).evaluate(source([{ id: 1, tag: {} }]))).rejects.toThrow(TypeError);
  });
  it('implements compensated and sequential sums exactly, in source order, at every batch size', async () => {
    const rows = [{ id: 1, amount: 1e16 }, { id: 2, amount: 1 }, { id: 3, amount: -1e16 }, { id: 4, amount: 1 }];
    for (const batchSize of [1, 2, 3, 256]) {
      for (const [numberMode, expected] of [['sequential', 1], ['compensated', 2]] as const) {
        const plan = q.aggregate({ measures: { sum: q.sum(total), avg: q.avg(total) }, numberMode });
        expect((await plan.evaluate(source(rows), {}, { batchSize })).rows, `${numberMode} @${batchSize}`).toEqual([{ sum: expected, avg: expected / 4 }]);
      }
    }
  });
  it('throws RangeError on arithmetic or accumulator overflow and division by zero', async () => {
    await expect(q.aggregate({ measures: { s: q.sum(total) } }).evaluate(source([{ id: 1, amount: 1e308 }, { id: 2, amount: 1e308 }]))).rejects.toThrow(RangeError);
    await expect(q.aggregate({ measures: { a: q.avg(total) } }).evaluate(source([{ id: 1, amount: 1e308 }, { id: 2, amount: 1e308 }]))).rejects.toThrow(RangeError);
    await expect(q.rows({ select: { x: q.mul(total, q.literal(1e300)) } }).evaluate(source([{ id: 1, amount: 1e10 }]))).rejects.toThrow(RangeError);
    await expect(q.rows({ select: { x: q.div(total, q.field('zero')) } }).evaluate(source([{ id: 1, amount: 1, zero: 0 }]))).rejects.toThrow(RangeError);
  });
  it('fails a count before it could lose integer precision', () => {
    const column = new StateColumns({ kind: 'rows', arg: undefined, where: undefined }, new Ledger(1024), 'compensated');
    column.ensure(0); column.setCount(0, Number.MAX_SAFE_INTEGER - 1);
    column.countRow(0);
    expect(() => column.countRow(0)).toThrow(RangeError);
    expect(column.final(0, 'count')).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('sums BigInts beyond 64 bits exactly and reserves their growth', async () => {
    const huge = 2n ** 200n, rows = Array.from({ length: 8 }, (_, id) => ({ id, tag: huge }));
    const plan = q.aggregate({ measures: { big: q.sumBigInt(q.field('tag') as never) } });
    const result = await plan.evaluate(source(rows));
    expect(result.rows).toEqual([{ big: huge * 8n }]);
    expect(result.summary.peakWorkingBytes).toBeGreaterThan(40);
    await expect(plan.evaluate(source(rows), {}, { maxWorkingBytes: 30 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('keeps measures with different predicates apart and shares identical ones', async () => {
    const plan = q.aggregate({ measures: {
      flagged: q.sum(total, { where: q.eq(q.field('flag'), q.literal(true)) }), other: q.sum(total, { where: q.eq(q.field('flag'), q.literal(false)) }),
      mean: q.avg(total, { where: q.eq(q.field('flag'), q.literal(true)) }), all: q.sum(total),
    } });
    expect(plan.explain().states).toBe(3);
    expect((await plan.evaluate(source([{ id: 1, amount: 1, flag: true }, { id: 2, amount: 10, flag: false }, { id: 3, amount: 3, flag: true }]))).rows)
      .toEqual([{ flagged: 4, other: 10, mean: 2, all: 14 }]);
    await expect(q.aggregate({ measures: { n: q.count(undefined, { where: q.field('amount') as never }) } }).evaluate(source())).rejects.toThrow(TypeError);
  });
});

describe('page plus totals (T16, T17)', () => {
  const view = q.view({ select: { id: q.field('id') }, totals: { n: q.count(), total: q.sum(q.field('amount')) } });
  it('totals cover every match, including one after the page filled', async () => {
    const rows = [{ id: 1, amount: 1 }, { id: 2, amount: 2 }, { id: 3, amount: 1000 }];
    const result = await view.evaluate(source(rows), { limit: 1 });
    expect(result).toMatchObject({ rows: [{ id: 1 }], totals: { n: 3, total: 1003 }, summary: { scannedRows: 3, hasMore: true } });
  });
  it('reads page and totals from one snapshot even when the source is replaced mid-stream', async () => {
    const immutable = createImmutableArraySource<Row>(Array.from({ length: 20 }, (_, id) => ({ id, amount: 1 })));
    const seen: any[] = [];
    for await (const event of view.stream(immutable, { limit: 20 }, { batchSize: 2 })) {
      if (event.type === 'batch' && !seen.length) immutable.replace([{ id: 99, amount: 500 }]);
      seen.push(event);
    }
    const complete = seen.at(-1);
    expect(complete.totals).toEqual({ n: 20, total: 20 });
    expect(complete.summary.revision).toBe(0n);
    expect(seen.flatMap(e => e.type === 'batch' ? e.rows.map((r: Row) => r.id) : [])).toHaveLength(20);
  });
});

describe('lifecycle and source validation (T38-T44)', () => {
  const plan = q.aggregate({ measures: { n: q.count() } });
  it('aborts before open, during a pull and during output without a completion', async () => {
    const before = new AbortController(); before.abort();
    const opened = scripted([[{ id: 1 }]]);
    await expect(plan.evaluate(opened.src, {}, { signal: before.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(opened.log.opened).toBe(0);
    const during = new AbortController();
    const pulled = scripted([[{ id: 1 }], [{ id: 2 }]], { onPull: i => { if (i === 1) during.abort(); } });
    await expect(plan.evaluate(pulled.src, {}, { signal: during.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(pulled.log).toMatchObject({ closed: 1, returned: 1 });
    const output = new AbortController();
    const grouped = q.aggregate({ groupBy: { id: q.field('id') }, measures: {} });
    const types: string[] = [];
    await expect((async () => {
      for await (const event of grouped.stream(source(Array.from({ length: 10 }, (_, id) => ({ id }))), {}, { batchSize: 2, signal: output.signal })) { types.push(event.type); output.abort(); }
    })()).rejects.toMatchObject({ code: 'ABORTED' });
    expect(types).not.toContain('complete');
  });
  it('aborts while finalizing groups, after the scan, and still closes the source', async () => {
    // With scan yields disabled, the first host task is finalization's yield after 65,536 groups; the abort lands there.
    const controller = new AbortController();
    const rows = Array.from({ length: 70_000 }, (_, id) => ({ id }));
    const batches = Array.from({ length: Math.ceil(rows.length / 256) }, (_, i) => rows.slice(i * 256, (i + 1) * 256));
    let pulls = 0, pullsAtAbort = -1;
    const finalized = scripted(batches, { onPull: () => { pulls++; } });
    setImmediate(() => { pullsAtAbort = pulls; controller.abort(); });
    const grouped = q.aggregate({ groupBy: { id: q.field('id') }, measures: { n: q.count() } });
    await expect(grouped.evaluate(finalized.src, {}, { signal: controller.signal, sizeOf: () => 64, yieldEveryBatches: 0 })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(pullsAtAbort).toBe(batches.length + 1);
    expect(finalized.log).toMatchObject({ closed: 1, returned: 1 });
  });
  it('keeps the original failure first, then iterator-return and close failures', async () => {
    const broken = scripted([[{ id: 1 }]], { returnError: new Error('return failed'), closeError: new Error('close failed') });
    const failing = q.rows({ select: { id: q.field('id') }, where: q.field('amount') as never });
    const error = await failing.evaluate(broken.src).catch(e => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((e: Error) => e.message)).toEqual([expect.stringMatching(/Boolean/), 'return failed', 'close failed']);
  });
  it('closes the source and releases pinned columns when the consumer returns early', async () => {
    const cached = createImmutableArraySource<Row>(Array.from({ length: 50 }, (_, id) => ({ id })), { keyCache: {} });
    await cached.prepareKeys(['id']);
    const iterator = q.rows({ select: { id: q.field('id') } }).stream(cached, {}, { batchSize: 5 });
    expect((await iterator.next()).value).toMatchObject({ type: 'batch' });
    expect(cached.keyCacheStats?.pinnedEntries).toBe(1);
    await iterator.return(undefined);
    expect(cached.keyCacheStats?.pinnedEntries).toBe(0);
  });
  it('validates every external batch completely, including rows the plan would skip', async () => {
    const huge = { id: 2, tag: 'x'.repeat(5000) };
    const skipped = scripted([[{ id: 1 }, huge]]);
    await expect(q.aggregate({ measures: { n: q.count() }, filters: [{ field: 'id', op: 'eq', value: 1 }] }).evaluate(skipped.src, {}, { maxRowBytes: 1000 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(plan.evaluate(scripted([[{ id: 1 }]], { count: 3 }).src)).rejects.toMatchObject({ code: 'SOURCE_CONTRACT' });
    await expect(plan.evaluate(scripted([{ id: 1 }]).src)).rejects.toMatchObject({ code: 'SOURCE_CONTRACT' });
    await expect(plan.evaluate(scripted([[]]).src)).rejects.toMatchObject({ code: 'SOURCE_CONTRACT' });
  });
  it('treats a decorated built-in session as external: no trusted sizes, no leased columns', async () => {
    const cached = createImmutableArraySource<Row>([{ id: 1, amount: 2 }], { keyCache: {} });
    await cached.prepareKeys(['amount']);
    const decorated: RecordSource<Row> = { async open(options) { const s = await cached.open(options); return Object.assign(s, { scan: s.scan.bind(s) }); } };
    const direct = await q.aggregate({ measures: { s: q.sum(q.field('amount')) } }).evaluate(cached);
    const wrapped = await q.aggregate({ measures: { s: q.sum(q.field('amount')) } }).evaluate(decorated);
    expect(wrapped.rows).toEqual(direct.rows);
    expect(direct.summary.cacheBytesPinned).toBeGreaterThan(0);
    expect(wrapped.summary.cacheBytesPinned).toBe(0);
  });
  it('aggregates exactly the supplied DBSONL key range', async () => {
    const db = await openDbsonl<{ amount: number }>(createMemoryBackend(), 'compute', { create: true });
    try {
      await db.batch(Array.from({ length: 30 }, (_, n) => ({ operation: 'put' as const, key: `k${String(n).padStart(2, '0')}`, value: { amount: n } })));
      const cq = forRows<{ key: string; value: { amount: number } }>();
      const totals = cq.aggregate({ measures: { n: cq.count(), total: cq.sum(cq.number(cq.path('value.amount'))) } });
      expect((await totals.evaluate(createDbsonlSource(db, { gte: 'k10', lt: 'k20' }))).rows).toEqual([{ n: 10, total: 145 }]);
      expect((await totals.evaluate(createDbsonlSource(db))).summary).toMatchObject({ sourceRows: 30, totalInputMatches: 30 });
    } finally { await db.close(); }
  });
  it('reports DataviewError codes from the shared error class', () => { expect(new DataviewError('ABORTED', 'x').code).toBe('ABORTED'); });
});
