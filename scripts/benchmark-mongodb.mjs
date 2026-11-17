// defuss-dataview queries against MongoDB on the same documents: `node scripts/benchmark-mongodb.mjs [rows]`.
// MONGODB_URL names a running server (default mongodb://127.0.0.1:27017). The script creates a throwaway database
// named defuss_dataview_bench_<pid>, drops it at the end and never touches another database. Every engine answers the
// same queries; results are cross-checked before timing, then engines alternate within each round so host drift hits
// all of them. Non-gating: writes artifacts/benchmark-mongodb.json and updates docs/assets/mongodb.json for the website.
// The projected DBSONL engine answers from copies of one revision's queried fields and must stay at that revision,
// so the timed rounds never write; the cross-check confirms it returns the full scan's rows.
// VERIFIED: on 2026-11-16 (M5 Max, MongoDB 9.0.8) the database was gone after every run, including one that failed
// mid-load; documentation/MONGODB.md has the results and why the index wins.
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import { MongoClient } from 'mongodb';
import { createMemoryBackend, openDbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
import { createDbsonlSource } from '../dist/adapters/dbsonl.mjs';
import { createImmutableArraySource, createIndexedArraySource, evaluateStream } from '../dist/stream.mjs';
import { compileQuery } from '../dist/query.mjs';

const total = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(total) || total < 100) throw new RangeError('rows must be an integer >= 100');
const url = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017';
const key = (i) => `doc:${String(i).padStart(8, '0')}`;
const doc = (i) => ({ key: key(i), title: `doc ${i}`, score: (i * 7919) % 1000, tags: ['a', 'b'], at: new Date(1_700_000_000_000 + i) });
const docs = Array.from({ length: total }, (_, i) => doc(i));
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const time = async (fn) => { const started = performance.now(); await fn(); return performance.now() - started; };

// The two queries every engine answers, in each engine's own vocabulary.
const topRequest = (prefix) => ({ filters: [{ field: `${prefix}score`, op: 'gte', value: 500 }], sorters: [{ field: `${prefix}score`, direction: 'desc' }, { field: 'key' }], limit: 50 });
const pageRequest = { sorters: [{ field: 'key' }], limit: 50 };
const dataview = (makeSource, prefix) => ({
  top: async () => { const r = await evaluateStream(makeSource(), topRequest(prefix), { count: 'exact' }); return `${r.summary.totalMatches}:${r.rows.map((row) => row.key).join()}`; },
  page: async () => (await evaluateStream(makeSource(), pageRequest)).rows.map((row) => row.key).join(),
});
// A fixed-query index materializes one query's matches in order: its count is exact and a page is a slice. It serves
// only the descriptor it was built for, so each query gets its own index, built once before timing.
const fixedIndex = (top, page) => ({
  top: async () => { const r = await top.readPage({ limit: 50 }); return `${top.count}:${r.rows.map((row) => row.key).join()}`; },
  page: async () => (await page.readPage({ limit: 50 })).rows.map((row) => row.key).join(),
});
const mongo = (collection) => ({
  // An application would issue the count and the page together, so they run concurrently.
  top: async () => {
    const filter = { score: { $gte: 500 } };
    const [count, rows] = await Promise.all([collection.countDocuments(filter), collection.find(filter, { projection: { key: 1 } }).sort({ score: -1, key: 1 }).limit(50).toArray()]);
    return `${count}:${rows.map((row) => row.key).join()}`;
  },
  page: async () => (await collection.find({}, { projection: { key: 1 } }).sort({ _id: 1 }).limit(50).toArray()).map((row) => row.key).join(),
});

const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
const database = `defuss_dataview_bench_${process.pid}`;
const directories = [], dbsonl = [], loads = [];
let mongoDb;
// An interrupted run skips the finally below; drop the throwaway database and directories before exiting instead.
const interrupt = async (signal) => {
  try { await client.db(database).dropDatabase(); for (const directory of directories) await rm(directory, { recursive: true, force: true }); }
  finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
};
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  await client.connect();
  mongoDb = client.db(database);
  const server = await mongoDb.admin().serverInfo();
  // Loading: 5000-document batches into each store. DBSONL file storage flushes every batch to disk; MongoDB
  // acknowledges with the server's default write concern, which this script does not change.
  const loadDbsonl = async (name, backend) => {
    let db;
    const ms = await time(async () => {
      db = await openDbsonl(backend, 'bench', { create: true });
      for (let start = 0; start < total; start += 5000) await db.batch(docs.slice(start, start + 5000).map((value) => ({ operation: 'put', key: value.key, value })));
    });
    loads.push({ engine: name, ms }); dbsonl.push(db); return db;
  };
  const memoryDb = await loadDbsonl('DBSONL memory', createMemoryBackend({ maxFileBytes: 4 * 1024 ** 3 }));
  const dir = await mkdtemp(join(tmpdir(), 'dataview-bench-mongo-')); directories.push(dir);
  const fileDb = await loadDbsonl('DBSONL file', await createFileBackend(dir));
  const plain = mongoDb.collection('plain'), indexed = mongoDb.collection('indexed');
  for (const [name, collection] of [['MongoDB', plain], ['MongoDB + index', indexed]]) {
    const ms = await time(async () => {
      for (let start = 0; start < total; start += 5000) await collection.insertMany(docs.slice(start, start + 5000).map((value) => ({ _id: value.key, ...value })), { ordered: true });
      if (collection === indexed) await collection.createIndex({ score: -1, key: 1 });
    });
    loads.push({ engine: name, ms });
  }
  // The rows are generated in key order, which the application knows and declares, as the DBSONL adapter does.
  const immutable = createImmutableArraySource(docs, { ordering: compileQuery({ sorters: [{ field: 'key' }] }).ordering });
  await immutable.prepare();
  const builds = [];
  const build = async (name, descriptor) => {
    let index;
    const ms = await time(async () => { index = createIndexedArraySource(docs, descriptor); await index.prepare(); });
    builds.push({ index: name, ms }); return index;
  };
  // A projection keeps key, revision and value.score of one revision; repeated pages at that revision read the copies
  // and fetch only the 50 stored rows they return. prepare() is its build: one full scan, timed like the indexes.
  const projectedFile = createDbsonlSource(fileDb, { projection: { fields: ['value.score'], maxBytes: 512 * 1024 ** 2 } });
  const projectedMs = await time(async () => { if (!(await projectedFile.prepare())) throw new Error('the projection did not fit its byte cap'); });
  builds.push({ index: 'DBSONL file projection of value.score', ms: projectedMs });
  const { limit: _limit, ...topDescriptor } = topRequest('');
  const topIndex = await build('fixed-query index for the top query', topDescriptor), pageIndex = await build('fixed-query index for the page query', { sorters: pageRequest.sorters });
  const engines = [
    ['dataview + immutable array', dataview(() => immutable, '')],
    ['dataview fixed-query index', fixedIndex(topIndex, pageIndex)],
    ['dataview + DBSONL memory', dataview(() => createDbsonlSource(memoryDb), 'value.')],
    ['dataview + DBSONL file', dataview(() => createDbsonlSource(fileDb), 'value.')],
    ['dataview + DBSONL file, same revision', dataview(() => projectedFile, 'value.')],
    ['MongoDB', mongo(plain)],
    ['MongoDB + index', mongo(indexed)],
  ];
  const results = [];
  for (const query of ['top', 'page']) {
    const answers = [];
    for (const [, engine] of engines) answers.push(await engine[query]()); // warmup and cross-check
    answers.forEach((answer, i) => { if (answer !== answers[0]) throw new Error(`${engines[i][0]} disagrees on ${query}`); });
    const samples = engines.map(() => []);
    for (let round = 0; round < 7; round++) {
      const order = engines.map((_, i) => i); if (round % 2) order.reverse();
      for (const i of order) { globalThis.gc?.(); samples[i].push(await time(engines[i][1][query])); }
    }
    engines.forEach(([name], i) => results.push({ query, engine: name, medianMs: median(samples[i]), minMs: Math.min(...samples[i]) }));
  }
  const label = { top: 'score >= 500, sort score desc + key, first 50, exact count', page: 'first 50 by key' };
  for (const { engine, ms } of loads) console.log(`load ${total} docs`.padEnd(64) + engine.padEnd(40) + `${ms.toFixed(0).padStart(8)} ms`);
  for (const { index, ms } of builds) console.log(`build: ${index}`.padEnd(64) + 'dataview'.padEnd(40) + `${ms.toFixed(0).padStart(8)} ms`);
  for (const r of results) console.log(label[r.query].padEnd(64) + r.engine.padEnd(40) + `${r.medianMs.toFixed(r.medianMs < 1 ? 3 : 1).padStart(8)} ms`);
  const environment = { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, mongodb: server.version, storageEngine: (await mongoDb.admin().serverStatus()).storageEngine?.name };
  const method = '1 warmup that also cross-checks results, then median of 7 alternating runs, gc between runs when --expose-gc; MongoDB over loopback, count and page issued concurrently';
  const measuredAt = new Date().toISOString();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/benchmark-mongodb.json', JSON.stringify({ rows: total, measuredAt, environment, queries: label, method, loads, builds, results }, null, 2) + '\n');
  // The website's comparison reads docs/assets/mongodb.json and has switches for exactly these two sizes; each keeps its
  // latest run, and a quick run at another size changes only artifacts/.
  if (total === 100_000 || total === 1_000_000) {
    const site = await readFile('docs/assets/mongodb.json', 'utf8').then(JSON.parse, () => ({ sizes: {} }));
    site.sizes[total] = { measuredAt, environment, loads, builds, results };
    await writeFile('docs/assets/mongodb.json', JSON.stringify({ queries: label, method, sizes: site.sizes }, null, 2) + '\n');
  }
} finally {
  for (const db of dbsonl) await db.close();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  if (mongoDb) await mongoDb.dropDatabase();
  await client.close();
}
