import { forRows } from '../dist/compute.mjs';
import { createImmutableArraySource } from '../dist/stream.mjs';
// Grouped measures with HAVING, ordering and paging; group counts are exact under count: 'exact'.
const countries = ['de', 'fr', 'it', 'es', 'nl'];
const source = createImmutableArraySource(Array.from({ length: 50_000 }, (_, id) => ({ id, country: countries[id % 5], amount: (id % 97) / 4, refunded: id % 11 === 0, cents: BigInt(id) * 10n ** 12n })));
const q = forRows();
const amount = q.field('amount');
const byCountry = q.aggregate({
  where: q.not(q.field('refunded')),
  groupBy: { country: q.field('country') },
  measures: { orders: q.count(), revenue: q.sum(amount), mean: q.avg(amount), largest: q.max(amount), exactCents: q.sumBigInt(q.field('cents')) },
  having: [{ field: 'orders', op: 'gte', value: 9000 }],
  orderBy: [{ field: 'revenue', direction: 'desc' }],
});
const result = await byCountry.evaluate(source, { limit: 3 }, { count: 'exact' });
console.log(result.rows, { groups: result.summary.totalResultRows, strategy: result.summary.strategy, peakWorkingBytes: result.summary.peakWorkingBytes });
