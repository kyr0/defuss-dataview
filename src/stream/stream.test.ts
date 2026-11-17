import { describe, expect, it } from 'vitest';
import { createDataview, evaluateDataview } from '../index.js';
import { compileQuery } from '../query.js';
import { createArraySource, evaluateStream, streamQuery, toStreamRequest, estimateRowBytes, batchRows, DEFAULT_STREAM_LIMITS } from '../stream.js';
import type { RecordSource, StreamRequest } from './types.js';

type Row = { id: number; n: number; text?: string };
/** Real generator source with optional unknown count; each open gets an isolated cursor. */
function generated(count: number, known = false) {
  const state = { opens: 0, closes: 0, returns: 0, pulls: 0 };
  const source: RecordSource<Row> = {
    async open() {
      state.opens++;
      return {
        consistency: 'snapshot', revision: 'generated-v1', count: known ? count : undefined,
        scan(options) {
          async function* rows() {
            try { for (let id = 0; id < count; id++) { state.pulls++; yield { id, n: id % 7 }; } }
            finally { state.returns++; }
          }
          return batchRows(rows(), options);
        },
        async close() { state.closes++; },
      };
    },
  };
  return { source, state };
}

describe('stream execution', () => {
  it('matches independent global sorting and array evaluation across 180 seeded queries and arbitrary batches', async () => {
    let seed = 591;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const rows = Array.from({ length: 139 }, (_, id) => ({ id, n: Math.floor(random() * 17) }));
    for (let run = 0; run < 180; run++) {
      const value = run % 17, offset = run % 23, limit = run % 11, desc = run % 2 === 0, sorted = run % 3 !== 0;
      const request: StreamRequest = { filters: [{ field: 'n', op: 'gte', value }], sorters: sorted ? [{ field: 'n', direction: desc ? 'desc' : 'asc' }] : [], offset, limit };
      const matches = rows.filter(r => r.n >= value);
      if (sorted) matches.sort((a, b) => (desc ? -1 : 1) * (a.n - b.n));
      const result = await evaluateStream(createArraySource(rows), request, { batchSize: 1 + run % 19, count: 'exact' });
      expect(result.rows).toEqual(matches.slice(offset, offset + limit));
      expect(result.summary.totalMatches).toBe(matches.length);
      expect(result.summary.hasMore).toBe(matches.length > offset + limit);
      expect(result.summary.sourceExhausted).toBe(true);
      const array = evaluateDataview(rows, createDataview({ filters: request.filters ? [...request.filters] : [], sorters: request.sorters ? [...request.sorters] : [] }));
      expect(result.rows).toEqual(array.entries.map(e => e.row).slice(offset, offset + limit));
      if (sorted) expect(result.summary.peakBufferedRows).toBeLessThanOrEqual(offset + limit);
    }
  });
  it('distinguishes observed matches, exact totals, exhaustion and page completion', async () => {
    const { source, state } = generated(1000);
    const result = await evaluateStream(source, { filters: [{ field: 'n', op: 'eq', value: 3 }], offset: 2, limit: 3 }, { batchSize: 4 });
    expect(result.rows.map(r => r.id)).toEqual([17, 24, 31]);
    expect(result.summary).toMatchObject({ totalMatches: null, sourceRows: null, observedMatches: 6, returnedRows: 3, sourceExhausted: false, hasMore: true });
    expect(state).toMatchObject({ opens: 1, closes: 1, returns: 1 });
    expect(state.pulls).toBeLessThan(50);
  });
  it('uses a source count only for unfiltered totals and scoped full-source rows', async () => {
    const a = await evaluateStream(generated(100, true).source, { limit: 2 }, { count: 'exact', batchSize: 2 });
    expect(a.summary).toMatchObject({ sourceRows: 100, totalMatches: 100, scannedRows: 2, sourceExhausted: false, hasMore: true });
    const b = await evaluateStream(generated(100, true).source, { filters: [{ field: 'n', op: 'eq', value: 4 }], limit: 2 }, { count: 'exact' });
    expect(b.summary.totalMatches).toBe(14);
    expect(b.summary.sourceExhausted).toBe(true);
  });
  it('closes on consumer break and does not prefetch while paused', async () => {
    const { source, state } = generated(1000);
    const iterator = streamQuery(source, {}, { batchSize: 3 });
    expect(state.opens).toBe(0);
    expect((await iterator.next()).value).toMatchObject({ type: 'batch', rows: [{ id: 0 }, { id: 1 }, { id: 2 }] });
    expect(state.pulls).toBe(3);
    await iterator.return(undefined);
    expect(state).toMatchObject({ closes: 1, returns: 1, pulls: 3 });
  });
  it('cancels cooperatively and releases the iterator and snapshot', async () => {
    const { source, state } = generated(20);
    const controller = new AbortController();
    const iterator = streamQuery(source, {}, { batchSize: 2, signal: controller.signal });
    await iterator.next(); controller.abort('stop');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ABORTED', cause: 'stop' });
    expect(state.closes).toBe(1);
    const other = generated(10);
    await expect(evaluateStream(other.source, {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(other.state.opens).toBe(0);
  });
  it('cleans up after cancellation during asynchronous open', async () => {
    const base = generated(4), signal = { aborted: false };
    const source: RecordSource<Row> = { async open() { const session = await base.source.open(); signal.aborted = true; return session; } };
    await expect(evaluateStream(source, {}, { signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(base.state.closes).toBe(1);
  });
  it('never confuses locale order with code-unit order', async () => {
    const rows = [{ id: 1, n: 0, text: 'Z' }, { id: 2, n: 0, text: 'a' }];
    const ordering = compileQuery({ sorters: [{ field: 'text' }] }).ordering;
    const source = createArraySource(rows, { ordering });
    const fast = await evaluateStream(source, { sorters: [{ field: 'text' }], limit: 1 });
    expect(fast.summary.strategy).toBe('ordered'); expect(fast.rows[0].text).toBe('Z');
    const locale = await evaluateStream(source, { sorters: [{ field: 'text' }], semantics: { strings: 'locale', locale: 'en' }, limit: 1 });
    expect(locale.summary.strategy).toBe('top-k'); expect(locale.rows[0].text).toBe('a');
  });
  it('sorts all rows within an explicit budget and preserves ties', async () => {
    const result = await evaluateStream(generated(30).source, { sorters: [{ field: 'n' }] }, { batchSize: 3 });
    expect(result.summary.strategy).toBe('sort');
    expect(result.rows.filter(r => r.n === 0).map(r => r.id)).toEqual([0, 7, 14, 21, 28]);
    expect(result.rows.length).toBe(30);
  });
  it('rejects top-k, whole-sort, collector, row, byte and scan budget overflow and closes', async () => {
    const cases: Array<[StreamRequest, Parameters<typeof evaluateStream<Row>>[2]]> = [
      [{ sorters: [{ field: 'n' }], offset: 5, limit: 5 }, { maxBufferedRows: 9 }],
      [{ sorters: [{ field: 'n' }] }, { maxBufferedRows: 3 }],
      [{}, { maxBufferedRows: 3 }],
      [{}, { maxRowBytes: 1 }],
      [{ sorters: [{ field: 'n' }], limit: 4 }, { maxBufferedBytes: 1 }],
      [{}, { maxBufferedBytes: 1 }],
      [{ filters: [{ field: 'n', op: 'gt', value: 50 }] }, { maxScannedRows: 5 }],
    ];
    for (const [request, options] of cases) {
      const { source, state } = generated(50);
      await expect(evaluateStream(source, request, options)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(state.closes).toBe(1);
    }
  });
  it('streams output larger than the collector limit without retaining it', async () => {
    let count = 0;
    for await (const event of streamQuery(generated(1000).source, {}, { batchSize: 7, maxBufferedRows: 3 })) {
      if (event.type === 'batch') { expect(event.rows.length).toBeLessThanOrEqual(7); count += event.rows.length; }
      else expect(event.summary).toMatchObject({ returnedRows: 1000, sourceExhausted: true, hasMore: false });
    }
    expect(count).toBe(1000);
  });
  it('captures query mutation and clones source data on open', async () => {
    const rows = [{ id: 1, n: 2 }, { id: 2, n: 3 }];
    const request = { filters: [{ field: 'n', op: 'gte' as const, value: 2 }], limit: 2 };
    const iterator = streamQuery(createArraySource(rows), request, { batchSize: 1 });
    request.filters[0].value = 100;
    const first = await iterator.next(); rows[1].n = 999; rows.push({ id: 3, n: 4 });
    expect(first.value).toMatchObject({ rows: [{ id: 1, n: 2 }] });
    expect((await iterator.next()).value).toMatchObject({ rows: [{ id: 2, n: 3 }] });
    await iterator.return(undefined);
  });
  it('returns exact zero results and validates requests before opening', async () => {
    expect((await evaluateStream(generated(0).source)).summary).toMatchObject({ totalMatches: 0, sourceRows: 0, hasMore: false, sourceExhausted: true });
    const g = generated(2);
    for (const limit of [-1, NaN, Infinity, 0.1]) expect(() => streamQuery(g.source, { limit })).toThrow(RangeError);
    expect(() => streamQuery(g.source, { offset: Number.MAX_SAFE_INTEGER, limit: 1 })).toThrow();
    expect(g.state.opens).toBe(0);
    expect(toStreamRequest(createDataview({ page: 3, pageSize: 4 }))).toMatchObject({ offset: 12, limit: 4 });
    expect(() => toStreamRequest(createDataview({ tree: { idField: 'id', parentIdField: 'parent' } }))).toThrow();
  });
  it('bounds bytes across variable-size batches', async () => {
    const rows = Array.from({ length: 20 }, (_, id) => ({ id, n: id, text: 'a'.repeat(id * 10) }));
    let count = 0;
    for await (const e of streamQuery(createArraySource(rows), {}, { maxBatchBytes: 700, maxRowBytes: 700, batchSize: 20 })) {
      if (e.type === 'batch') { expect(e.rows.reduce((n, r) => n + estimateRowBytes(r), 0)).toBeLessThanOrEqual(700); count += e.rows.length; }
    }
    expect(count).toBe(20);
  });
  it('accounts cycles and binary backing stores, and rejects getters', () => {
    const value: Record<string, unknown> = {}; value.self = value;
    expect(estimateRowBytes(value)).toBeGreaterThan(32);
    const bytes = new Uint8Array(4096);
    expect(estimateRowBytes({ bytes: bytes.subarray(0, 1) })).toBeGreaterThan(4096);
    expect(() => estimateRowBytes({ get bad() { throw new Error('must not execute'); } })).toThrow('data properties');
    expect(estimateRowBytes(new Map([[1n, new Set([new Date(), 'x'])]]))).toBeGreaterThan(0);
  });
  it('surfaces source and cleanup failures together without dropping either resource', async () => {
    let returned = false, closed = false;
    const source: RecordSource<Row> = { async open() { return {
      consistency: 'snapshot', revision: 0,
      scan() { return { [Symbol.asyncIterator]() { return {
        async next() { throw new Error('read failed'); },
        async return() { returned = true; throw new Error('return failed'); },
      }; } }; },
      async close() { closed = true; throw new Error('close failed'); },
    }; } };
    const error = await evaluateStream(source).catch(e => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((e: Error) => e.message)).toEqual(['read failed', 'return failed', 'close failed']);
    expect(returned && closed).toBe(true);
  });
  it('rejects incorrect batch and count claims', async () => {
    for (const mode of ['empty', 'oversized', 'too-few', 'too-many', 'live'] as const) {
      let closed = false;
      const source: RecordSource<Row> = { async open() { return {
        consistency: mode === 'live' ? 'live' as 'snapshot' : 'snapshot', revision: 0,
        count: mode === 'too-few' ? 2 : mode === 'too-many' ? 0 : undefined,
        async *scan() { yield mode === 'empty' ? [] : Array.from({ length: mode === 'oversized' ? 3 : 1 }, (_, id) => ({ id, n: 0 })); },
        async close() { closed = true; },
      }; } };
      await expect(evaluateStream(source, {}, { batchSize: 2 })).rejects.toMatchObject({ code: 'SOURCE_CONTRACT' });
      expect(closed).toBe(true);
    }
  });
  it('rejects a paused array iterator after close, including its final pending row', async () => {
    const session = await createArraySource([{ id: 1 }, { id: 2 }]).open();
    const options = { batchSize: 2, maxBatchBytes: 1, maxRowBytes: 1, sizeOf: () => 1 };
    const iterator = session.scan(options)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual([{ id: 1 }]);
    await session.close();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CLOSED' });
    expect(() => session.scan(options)).toThrow('closed');
  });
  it('uses defaults for explicitly undefined options and rejects malformed query arrays', async () => {
    const result = await evaluateStream(generated(2).source, {}, { batchSize: undefined, maxBufferedBytes: undefined });
    expect(result.rows.length).toBe(2);
    expect(() => compileQuery({ filters: null as never })).toThrow(TypeError);
    expect(() => compileQuery({ sorters: false as never })).toThrow(TypeError);
  });
  it('allows timer-driven cancellation of an in-memory scan', async () => {
    const controller = new AbortController(), g = generated(100_000);
    const timer = setTimeout(() => controller.abort('scheduled'), 0);
    try {
      await expect(evaluateStream(g.source, { filters: [{ field: 'n', op: 'gt', value: 100 }] }, { batchSize: 8, yieldEveryBatches: 1, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED', cause: 'scheduled' });
      expect(g.state.pulls).toBeLessThan(100_000); expect(g.state.closes).toBe(1);
    } finally { clearTimeout(timer); }
  });
  it('preserves collector admission failures together with cleanup failures', async () => {
    const source: RecordSource<Row> = { async open() { return {
      consistency: 'snapshot', revision: 0,
      async *scan() { yield [{ id: 1, n: 1 }, { id: 2, n: 2 }]; },
      async close() { throw new Error('collector-close'); },
    }; } };
    const error = await evaluateStream(source, {}, { maxBufferedRows: 1 }).catch(e => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(error.errors[1].errors[0].message).toBe('collector-close');
  });
  it('limits default values are immutable', () => { expect(Object.isFrozen(DEFAULT_STREAM_LIMITS)).toBe(true); });
});
