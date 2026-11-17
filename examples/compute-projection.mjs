import { forRows } from '../dist/compute.mjs';
import { createImmutableArraySource } from '../dist/stream.mjs';
// Narrow output rows with a computed column and a hidden sort key: only the 5 returned rows are projected.
const source = createImmutableArraySource(Array.from({ length: 10_000 }, (_, id) => ({ id, quantity: id % 7, unitPrice: (id % 13) + 0.5, notes: 'x'.repeat(200) })));
const q = forRows();
const revenue = q.mul(q.field('quantity'), q.field('unitPrice'));
const top = q.rows({ select: { id: q.field('id'), revenue }, where: q.gt(q.field('quantity'), q.literal(0)), orderBy: [{ expr: revenue, direction: 'desc' }, { expr: q.field('id') }] });
const page = await top.evaluate(source, { limit: 5 }, { count: 'exact' });
console.log(page.rows, { strategy: page.summary.strategy, matches: page.summary.totalInputMatches });
console.log(top.explain().operators);
