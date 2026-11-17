import { forRows } from '../dist/compute.mjs';
import { createImmutableArraySource } from '../dist/stream.mjs';
// Streaming output with early return, then cancellation: both close the source, and neither reports completion.
const source = createImmutableArraySource(Array.from({ length: 100_000 }, (_, id) => ({ id, group: id % 1000 })));
const q = forRows();
const groups = q.aggregate({ groupBy: { group: q.field('group') }, measures: { n: q.count() } });
for await (const event of groups.stream(source, {}, { batchSize: 100 })) {
  console.log(event.type, event.type === 'batch' ? event.rows.length : '');
  break; // early return releases the session
}
const controller = new AbortController();
setTimeout(() => controller.abort(), 0);
try {
  await groups.evaluate(source, {}, { signal: controller.signal, maxGroups: 1000, maxOutputRows: 1000 });
  console.log('completed before the abort fired');
} catch (error) { console.log('cancelled:', error.code); }
