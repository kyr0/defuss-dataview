import { describe, expect, it } from 'vitest';
import { forRows } from '../compute.js';
import { createArraySource, createImmutableArraySource } from '../stream.js';
import type { RecordSource } from '../stream.js';
import { oracle } from '../../tests/compute/oracle.js';

// Deterministic seeds: a failure names its seed, batch size and source so it reproduces exactly.
function random(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
type Row = { id: number; cat?: unknown; flag: boolean; amount?: number | null; qty: number; big: bigint | null; when: Date; label: string };
const CATS: unknown[] = ['a', 'b', 'A', '1', 1, 1n, true, null, undefined, NaN, 0, -0, 2.5];
function rows(seed: number, n: number): Row[] {
  const r = random(seed);
  return Array.from({ length: n }, (_, id) => {
    const row: Row = { id, flag: r() < 0.5, qty: Math.floor(r() * 5), big: r() < 0.2 ? null : BigInt(Math.floor(r() * 1e6)) * (r() < 0.1 ? 10n ** 30n : 1n),
      when: new Date(1_700_000_000_000 + Math.floor(r() * 5) * 86_400_000), label: `x${Math.floor(r() * 7)}` };
    if (r() < 0.9) row.cat = CATS[Math.floor(r() * CATS.length)];
    if (r() < 0.85) row.amount = r() < 0.1 ? null : Math.round((r() - 0.3) * 1e6) / 100;
    return row;
  });
}
const q = forRows<Row>();
const amount = q.field('amount'), qty = q.field('qty');
const grouped = {
  filters: [{ field: 'qty', op: 'gt' as const, value: 0 }],
  groupBy: { cat: q.field('cat') },
  measures: {
    n: q.count(), amounts: q.count(amount), total: q.sum(amount), mean: q.avg(amount), low: q.min(amount), high: q.max(q.field('label')),
    big: q.sumBigInt(q.field('big')), flagged: q.count(undefined, { where: q.field('flag') }), flaggedTotal: q.sum(amount, { where: q.field('flag') }),
    first: q.min(q.field('when')),
  },
  having: [{ field: 'n', op: 'gte' as const, value: 2 }],
  orderBy: [{ field: 'total', direction: 'desc' as const }],
};
const plans = {
  rows: {
    select: { id: q.field('id'), cat: q.field('cat'), total: q.mul(amount, qty), missing: q.path('nested.deep') },
    where: q.gte(amount, q.literal(0)),
    orderBy: [{ expr: q.mul(amount, qty), direction: 'desc' as const }, { expr: q.field('label') }],
  },
  grouped,
  exact: { ...grouped, numberMode: 'exact' as const },
  composite: { groupBy: { cat: q.field('cat'), flag: q.field('flag'), day: q.field('when') }, measures: { n: q.count(), total: q.sum(q.mul(amount, qty)) } },
  scalar: { measures: { n: q.count(), total: q.sum(amount), mean: q.avg(amount), big: q.sumBigInt(q.field('big')), sequential: q.sum(amount) }, numberMode: 'sequential' as const },
  distinct: { groupBy: { label: q.field('label'), flag: q.field('flag') }, measures: {} },
  view: { select: { id: q.field('id'), amount }, totals: { n: q.count(), total: q.sum(amount), high: q.max(amount) }, orderBy: [{ expr: amount, direction: 'asc' as const }] },
} as const;
const kinds = { rows: 'rows', grouped: 'aggregate', exact: 'aggregate', composite: 'aggregate', scalar: 'aggregate', distinct: 'aggregate', view: 'view' } as const;
const prepare = (name: keyof typeof plans) => kinds[name] === 'rows' ? q.rows(plans.rows) : kinds[name] === 'view' ? q.view(plans.view) : q.aggregate(plans[name] as never);
async function sources(data: Row[]): Promise<Array<[string, RecordSource<Row>]>> {
  const cached = createImmutableArraySource(data, { keyCache: { maxBytes: 64 * 1024 * 1024 } });
  await cached.prepareKeys(['amount', 'qty', 'cat', 'label', 'flag']);
  return [['copied', createArraySource(data, { isolation: 'immutable' })], ['immutable', createImmutableArraySource(data)], ['leased columns', cached]];
}

describe('compute matches the independent oracle', () => {
  for (const seed of [1, 7, 42]) for (const name of Object.keys(plans) as Array<keyof typeof plans>) {
    it(`${name} plan, seed ${seed}, every batch size and source`, async () => {
      const data = rows(seed, 300 + seed * 11);
      const expected = oracle(kinds[name], plans[name] as never, data, { offset: 2, limit: 15 });
      const plan = prepare(name);
      for (const [label, source] of await sources(data)) for (const batchSize of [1, 7, 256]) {
        const result = await plan.evaluate(source, { offset: 2, limit: 15 }, { batchSize, count: 'exact' }) as { rows: unknown[]; totals?: unknown; summary: { totalResultRows: number | null; totalInputMatches: number | null } };
        const where = `${label}, batchSize ${batchSize}`;
        expect(result.rows, where).toEqual(expected.rows);
        if (expected.totals) expect(result.totals, where).toEqual(expected.totals);
        expect(result.summary.totalResultRows, where).toBe(expected.total);
        expect(result.summary.totalInputMatches, where).toBe(expected.matches);
      }
    });
  }
});

describe('partials merged in source order match the oracle', () => {
  const mergeable = {
    exact: plans.exact,
    composite: { ...plans.composite, numberMode: 'exact' as const },
    scalar: { ...plans.scalar, numberMode: 'exact' as const },
    distinct: plans.distinct,
  };
  for (const seed of [1, 7]) for (const [name, descriptor] of Object.entries(mergeable)) {
    it(`${name} plan, seed ${seed}, split into 1, 2 and 5 parts`, async () => {
      const data = rows(seed, 300 + seed * 11);
      const expected = oracle('aggregate', descriptor as never, data, { offset: 2, limit: 15 });
      const plan = q.aggregate(descriptor as never);
      for (const parts of [1, 2, 5]) {
        const size = Math.ceil(data.length / parts);
        const partials = await Promise.all(Array.from({ length: parts }, (_, i) =>
          plan.partial(createArraySource(data.slice(i * size, (i + 1) * size), { isolation: 'immutable' }), { batchSize: 7 })));
        const result = await plan.merge(partials.map(p => structuredClone(p)), { offset: 2, limit: 15 });
        expect(result.rows, `${parts} parts`).toEqual(expected.rows);
        expect(result.summary.totalResultRows).toBe(expected.total);
        expect(result.summary.totalInputMatches).toBe(expected.matches);
      }
    });
  }
});
