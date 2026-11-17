import { forRows } from '../dist/compute.mjs';
import { createImmutableArraySource } from '../dist/stream.mjs';
// One scan returns the visible page and totals over every match, both from the same snapshot.
const source = createImmutableArraySource(Array.from({ length: 20_000 }, (_, id) => ({ id, status: id % 3 ? 'open' : 'closed', amount: id % 50 })));
const q = forRows();
const table = q.view({
  filters: [{ field: 'status', op: 'eq', value: 'open' }],
  select: { id: q.field('id'), amount: q.field('amount') },
  totals: { rows: q.count(), amount: q.sum(q.field('amount')), largest: q.max(q.field('amount')) },
  orderBy: [{ expr: q.field('amount'), direction: 'desc' }, { expr: q.field('id') }],
});
const view = await table.evaluate(source, { offset: 0, limit: 4 });
console.log(view.rows, view.totals, { scanned: view.summary.scannedRows, hasMore: view.summary.hasMore });
