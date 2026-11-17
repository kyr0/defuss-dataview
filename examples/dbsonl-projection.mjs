// Repeated small pages over stored documents: the first complete scan at a revision keeps key, revision and the
// projected fields; later pages at that revision run over those copies and read only the stored rows they return.
// VERIFIED: the tarball check runs this file against the packed build; it prints the kept revision, the top three
// stored documents, then the written document first with the projection moved to the new revision.
import { createMemoryBackend, openDbsonl } from 'defuss-dbsonl';
import { createDbsonlSource } from '../dist/adapters/dbsonl.mjs';
import { evaluateStream } from '../dist/stream.mjs';
const db = await openDbsonl(createMemoryBackend(), 'projection-example', { create: true });
try {
  await db.batch(Array.from({ length: 2000 }, (_, n) => ({ operation: 'put', key: `doc:${String(n).padStart(4, '0')}`, value: { title: `doc ${n}`, score: (n * 7919) % 1000 } })));
  const source = createDbsonlSource(db, { projection: { fields: ['value.score'] } });
  console.log(await source.prepare()); // { revision, rows, bytes } of the kept copies
  const top = { filters: [{ field: 'value.score', op: 'gte', value: 900 }], sorters: [{ field: 'value.score', direction: 'desc' }, { field: 'key' }], limit: 3 };
  console.log((await evaluateStream(source, top, { count: 'exact' })).rows); // full stored documents
  await db.put('doc:0007', { title: 'new', score: 999 });
  // The revision changed: this query scans every document again and keeps the new revision.
  console.log((await evaluateStream(source, top, { count: 'exact' })).rows[0], source.projected);
} finally { await db.close(); }
