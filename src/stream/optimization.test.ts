import { describe, it, expect } from 'vitest';
import { estimateRowBytes as baselineSize } from '../../tests/reference/stream.mjs';
import { compileQuery as baselineQuery } from '../../tests/reference/query.mjs';
import { compileQuery } from '../query.js';
import type { DataviewFilterOperator } from '../types.js';
import { batchRows, createArraySource, createImmutableArraySource, estimateRowBytes, evaluateStream, streamQuery } from '../stream.js';
import type { RecordSource } from './types.js';

describe('optimized execution invariants', () => {
  it('measures each built-in input once, independently of top-k admissions and collection', async () => {
    const rows = Array.from({ length: 1000 }, (_, id) => ({ id, score: id % 37 }));
    for (const source of [createArraySource(rows), createArraySource(rows, { isolation: 'immutable' }), createImmutableArraySource(rows)]) {
      let calls = 0;
      const result = await evaluateStream(source, { sorters: [{ field: 'score', direction: 'desc' }], limit: 10 }, { sizeOf: row => { calls++; return estimateRowBytes(row); } });
      expect(result.rows.map(row => row.id)).toEqual([36, 73, 110, 147, 184, 221, 258, 295, 332, 369]);
      expect(calls).toBe(1000);
      expect(result.summary.peakBufferedRows).toBe(10);
    }
  });
  it('does not trust sizes from an external batch or batchRows wrapper', async () => {
    let closed = 0;
    const source: RecordSource<{ payload: string }> = { async open() { return {
      consistency: 'snapshot', revision: 1,
      async *scan(o) {
        for await (const batch of batchRows([{ payload: 'a' }], o)) {
          batch[0].payload = 'x'.repeat(1000);
          Object.assign(batch, { sizes: [0], bytes: 0 });
          yield batch;
        }
      },
      async close() { closed++; },
    }; } };
    await expect(evaluateStream(source, {}, { maxRowBytes: 100 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(closed).toBe(1);
  });
  it('validates modified built-in session scans and unexamined batch remainders', async () => {
    const base = createArraySource([{ n: 1 }, { n: 2 }]);
    let closed = 0;
    const source: RecordSource<{ n: number }> = { async open() {
      const session = await base.open();
      session.scan = async function* () { yield [{ n: 1 }, { n: 999 }]; };
      const close = session.close; session.close = async () => { closed++; await close(); };
      return session;
    } };
    await expect(evaluateStream(source, { limit: 1 }, { sizeOf: row => row.n, maxRowBytes: 2 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(closed).toBe(1);
  });
  it('checks aggregate external batch bytes even when each row fits', async () => {
    let closed = false;
    const source: RecordSource<{ n: number }> = { async open() { return {
      consistency: 'snapshot', revision: 1,
      async *scan() { yield [{ n: 1 }, { n: 2 }]; },
      async close() { closed = true; },
    }; } };
    await expect(evaluateStream(source, { limit: 1 }, { sizeOf: () => 2, maxBatchBytes: 3 })).rejects.toMatchObject({ code: 'SOURCE_CONTRACT' });
    expect(closed).toBe(true);
  });
  it('rejects a closed built-in session while using its direct measured scanner', async () => {
    const session = await createArraySource([{ n: 1 }, { n: 2 }]).open();
    const iterator = streamQuery({ async open() { return session; } }, {}, { batchSize: 1 });
    expect((await iterator.next()).value).toMatchObject({ rows: [{ n: 1 }] });
    await session.close();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('never reuses sizes across queries, estimators or changed input rows', async () => {
    const rows = [{ n: 1 }], source = createArraySource(rows);
    expect((await evaluateStream(source, {}, { sizeOf: () => 1, maxBufferedBytes: 1 })).rows).toHaveLength(1);
    await expect(evaluateStream(source, {}, { sizeOf: () => 2, maxBufferedBytes: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    rows[0].n = 99;
    await expect(evaluateStream(source, {}, { sizeOf: row => row.n, maxRowBytes: 10 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('keeps collector byte limits exact for unsorted, full-sort and top-k outputs', async () => {
    const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
    for (const request of [{}, { sorters: [{ field: 'n' }] }, { sorters: [{ field: 'n' }], limit: 3 }]) {
      const result = await evaluateStream(createImmutableArraySource(rows), request, { sizeOf: row => row.n, maxBufferedBytes: 102, maxBatchBytes: 4, batchSize: 2 });
      expect(result.rows).toEqual(rows);
    }
    await expect(evaluateStream(createImmutableArraySource(rows), {}, { sizeOf: row => row.n, maxBufferedBytes: 5, maxBatchBytes: 4 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await evaluateStream(createImmutableArraySource(rows), {}, { sizeOf: row => row.n, maxBufferedBytes: 6, maxBatchBytes: 4 })).rows).toEqual(rows);
  });
  it('accounts admitted replacements before mutating the heap, and skips rejected large candidates', async () => {
    const request = { sorters: [{ field: 'n', direction: 'desc' as const }], limit: 1 };
    await expect(evaluateStream(createArraySource([{ n: 1, size: 1 }, { n: 2, size: 100 }]), request, { sizeOf: r => r.size, maxBufferedBytes: 100 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const result = await evaluateStream(createArraySource([{ n: 2, size: 1 }, { n: 1, size: 100 }]), request, { sizeOf: r => r.size, maxBufferedBytes: 33 });
    expect(result.rows).toEqual([{ n: 2, size: 1 }]);
    expect(result.summary.peakBufferedBytes).toBe(33);
    const zero = await evaluateStream(createArraySource([{ n: 1 }]), { ...request, limit: 0 });
    expect(zero.rows).toEqual([]); expect(zero.summary.peakBufferedRows).toBe(0);
  });
  it('pins membership/revision across replacements and concurrent sessions without recopying at open', async () => {
    const rows = [{ n: 1 }, { n: 2 }], source = createImmutableArraySource(rows);
    rows.push({ n: 99 });
    const first = streamQuery(source, {}, { batchSize: 1 });
    expect((await first.next()).value).toMatchObject({ rows: [{ n: 1 }] });
    const replacement = [{ n: 3 }];
    expect(source.replace(replacement)).toBe(1n); replacement.push({ n: 100 });
    expect(source.count).toBe(1); expect(source.revision).toBe(1n);
    const latest = await evaluateStream(source); expect(latest.rows).toEqual([{ n: 3 }]); expect(latest.summary.revision).toBe(1n);
    expect((await first.next()).value).toMatchObject({ rows: [{ n: 2 }] });
    expect((await first.next()).value).toMatchObject({ type: 'complete', summary: { revision: 0n, sourceRows: 2 } });
    expect(source.replace([])).toBe(2n);
    expect((await evaluateStream(source)).summary.totalMatches).toBe(0);
    await expect(source.open({ signal: { aborted: true } })).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('keeps replacement accounting exact at the safe-integer boundary', async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const source = createArraySource([{ n: 1, bytes: max - 33 }, { n: 2, bytes: max - 32 }]);
    await expect(evaluateStream(source, { sorters: [{ field: 'n', direction: 'desc' }], limit: 1 }, {
      sizeOf: row => row.bytes, maxRowBytes: max, maxBatchBytes: max, maxBufferedBytes: max - 1,
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('retains fairness and aborts measured in-memory scans on a host timer', async () => {
    const source = createImmutableArraySource(Array.from({ length: 10000 }, (_, n) => ({ n })));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timer'), 0);
    try {
      await expect(evaluateStream(source, { filters: [{ field: 'n', op: 'gt', value: 20000 }] }, { signal: controller.signal, yieldEveryBatches: 1, batchSize: 4 })).rejects.toMatchObject({ code: 'ABORTED', cause: 'timer' });
    } finally { clearTimeout(timer); }
  });
  it('preserves byte accounting for cyclic graphs, aliases, exotic values and all binary traversal orders', () => {
    const binary = new Uint8Array(257), view = new DataView(binary.buffer, 7, 8);
    const symbol = Symbol('field');
    const root: Record<string | symbol, unknown> = { binary, view, backing: binary.buffer, number: NaN, big: -123456789n, text: 'abc', undef: undefined, nil: null, [symbol]: true };
    root.self = root; root.map = new Map([[root, new Set([root, new Date(42), binary])]]);
    Object.defineProperty(root, 'hidden', { value: 3 });
    const values: unknown[] = [root, 1, -0, Infinity, NaN, 12345678901234567890n, null, undefined, 'x', symbol, () => 1, new Date(NaN), binary, view, binary.buffer, [], new Map(), new Set()];
    for (const a of [binary, view, binary.buffer]) for (const b of [binary, view, binary.buffer]) values.push({ a, b }, [a, b], new Map([[a, b]]));
    let seed = 93;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 200; i++) {
      const graph: Record<string, unknown>[] = Array.from({ length: 10 }, () => ({}));
      for (const node of graph) for (let j = 0; j < 6; j++) node[String(j)] = random() % 2 ? values[random() % values.length] : graph[random() % graph.length];
      expect(estimateRowBytes(graph)).toBe(baselineSize(graph));
    }
    for (const value of values) expect(estimateRowBytes(value)).toBe(baselineSize(value));
    let accessed = false;
    expect(() => estimateRowBytes({ get x() { accessed = true; return 1; } })).toThrow('data properties');
    expect(accessed).toBe(false);
  });
  it('preserves all filter operators and mixed-type ordering across specialization guards', () => {
    const binary = new Uint8Array([1, 2]), opaque = {}, invalid = new Date(NaN);
    const values: unknown[] = [false, true, -Infinity, -0, 1, Infinity, NaN, -2n, 42n, 'Z', 'ab', '', new Date(1), invalid, binary, new DataView(binary.buffer), binary.buffer, opaque, {}, [], [1, 2], Symbol('x'), null, undefined];
    const ops: DataviewFilterOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'endsWith'];
    for (const semantics of [{}, { equality: 'identity' as const }, { strings: 'locale' as const, locale: 'en' }]) {
      for (const op of ops) for (const value of [...values, values]) {
        const request = { filters: [{ field: 'v', op, value }], semantics };
        const actual = compileQuery(request), expected = baselineQuery(request);
        for (const v of values) expect(actual.matches({ v })).toBe(expected.matches({ v }));
      }
      for (const direction of ['asc', 'desc'] as const) {
        const request = { sorters: [{ field: 'v', direction }], semantics };
        const actual = compileQuery(request), expected = baselineQuery(request);
        for (const a of values) for (const b of values) expect(Math.sign(actual.compare({ v: a }, { v: b }))).toBe(Math.sign(expected.compare({ v: a }, { v: b })));
      }
    }
  });
  it('rechecks identity Date operands after mutation without changing value-mode capture', () => {
    const value = new Date(NaN);
    const identity = compileQuery({ filters: [{ field: 'date', op: 'gte', value }], semantics: { equality: 'identity' } });
    const captured = compileQuery({ filters: [{ field: 'date', op: 'gte', value }] });
    value.setTime(1);
    expect(identity.matches({ date: new Date(2) })).toBe(true);
    expect(captured.matches({ date: new Date(2) })).toBe(false);
    value.setTime(NaN);
    expect(identity.matches({ date: new Date(2) })).toBe(false);
  });
});
