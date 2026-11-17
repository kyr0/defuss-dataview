import { createMemoryBackend, openDbsonl } from 'defuss-dbsonl';
import { createDbsonlSource } from '../dist/adapters/dbsonl.mjs';
import { evaluateStream } from '../dist/stream.mjs';
const db = await openDbsonl(createMemoryBackend(), 'example', { create: true });
try {
  await db.batch([
    { operation: 'put', key: 'doc:a', value: { title: 'Storage', at: new Date(100), size: 100n } },
    { operation: 'put', key: 'doc:b', value: { title: 'Graph', at: new Date(200), size: 2n } },
  ]);
  console.log(await evaluateStream(createDbsonlSource(db, { gte: 'doc:', lt: 'doc;' }), {
    sorters: [{ field: 'value.size' }], limit: 5,
  }, { count: 'exact' }));
} finally { await db.close(); }
