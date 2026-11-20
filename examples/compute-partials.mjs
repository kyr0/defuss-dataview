import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { openDbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
import { createDbsonlSource } from '../dist/adapters/dbsonl.mjs';
import { forRows } from '../dist/compute.mjs';
// Partial aggregates in four worker threads, one per key range of one pinned DBSONL snapshot, merged in key order: the
// result equals one pass over the whole database. VERIFIED: scripts/package-tests.mjs runs it from the packed tarball;
// it throws on a mismatch.
const q = forRows();
const amount = q.number(q.path('value.amount'));
// Workers rebuild the plan from this descriptor; sum and avg merge only under numberMode: 'exact'.
const descriptor = {
  groupBy: { country: q.path('value.country') },
  measures: { orders: q.count(), revenue: q.sum(amount), mean: q.avg(amount), cents: q.sumBigInt(q.path('value.cents')) },
  orderBy: [{ field: 'revenue', direction: 'desc' }],
  numberMode: 'exact',
};
if (!isMainThread) {
  // Each worker opens its own backend and handle; synchronous reads block only this thread.
  const db = await openDbsonl(await createFileBackend(workerData.dir, { io: 'sync' }), 'orders');
  try {
    const plan = forRows().aggregate(workerData.descriptor);
    parentPort.postMessage(await plan.partial(createDbsonlSource(db, { ...workerData.range, at: workerData.head })));
  } finally { await db.close(); }
} else {
  const dir = await mkdtemp(join(tmpdir(), 'dataview-partials-'));
  const db = await openDbsonl(await createFileBackend(dir), 'orders', { create: true });
  try {
    await db.batch(Array.from({ length: 10_000 }, (_, i) => ({
      operation: 'put', key: `order:${String(i).padStart(5, '0')}`,
      value: { country: ['de', 'fr', 'it'][i % 3], amount: (i % 97) * 0.1, cents: BigInt(i) * 10n ** 15n },
    })));
    const plan = q.aggregate(descriptor);
    const session = await db.beginRead(); // one snapshot for every worker, held until they finish
    try {
      const ranges = await session.split(4); // key ranges in key order, with exact row counts
      const partials = await Promise.all(ranges.map(({ gte, lt }) => new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { dir, descriptor, head: session.head, range: { gte, lt } } });
        worker.once('message', resolve); worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`A worker exited with code ${code} before it sent its partial.`)));
      })));
      const merged = await plan.merge(partials);
      const single = await plan.evaluate(createDbsonlSource(db, { at: session.head }));
      const text = rows => JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? String(v) : v);
      if (text(merged.rows) !== text(single.rows)) throw new Error('The merged partials differ from one pass.');
      console.log(merged.rows, { strategy: merged.summary.strategy, scannedRows: merged.summary.scannedRows, parts: ranges.map(range => range.count) });
    } finally { await session.close(); }
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
}
