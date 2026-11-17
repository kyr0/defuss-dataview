import { openDbsonl } from 'defuss-dbsonl';
import { createBrowserBackend } from 'defuss-dbsonl/browser';
import { createOPFSStorage } from 'defuss-storage/opfs';
import { createDbsonlSource } from '../../dist/adapters/dbsonl.mjs';
import { evaluateStream, streamQuery } from '../../dist/stream.mjs';
self.onmessage = async () => {
  const namespace = 'dataview-' + crypto.randomUUID();
  const storage = await createOPFSStorage({ name: namespace });
  const backend = createBrowserBackend(storage, namespace, navigator.locks);
  const db = await openDbsonl<{ n: bigint }>(backend, 'worker', { create: true });
  try {
    await db.batch(Array.from({ length: 20 }, (_, n) => ({ operation: 'put' as const, key: String(n).padStart(2, '0'), value: { n: BigInt(n) } })));
    const iterator = streamQuery(createDbsonlSource(db), {}, { batchSize: 2 });
    const first = await iterator.next();
    await db.put('03', { n: 999n }); await db.delete('04'); await db.compact();
    const pins = await db.collect();
    const old: bigint[] = []; let snapshotRevision;
    for await (const event of iterator) {
      if (event.type === 'batch') old.push(...event.rows.map(r => r.value.n));
      else snapshotRevision = event.summary.revision;
    }
    const reclaimed = await db.collect();
    const result = await evaluateStream(createDbsonlSource(db, { gte: '02', lt: '08' }), {
      sorters: [{ field: 'value.n', direction: 'desc' }], limit: 3,
    }, { count: 'exact', batchSize: 2 });
    const controller = new AbortController();
    const aborting = streamQuery(createDbsonlSource(db), {}, { signal: controller.signal, batchSize: 1 });
    await aborting.next(); await db.compact(); controller.abort();
    let code;
    try { await aborting.next(); } catch (error) { code = (error as { code: string }).code; }
    const cancelled = await db.collect();
    self.postMessage({
      first: first.value?.type, oldHasThree: old.includes(3n), oldHasFour: old.includes(4n), oldHasNew: old.includes(999n), snapshotRevision,
      pinned: pins.retained.length, reclaimed: reclaimed.removed.length, cancelled: cancelled.removed.length, code,
      keys: result.rows.map(r => r.key), total: result.summary.totalMatches, scope: result.summary.sourceRows,
    });
  } catch (error) { self.postMessage({ error: String(error), stack: (error as Error).stack }); }
  finally {
    await db.close();
    for (const name of await storage.list()) await storage.remove(name);
  }
};
