import { createArraySource, evaluateStream, streamQuery } from '../dist/stream.mjs';
const source = createArraySource(Array.from({ length: 1000 }, (_, id) => ({ id, score: (id * 37) % 101 })));
const page = await evaluateStream(source, {
  filters: [{ field: 'score', op: 'gte', value: 80 }],
  sorters: [{ field: 'score', direction: 'desc' }], offset: 10, limit: 5,
}, { count: 'exact', batchSize: 128 });
console.log(page);
let rows = 0;
for await (const event of streamQuery(source, {}, { batchSize: 64 })) {
  if (event.type === 'batch') rows += event.rows.length;
  else console.log({ streamed: rows, ...event.summary });
}
