import assert from 'node:assert/strict';
import { createImmutableArraySource, evaluateStream, streamQuery } from '../dist/stream.mjs';

// Freeze is illustrative: the source's contract requires immutable reachable
// values; it does not deep-freeze objects, Date internals or binary buffers.
const source = createImmutableArraySource([Object.freeze({ id: 1 }), Object.freeze({ id: 2 })]);
const pinned = streamQuery(source, {}, { batchSize: 1 });
try {
  const first = await pinned.next();
  assert.equal(first.value.rows[0].id, 1);
  assert.equal(source.replace([Object.freeze({ id: 3 })]), 1n);
  assert.equal((await pinned.next()).value.rows[0].id, 2);
  const complete = await pinned.next();
  assert.equal(complete.value.summary.revision, 0n);
  const latest = await evaluateStream(source);
  assert.deepEqual(latest.rows, [{ id: 3 }]);
  assert.equal(latest.summary.revision, 1n);
  console.log('Old reader: [1, 2] at revision 0; new reader: [3] at revision 1.');
} finally { await pinned.return(undefined); }
