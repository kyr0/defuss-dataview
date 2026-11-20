import { describe, expect, it } from 'vitest';
import { openDbsonl, createMemoryBackend } from 'defuss-dbsonl';
import { forRows } from '../compute.js';
import type { PartialAggregate } from '../compute.js';
import { createArraySource, createImmutableArraySource } from '../stream.js';
import { compileQuery } from '../query.js';
import { createDbsonlSource } from '../adapters/dbsonl.js';
import { exactSum } from '../../tests/compute/oracle.js';

type Doc = { cat?: unknown; amount?: number | null; big?: bigint | null; when?: Date; label?: string; flag?: boolean };
type Rec = { key: string; value: Doc; revision: number };
const r = forRows<Rec>();
const v = (name: keyof Doc) => r.path(`value.${name}`);
const amount = r.number(v('amount'));
const CATS: unknown[] = ['a', 'b', 1, 1n, true, null, undefined, NaN, 0, -0, 2.5];
function docs(n: number): Doc[] {
  let seed = 17;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  return Array.from({ length: n }, (_, i) => {
    const doc: Doc = { label: `x${Math.floor(next() * 5)}`, flag: next() < 0.5, when: new Date(1_700_000_000_000 + Math.floor(next() * 4) * 86_400_000) };
    if (next() < 0.9) doc.cat = CATS[Math.floor(next() * CATS.length)];
    if (next() < 0.9) doc.amount = next() < 0.1 ? null : (next() - 0.4) * 10 ** Math.floor(next() * 18) * (i % 7 === 0 ? 1e-9 : 1);
    if (next() < 0.8) doc.big = BigInt(Math.floor(next() * 1e6)) * (next() < 0.1 ? 10n ** 30n : 1n);
    return doc;
  });
}
async function database(n: number) {
  const db = await openDbsonl<Doc>(createMemoryBackend(), 'partials', { create: true });
  await db.batch(docs(n).map((value, i) => ({ operation: 'put' as const, key: String(i).padStart(4, '0'), value })));
  return db;
}
const ranges = (splits: string[]) => [undefined, ...splits].map((gte, i) => ({ gte, lt: splits[i] }));
const grouped = {
  groupBy: { cat: v('cat'), label: v('label') },
  measures: {
    n: r.count(), amounts: r.count(v('amount')), total: r.sum(amount), mean: r.avg(amount), low: r.min(amount), high: r.max(v('label')),
    first: r.min(v('when')), big: r.sumBigInt(v('big') as never), flagged: r.sum(amount, { where: r.eq(v('flag'), r.literal(true)) }),
  },
  numberMode: 'exact' as const,
};

describe('partial aggregates merged over key ranges', () => {
  it('equal one pass over the whole snapshot, also after a structured clone, in first-encounter order', async () => {
    const db = await database(600);
    try {
      for (const descriptor of [grouped, { ...grouped, having: [{ field: 'n', op: 'gte' as const, value: 3 }], orderBy: [{ field: 'total', direction: 'desc' as const }] }]) {
        const plan = r.aggregate(descriptor);
        const whole = await plan.evaluate(createDbsonlSource(db), { offset: 1, limit: 25 }, { count: 'exact' });
        for (const splits of [[], ['0150'], ['0100', '0333', '0334', '0599']]) {
          const partials = await Promise.all(ranges(splits).map(range => plan.partial(createDbsonlSource(db, range), { batchSize: 32 })));
          const merged = await plan.merge(partials.map(p => structuredClone(p)), { offset: 1, limit: 25 });
          expect(merged.rows, splits.join()).toEqual(whole.rows);
          expect(merged.summary).toMatchObject({
            revision: whole.summary.revision, scannedRows: 600, sourceRows: 600, totalInputMatches: 600, observedInputMatches: 600,
            totalResultRows: whole.summary.totalResultRows, returnedRows: whole.summary.returnedRows, hasMore: whole.summary.hasMore,
            sourceExhausted: true, strategy: 'merge', cacheBytesPinned: 0, fieldReads: null,
          });
          expect(merged.summary.peakGroups).toBe(whole.summary.peakGroups);
        }
      }
    } finally { await db.close(); }
  });
  it('reject partials of two snapshot revisions and merge partials pinned to one head', async () => {
    const db = await database(20);
    const session = await db.beginRead();
    try {
      const plan = r.aggregate({ measures: { n: r.count() } });
      const before = await plan.partial(createDbsonlSource(db, { lt: '0010' }));
      await db.put('0020', { label: 'added' });
      const after = await plan.partial(createDbsonlSource(db, { gte: '0010' }));
      await expect(plan.merge([before, after])).rejects.toMatchObject({ code: 'SOURCE_CONTRACT' });
      expect((await plan.merge([before])).rows).toEqual([{ n: 10 }]);
      const parts = await session.split(3);
      const pinned = await Promise.all(parts.map(({ gte, lt }) => plan.partial(createDbsonlSource(db, { gte, lt, at: session.head }))));
      expect((await plan.merge(pinned)).rows).toEqual([{ n: 20 }]);
    } finally { await session.close(); await db.close(); }
  });
  it('merges a scalar plan, also with empty parts, into the global row', async () => {
    const s = forRows<{ x?: number | null; b?: bigint }>();
    const plan = s.aggregate({ measures: { n: s.count(), s: s.sum(s.field('x')), b: s.sumBigInt(s.field('b')) }, numberMode: 'exact' });
    const part = (rows: object[]) => plan.partial(createArraySource(rows, { isolation: 'immutable', revision: 'r' }));
    const merged = await plan.merge([await part([]), await part([{ x: 0.1, b: 1n }, { x: null }]), await part([]), await part([{ x: 0.2, b: 2n }])]);
    expect(merged.rows).toEqual([{ n: 3, s: 0.30000000000000004, b: 3n }]);
    expect((await plan.merge([await part([])])).rows).toEqual([{ n: 0, s: null, b: null }]);
  });
  it('keeps the first partial representative and the first tie, and copies binary extremes to their visible bytes', async () => {
    const q = forRows<{ k: unknown; m: unknown }>();
    const plan = q.aggregate({ groupBy: { k: q.field('k') }, measures: { low: q.min(q.field('m')), high: q.max(q.field('m')) } });
    const backing = new Uint8Array(1 << 20); backing.set([5, 6], 10);
    // Input accounting would charge the backing store; a fixed sizeOf isolates the copy of the extremes.
    const part = (rows: object[]) => plan.partial(createArraySource(rows as never, { isolation: 'immutable' }), { sizeOf: () => 64 });
    const first = await part([{ k: 0, m: 0 }, { k: 'bin', m: backing.subarray(10, 12) }]), second = await part([{ k: -0, m: -0 }, { k: 'bin', m: new Uint8Array([5, 6]) }]);
    const binary = first.states.map(s => (s as { values: unknown[] }).values[1] as Uint8Array);
    expect(binary.map(b => b.buffer.byteLength)).toEqual([2, 2]);
    const { rows } = await plan.merge([first, second]);
    expect(Object.is(rows[0].k, 0) && Object.is(rows[0].low, 0) && Object.is(rows[0].high, 0)).toBe(true);
    const reversed = await plan.merge([second, first]);
    expect(Object.is(reversed.rows[0].k, -0) && Object.is(reversed.rows[0].low, -0)).toBe(true);
    expect(rows[1]).toEqual({ k: 'bin', low: new Uint8Array([5, 6]), high: new Uint8Array([5, 6]) });
  });
});

describe('exact sums', () => {
  const q = forRows<{ x: number }>();
  const exact = q.aggregate({ measures: { s: q.sum(q.field('x')), m: q.avg(q.field('x')) }, numberMode: 'exact' });
  const values = [1e16, 1, -1e16, 1, 0.1, 0.2, 0.3, -0.6, 2 ** -1060, 3e300, -3e300, 1e-300, 123456.789, -123456.788];
  const rows = values.map(x => ({ x }));
  it('round once, so the result is independent of order, batch size and partitioning', async () => {
    const expected = exactSum(values);
    expect(expected).not.toBe(values.reduce((a, b) => a + b, 0));
    for (const order of [rows, [...rows].reverse(), [...rows.slice(7), ...rows.slice(0, 7)]]) for (const batchSize of [1, 3, 256]) {
      const { rows: [out] } = await exact.evaluate(createArraySource(order, { isolation: 'immutable' }), {}, { batchSize });
      expect(out).toEqual({ s: expected, m: expected / values.length });
    }
    for (let cut = 0; cut <= rows.length; cut++) {
      const parts = await Promise.all([rows.slice(0, cut), rows.slice(cut)].map(part => exact.partial(createArraySource(part, { isolation: 'immutable' }))));
      expect((await exact.merge(parts)).rows[0].s, `cut ${cut}`).toBe(expected);
    }
  });
  it('keep signed zeros and fail on an overflowing running sum', async () => {
    const run = (xs: number[]) => exact.evaluate(createArraySource(xs.map(x => ({ x })), { isolation: 'immutable' }));
    expect(Object.is((await run([-0, -0])).rows[0].s, -0)).toBe(true);
    expect(Object.is((await run([-0, 0])).rows[0].s, 0)).toBe(true);
    expect(Object.is((await run([1, -1])).rows[0].s, 0)).toBe(true);
    await expect(run([1.7e308, 1.7e308])).rejects.toThrow(RangeError);
    await expect(run([1.7e308, 0.1e308])).rejects.toThrow(RangeError);
  });
  it('reserve their terms in working memory and also run on ordered groups', async () => {
    const g = forRows<{ k: string; x: number }>();
    const plan = g.aggregate({ groupBy: { k: g.field('k') }, measures: { s: g.sum(g.field('x')) }, numberMode: 'exact' });
    const data = Array.from({ length: 40 }, (_, i) => ({ k: 'abcde'[i >> 3], x: i % 2 ? 1e16 * i : 0.5 + i }));
    const hashed = await plan.evaluate(createArraySource(data, { isolation: 'immutable' }));
    const sorted = createImmutableArraySource(data, { keyCache: {}, ordering: compileQuery({ sorters: [{ field: 'k' }] }).ordering });
    await sorted.prepareKeys(['k']);
    const ordered = await plan.evaluate(sorted);
    expect(ordered.summary.strategy).toBe('ordered-groups');
    expect(ordered.rows).toEqual(hashed.rows);
    expect(hashed.rows[0].s).toBe(exactSum(data.filter(d => d.k === 'a').map(d => d.x)));
    await expect(plan.evaluate(createArraySource(data, { isolation: 'immutable' }), {}, { maxWorkingBytes: hashed.summary.peakWorkingBytes - 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('partial and merge contracts', () => {
  const q = forRows<{ k?: unknown; x?: number; b?: bigint }>();
  const counts = q.aggregate({ groupBy: { k: q.field('k') }, measures: { n: q.count(), b: q.sumBigInt(q.field('b')) } });
  const src = (rows: object[], revision: string | number = 0) => createArraySource(rows as never, { isolation: 'immutable', revision });
  it('accept exact states under every number mode and float sums only under exact', async () => {
    const compensated = q.aggregate({ measures: { s: q.sum(q.field('x')) } });
    await expect(compensated.partial(src([{ x: 1 }]))).rejects.toThrow(/numberMode: 'exact'/);
    await expect(compensated.merge([])).rejects.toThrow(TypeError);
    expect(compensated.explain().strategies).not.toContain('merge');
    expect(counts.explain().strategies).toContain('merge');
    expect(q.aggregate({ measures: { s: q.avg(q.field('x')) }, numberMode: 'sequential' }).explain().strategies).not.toContain('merge');
    expect('partial' in q.rows({ select: { k: q.field('k') } })).toBe(false);
    expect((await counts.merge([await counts.partial(src([{ k: 1, b: 2n }])), await counts.partial(src([{ k: 1 }, { k: 2, b: 1n }]))])).rows)
      .toEqual([{ k: 1, n: 2, b: 2n }, { k: 2, n: 1, b: 1n }]);
  });
  it('reject keys that group by identity, since a copy cannot keep it', async () => {
    await expect(counts.partial(src([{ k: { a: 1 } }]))).rejects.toThrow(/identity/);
    const identity = q.aggregate({ groupBy: { k: q.field('k') }, measures: { n: q.count() }, semantics: { equality: 'identity' } });
    await expect(identity.partial(src([{ k: new Date(0) }]))).rejects.toThrow(/identity/);
    expect((await identity.merge([await identity.partial(src([{ k: 'a' }]))])).rows).toEqual([{ k: 'a', n: 1 }]);
    const value = await counts.partial(src([{ k: new Date(5) }, { k: new Uint8Array([1]) }]));
    expect((await counts.merge([value, structuredClone(value)])).rows.map(row => row.n)).toEqual([2, 2]);
  });
  it('reject malformed partials and partials of another plan before merging', async () => {
    const good = await counts.partial(src([{ k: 1, b: 2n }, { k: 2 }]));
    const other = q.aggregate({ groupBy: { k: q.field('k') }, measures: { n: q.count(), b: q.sumBigInt(q.field('x') as never) } });
    const broken: Array<[string, unknown]> = [
      ['not an array', good],
      ['empty', []],
      ['not an object', [null]],
      ['format', [{ ...good, format: 2 }]],
      ['other plan', [await other.partial(src([{ k: 1 }]))]],
      ['revision', [{ ...good, revision: {} }]],
      ['scanned', [{ ...good, scannedRows: -1 }]],
      ['matched', [{ ...good, matchedRows: 3 }]],
      ['groups', [{ ...good, groups: 3 }]],
      ['keys', [{ ...good, keys: [[1]] }]],
      ['states', [{ ...good, states: [good.states[0]] }]],
      ['count column', [{ ...good, states: [{ counts: [1, 1] }, good.states[1]] }]],
      ['count value', [{ ...good, states: [{ counts: new Float64Array([1.5, 1]) }, good.states[1]] }]],
      ['bigint value', [{ ...good, states: [good.states[0], { values: [2, undefined] }] }]],
      ['key type', [{ ...good, keys: [[1, { a: 1 }]] }]],
      ['key symbol', [{ ...good, keys: [[1, Symbol('k')]] }]],
    ];
    for (const [name, partials] of broken) await expect(counts.merge(partials as PartialAggregate[]), name).rejects.toThrow(TypeError);
    const sums = q.aggregate({ measures: { s: q.sum(q.field('x')) }, numberMode: 'exact' });
    const sum = await sums.partial(src([{ x: 1 }, { x: 2 }]));
    const state = sum.states[0] as { counts: Float64Array; offsets: Float64Array; terms: Float64Array };
    for (const [name, patch] of [
      ['NaN term', { terms: new Float64Array([NaN]) }], ['offsets', { offsets: new Float64Array([0, 5]) }],
      ['count without terms', { offsets: new Float64Array([0, 0]) }], ['offsets type', { offsets: [0, 1] }],
    ] as const) await expect(sums.merge([{ ...sum, states: [{ ...state, ...patch }] }]), name).rejects.toThrow(TypeError);
  });
  it('tie partials to the descriptor: a clone matches, another literal or alias order does not', async () => {
    const descriptor = (literal: unknown, flip = false) => {
      const measures = { n: q.count(undefined, { where: q.neq(q.field('k'), q.literal(literal)) }), b: q.sumBigInt(q.field('b')) };
      return { groupBy: { k: q.field('k') }, measures: flip ? { b: measures.b, n: measures.n } : measures };
    };
    const rows = src([{ k: 1, b: 1n }]);
    for (const literal of [new Uint8Array([1, 2]), new Date(1), 5n, -0, 'x']) {
      const plan = q.aggregate(descriptor(literal)), part = await plan.partial(rows);
      expect((await q.aggregate(structuredClone(descriptor(literal))).merge([part])).rows).toEqual([{ k: 1, n: 1, b: 1n }]);
      const other = literal instanceof Uint8Array ? new Uint8Array([1, 3]) : literal instanceof Date ? new Date(2) : literal === 5n ? 6n : Object.is(literal, -0) ? 0 : 'y';
      await expect(q.aggregate(descriptor(other)).merge([part]), String(literal)).rejects.toThrow(/different plan/);
      await expect(q.aggregate(descriptor(literal, true)).merge([part])).rejects.toThrow(/different plan/);
    }
  });
  it('bound and cancel the merge, and fail a count beyond the safe range', async () => {
    const many = await counts.partial(src(Array.from({ length: 5000 }, (_, k) => ({ k }))));
    await expect(counts.merge([many], {}, { maxGroups: 4999 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(counts.merge([many], {}, { maxWorkingBytes: 1024 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const controller = new AbortController(); controller.abort();
    await expect(counts.merge([many], {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    const page = await counts.merge([many, many], { offset: 4998, limit: 5 }, { batchSize: 1 });
    expect(page.rows).toEqual([{ k: 4998, n: 2, b: null }, { k: 4999, n: 2, b: null }]);
    expect(page.summary).toMatchObject({ totalResultRows: 5000, returnedRows: 2, hasMore: false, scannedRows: 10000, peakGroups: 5000 });
    const full = await counts.partial(src([{ k: 1 }]));
    const huge = { ...full, states: [{ counts: new Float64Array([Number.MAX_SAFE_INTEGER]) }, full.states[1]] };
    await expect(counts.merge([huge, full])).rejects.toThrow(RangeError);
    await expect(counts.partial(src([{ k: 1 }]), { maxScannedRows: 0 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});
