// defuss-dataview/compute plans against MongoDB aggregation pipelines on the same orders:
// `node scripts/benchmark-mongodb-compute.mjs [rows]`. MONGODB_URL names a running server (default
// mongodb://127.0.0.1:27017). The script creates a throwaway database named defuss_dataview_compute_<pid>, drops it at
// the end (also on SIGINT/SIGTERM) and never touches another database.
// The orders come from the website's seeded generator (docs/demo/data.js), and the plans are the compute panel's five
// presets, so the page and this comparison describe the same work. Every engine's answer is cross-checked before
// timing (floating-point sums to a relative 1e-9, since MongoDB and dataview add in different orders); then engines
// alternate within each round. All figures are repeated queries: MongoDB answers from its cache, dataview from memory.
// Non-gating: writes artifacts/benchmark-mongodb-compute.json and, at 100,000 or 1,000,000 rows, docs/assets/mongodb-compute.json.
// VERIFIED: on 2026-11-17 (M5 Max, MongoDB 9.0.8) every engine agreed at 2,000, 100,000 and 1,000,000 rows and the
// throwaway database was gone afterwards; documentation/MONGODB.md has the results.
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { MongoClient } from 'mongodb';
import { forRows } from '../dist/compute.mjs';
import { createImmutableArraySource } from '../dist/stream.mjs';
import { orders } from '../docs/demo/data.js';

const total = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(total) || total < 100) throw new RangeError('rows must be an integer >= 100');
const url = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017';
const rows = orders(total);
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const time = async (fn) => { const started = performance.now(); await fn(); return performance.now() - started; };

// ---- the five plans, in each engine's vocabulary ------------------------------------------------------------------
const q = forRows();
const amount = q.field('amount'), gross = q.mul(amount, q.literal(1.19));
const QUERIES = {
  regions: {
    label: 'group by region: count, paid revenue, average, max',
    plan: q.aggregate({
      groupBy: { region: q.field('region') },
      measures: { orders: q.count(), paidRevenue: q.sum(amount, { where: q.eq(q.field('status'), q.literal('Paid')) }), averageOrder: q.avg(amount), largest: q.max(amount) },
      orderBy: [{ field: 'paidRevenue', direction: 'desc' }],
    }),
    page: {},
    pipeline: [
      { $group: { _id: '$region', orders: { $sum: 1 }, paidRevenue: { $sum: { $cond: [{ $eq: ['$status', 'Paid'] }, '$amount', 0] } }, averageOrder: { $avg: '$amount' }, largest: { $max: '$amount' } } },
      { $sort: { paidRevenue: -1 } },
      { $project: { _id: 0, region: '$_id', orders: 1, paidRevenue: 1, averageOrder: 1, largest: 1 } },
    ],
  },
  pairs: {
    label: 'group by region × product, HAVING, top 10 groups by revenue',
    plan: q.aggregate({
      where: q.neq(q.field('status'), q.literal('Failed')),
      groupBy: { region: q.field('region'), product: q.field('product') },
      measures: { orders: q.count(), revenue: q.sum(amount), averageOrder: q.avg(amount) },
      having: [{ field: 'averageOrder', op: 'gte', value: 750 }],
      orderBy: [{ field: 'revenue', direction: 'desc' }],
    }),
    page: { limit: 10 },
    pipeline: [
      { $match: { status: { $ne: 'Failed' } } },
      { $group: { _id: { region: '$region', product: '$product' }, orders: { $sum: 1 }, revenue: { $sum: '$amount' }, averageOrder: { $avg: '$amount' } } },
      { $match: { averageOrder: { $gte: 750 } } },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, region: '$_id.region', product: '$_id.product', orders: 1, revenue: 1, averageOrder: 1 } },
    ],
  },
  top: {
    label: 'paid orders, computed gross = amount × 1.19, top 10 by gross',
    plan: q.rows({
      filters: [{ field: 'status', op: 'eq', value: 'Paid' }],
      select: { id: q.field('id'), customer: q.field('customer'), net: amount, gross },
      orderBy: [{ expr: gross, direction: 'desc' }, { expr: q.field('id') }],
    }),
    page: { limit: 10 },
    pipeline: [
      { $match: { status: 'Paid' } },
      { $project: { _id: 0, id: '$_id', customer: 1, net: '$amount', gross: { $multiply: ['$amount', 1.19] } } },
      { $sort: { gross: -1, id: 1 } },
      { $limit: 10 },
    ],
  },
  view: {
    label: 'EU orders: newest 10 plus totals over all of them, one query',
    plan: q.view({
      filters: [{ field: 'region', op: 'eq', value: 'EU' }],
      select: { id: q.field('id'), date: q.field('date'), customer: q.field('customer'), status: q.field('status'), amount },
      totals: { orders: q.count(), revenue: q.sum(amount), averageOrder: q.avg(amount), refunded: q.count(undefined, { where: q.eq(q.field('status'), q.literal('Refunded')) }) },
      orderBy: [{ expr: q.field('date'), direction: 'desc' }, { expr: q.field('id') }],
    }),
    page: { limit: 10 },
    pipeline: [
      { $match: { region: 'EU' } },
      { $facet: {
        rows: [{ $sort: { date: -1, _id: 1 } }, { $limit: 10 }, { $project: { _id: 0, id: '$_id', date: 1, customer: 1, status: 1, amount: 1 } }],
        totals: [{ $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$amount' }, averageOrder: { $avg: '$amount' }, refunded: { $sum: { $cond: [{ $eq: ['$status', 'Refunded'] }, 1, 0] } } } }, { $project: { _id: 0 } }],
      } },
    ],
  },
  scalar: {
    label: 'all orders: count, revenue, average, max (one global row)',
    plan: q.aggregate({ measures: { orders: q.count(), revenue: q.sum(amount), averageOrder: q.avg(amount), largest: q.max(amount) } }),
    page: {},
    pipeline: [{ $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$amount' }, averageOrder: { $avg: '$amount' }, largest: { $max: '$amount' } } }, { $project: { _id: 0 } }],
  },
};
const FIELDS = [...new Set(Object.values(QUERIES).flatMap(({ plan }) => plan.explain().requiredFields))];

// Answers compare by structure; numbers that are not integers compare to a relative 1e-9.
function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Number.isInteger(a) && Number.isInteger(b) ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => same(value, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a).sort();
    return same(keys, Object.keys(b).sort()) && keys.every((key) => same(a[key], b[key]));
  }
  return a === b;
}
const dataview = (source, id) => async () => {
  const { plan, page } = QUERIES[id];
  const result = await plan.evaluate(source, page, { maxOutputRows: 1_000_000, sizeOf: () => 256 });
  return id === 'view' ? { rows: result.rows, totals: result.totals } : result.rows;
};
const mongo = (collection, id) => async () => {
  const answer = await collection.aggregate(QUERIES[id].pipeline).toArray();
  return id === 'view' ? { rows: answer[0].rows, totals: answer[0].totals[0] } : answer;
};

const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
const database = `defuss_dataview_compute_${process.pid}`;
let mongoDb;
const interrupt = async (signal) => { try { await client.db(database).dropDatabase(); } finally { process.exit(signal === 'SIGINT' ? 130 : 143); } };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  await client.connect();
  mongoDb = client.db(database);
  const server = await mongoDb.admin().serverInfo();
  const loads = [];
  const plain = mongoDb.collection('plain'), indexed = mongoDb.collection('indexed');
  for (const [name, collection] of [['MongoDB', plain], ['MongoDB + indexes', indexed]]) {
    const ms = await time(async () => {
      for (let start = 0; start < total; start += 5000) await collection.insertMany(rows.slice(start, start + 5000).map(({ id, ...rest }) => ({ _id: id, ...rest })), { ordered: true });
      // The indexes the queries' filters and sorts can use: status for the paid and not-failed filters, region + date
      // for the EU page. Grouping and the global aggregate read every document either way.
      if (collection === indexed) { await collection.createIndex({ status: 1 }); await collection.createIndex({ region: 1, date: -1 }); }
    });
    loads.push({ engine: name, ms });
  }
  const fromRows = createImmutableArraySource(rows);
  await fromRows.prepare();
  const columns = createImmutableArraySource(rows, { keyCache: { maxBytes: 1024 ** 3 } });
  const prepareMs = await time(() => columns.prepareKeys(FIELDS));
  const engines = [
    ['dataview, row reads', (id) => dataview(fromRows, id)],
    ['dataview, prepared columns', (id) => dataview(columns, id)],
    ['MongoDB', (id) => mongo(plain, id)],
    ['MongoDB + indexes', (id) => mongo(indexed, id)],
  ];
  const results = [];
  for (const id of Object.keys(QUERIES)) {
    const runs = engines.map(([, make]) => make(id));
    const answers = [];
    for (const run of runs) answers.push(await run()); // warmup and cross-check
    answers.forEach((answer, i) => { if (!same(answer, answers[0])) throw new Error(`${engines[i][0]} disagrees on ${id}: ${JSON.stringify(answer).slice(0, 300)} vs ${JSON.stringify(answers[0]).slice(0, 300)}`); });
    const samples = runs.map(() => []);
    for (let round = 0; round < 7; round++) {
      const order = runs.map((_, i) => i); if (round % 2) order.reverse();
      for (const i of order) { globalThis.gc?.(); samples[i].push(await time(runs[i])); }
    }
    engines.forEach(([name], i) => results.push({ query: id, engine: name, medianMs: median(samples[i]), minMs: Math.min(...samples[i]) }));
  }
  const queries = Object.fromEntries(Object.entries(QUERIES).map(([id, { label }]) => [id, label]));
  for (const { engine, ms } of loads) console.log(`load ${total} orders`.padEnd(66) + engine.padEnd(30) + `${ms.toFixed(0).padStart(8)} ms`);
  console.log(`prepareKeys(${FIELDS.join(', ')})`.padEnd(66) + 'dataview'.padEnd(30) + `${prepareMs.toFixed(0).padStart(8)} ms`);
  for (const r of results) console.log(queries[r.query].padEnd(66) + r.engine.padEnd(30) + `${r.medianMs.toFixed(r.medianMs < 1 ? 3 : 1).padStart(8)} ms`);
  const environment = { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, mongodb: server.version, storageEngine: (await mongoDb.admin().serverStatus()).storageEngine?.name };
  const method = '1 warmup that also cross-checks results, then median of 7 alternating runs, gc between runs when --expose-gc; MongoDB aggregation pipelines over loopback, answered from its cache';
  const measuredAt = new Date().toISOString();
  const prepare = { fields: FIELDS, ms: prepareMs };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/benchmark-mongodb-compute.json', JSON.stringify({ rows: total, measuredAt, environment, queries, method, loads, prepare, results }, null, 2) + '\n');
  if (total === 100_000 || total === 1_000_000) {
    const site = await readFile('docs/assets/mongodb-compute.json', 'utf8').then(JSON.parse, () => ({ sizes: {} }));
    site.sizes[total] = { measuredAt, environment, loads, prepare, results };
    await writeFile('docs/assets/mongodb-compute.json', JSON.stringify({ queries, method, sizes: site.sizes }, null, 2) + '\n');
  }
} finally {
  if (mongoDb) await mongoDb.dropDatabase();
  await client.close();
}
