// defuss-dataview/compute benchmark (plan BENCHMARK_MATRIX core scenarios). It runs the built package, checks every
// variant against a handwritten loop outside the timed section, and alternates variants within each sample round so
// drift affects them equally. Raw samples are kept; nothing is trimmed. Writes artifacts/compute-benchmark.json.
// Usage: bun run build && bun run benchmark:compute [-- --samples 9 --rows 200000]
// The compact-table rows are a probe only: the experimental open-addressed table below is not shipped, and
// documentation/COMPUTE_PERFORMANCE.md records why Map stays the grouping store.
// Rotating the variant order inside each round, rather than timing each variant in its own block, keeps thermal and
// GC drift from favouring whichever variant runs first.
// VERIFIED: a full run on 2026-11-17 (Apple M5 Max, Node.js 26.13.1) produced the figures in COMPUTE_PERFORMANCE.md;
// a run on 2026-11-20 on the same machine produced its B10 and B30-B33 section, and a run on 2026-11-21 the B34-B36
// figures in CHANGELOG.md 0.8.0. B31/B32 time worker threads that
// already hold their slice, so the figures isolate scan, transfer and merge from worker startup and data loading.
// B33 runs partials in worker threads over split() ranges of one pinned DBSONL file snapshot; each worker opened its
// backend (io: 'sync') and database handle before timing, as a long-lived worker would.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { openDbsonl } from 'defuss-dbsonl';
import { createFileBackend } from 'defuss-dbsonl/server';
import { createDbsonlSource } from '../dist/adapters/dbsonl.mjs';
import { forRows } from '../dist/compute.mjs';
import { compileQuery } from '../dist/query.mjs';
import { createArraySource, createImmutableArraySource, evaluateStream } from '../dist/stream.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const SAMPLES = arg('samples', 9), WARMUPS = 2, N = arg('rows', 200_000);
const environment = { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length };
const scenarios = [];
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const p95 = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

/** Alternating paired measurement: every round runs each variant once, in rotated order. */
async function scenario(id, title, rows, variants, expected) {
  const results = Object.fromEntries(Object.keys(variants).map(name => [name, []]));
  const summaries = {};
  for (const [name, run] of Object.entries(variants)) {
    const value = await run();
    assert.deepEqual(value.result, expected, `${id} ${name} disagrees with the handwritten reference`);
    summaries[name] = value.summary;
  }
  const names = Object.keys(variants);
  for (let round = 0; round < WARMUPS + SAMPLES; round++) {
    for (let k = 0; k < names.length; k++) {
      const name = names[(round + k) % names.length];
      const started = performance.now(); await variants[name](); const ms = performance.now() - started;
      if (round >= WARMUPS) results[name].push(ms);
    }
  }
  const row = { id, title, rows, variants: Object.fromEntries(names.map(name => [name, { medianMs: median(results[name]), p95Ms: p95(results[name]), samplesMs: results[name], summary: summaries[name] }])) };
  scenarios.push(row);
  console.log(`${id} ${title} (${rows} rows): ${names.map(name => `${name} ${median(results[name]).toFixed(2)} ms`).join(' | ')}`);
}
const wrap = (result, summary) => ({ result, summary });
const q = forRows();
const cut = rows => rows.map(r => ({ ...r }));

// ---- data -------------------------------------------------------------------------------------------------------
function wide(n, from = 0) {
  return Array.from({ length: n - from }, (_, i) => {
    const id = from + i;
    const row = { id, g16: id % 16, g1000: (id * 7919) % 1000, gN: (id * 2654435761) % 100_000, amount: ((id * 37) % 1009) / 8, qty: id % 9, flag: id % 3 === 0, name: `n${(id * 31) % 1000}`.padEnd(8, 'x') };
    for (let f = 0; f < 56; f++) row[`f${f}`] = (id + f) % 101;
    return row;
  });
}
const rows = wide(N);
const immutable = createImmutableArraySource(rows), copied = createArraySource(rows, { isolation: 'immutable' });
const cached = createImmutableArraySource(rows, { keyCache: { maxBytes: 256 * 1024 * 1024 } });
await cached.prepareKeys(['amount', 'qty', 'g16', 'g1000', 'gN', 'name']);
const sizeOf = () => 640;

// ---- B02/B03 projection -------------------------------------------------------------------------------------------
{
  const small = rows.slice(0, 256), source = createImmutableArraySource(small);
  const plan = q.rows({ select: { id: q.field('id'), amount: q.field('amount'), qty: q.field('qty'), name: q.field('name') } });
  const expected = small.slice(0, 20).map(r => ({ id: r.id, amount: r.amount, qty: r.qty, name: r.name }));
  await scenario('B02', 'select 4, limit 20 (small input overhead)', 256, {
    handwritten: async () => wrap(small.slice(0, 20).map(r => ({ id: r.id, amount: r.amount, qty: r.qty, name: r.name }))),
    'stream + map': async () => { const r = await evaluateStream(source, { limit: 20 }); return wrap(r.rows.map(r => ({ id: r.id, amount: r.amount, qty: r.qty, name: r.name }))); },
    compute: async () => { const r = await plan.evaluate(source, { limit: 20 }); return wrap(r.rows, r.summary); },
  }, expected);
}
for (const width of [1, 4, 16]) {
  const fields = ['amount', ...Array.from({ length: width - 1 }, (_, i) => `f${i}`)];
  const plan = q.rows({ select: Object.fromEntries(fields.map(f => [f, q.field(f)])), orderBy: [{ expr: q.field('amount'), direction: 'desc' }, { expr: q.field('id') }] });
  const order = (a, b) => b.amount - a.amount || a.id - b.id;
  const expected = [...rows].sort(order).slice(0, 50).map(r => Object.fromEntries(fields.map(f => [f, r[f]])));
  await scenario('B03', `top 50 by amount, select ${width}`, N, {
    handwritten: async () => wrap([...rows].sort(order).slice(0, 50).map(r => Object.fromEntries(fields.map(f => [f, r[f]])))),
    'stream + map': async () => { const r = await evaluateStream(immutable, { sorters: [{ field: 'amount', direction: 'desc' }, { field: 'id' }], limit: 50 }, { sizeOf }); return wrap(r.rows.map(r => Object.fromEntries(fields.map(f => [f, r[f]])))); },
    compute: async () => { const r = await plan.evaluate(immutable, { limit: 50 }, { sizeOf }); return wrap(r.rows, r.summary); },
    'compute warm columns': async () => { const r = await plan.evaluate(cached, { limit: 50 }, { sizeOf }); return wrap(r.rows, r.summary); },
  }, expected);
}

// ---- B07/B08/B09/B10 scalar -----------------------------------------------------------------------------------------
for (const measures of [1, 4, 16]) {
  const defs = Object.fromEntries(Array.from({ length: measures }, (_, i) => [`m${i}`, i % 4 === 0 ? q.sum(q.field('amount')) : i % 4 === 1 ? q.count() : i % 4 === 2 ? q.avg(q.field('amount')) : q.max(q.field('qty'))]));
  const plan = q.aggregate({ measures: defs, numberMode: 'sequential' });
  const reference = () => {
    let sum = 0, n = 0, max = -Infinity;
    for (const r of rows) { sum += r.amount; n++; if (r.qty > max) max = r.qty; }
    return [Object.fromEntries(Object.keys(defs).map((k, i) => [k, i % 4 === 0 ? sum : i % 4 === 1 ? n : i % 4 === 2 ? sum / n : max]))];
  };
  await scenario('B07', `scalar, ${measures} measures (sequential)`, N, {
    handwritten: async () => wrap(reference()),
    compute: async () => { const r = await plan.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows, r.summary); },
    'compute warm columns': async () => { const r = await plan.evaluate(cached, {}, { sizeOf }); return wrap(r.rows, r.summary); },
  }, reference());
}
{
  const adversarial = Array.from({ length: N }, (_, id) => ({ id, x: id % 2 ? 1e16 : (id % 4 === 0 ? 1 : -1e16) }));
  const src = createImmutableArraySource(adversarial);
  const run = numberMode => async () => { const r = await q.aggregate({ measures: { s: q.sum(q.field('x')) }, numberMode }).evaluate(src, {}, { sizeOf: () => 48 }); return wrap(r.rows.map(x => typeof x.s), r.summary); };
  await scenario('B10', 'sum of cancelling magnitudes', N, { sequential: run('sequential'), compensated: run('compensated'), exact: run('exact') }, ['number']);
}

// ---- B11-B15 grouping, plus the compact-table probe ---------------------------------------------------------------
/** Experimental open-addressed table for one finite-number key (probe only, not shipped). */
function compactGroupSum(input, key, value) {
  let capacity = 1024, mask = capacity - 1, keys = new Float64Array(capacity), ids = new Int32Array(capacity).fill(-1);
  let size = 0, sums = new Float64Array(256), counts = new Float64Array(256), order = new Float64Array(256);
  for (const r of input) {
    const k = r[key];
    let h = Math.imul((k | 0) ^ ((k / 4294967296) | 0), 0x9e3779b1) & mask;
    while (ids[h] !== -1 && keys[h] !== k) h = (h + 1) & mask;
    let gid = ids[h];
    if (gid === -1) {
      gid = size++; ids[h] = gid; keys[h] = k;
      if (size > sums.length) { for (const name of ['sums', 'counts', 'order']) { const old = { sums, counts, order }[name], next = new Float64Array(old.length * 2); next.set(old); if (name === 'sums') sums = next; else if (name === 'counts') counts = next; else order = next; } }
      order[gid] = k;
      if (size * 2 > capacity) {
        const oldKeys = keys, oldIds = ids; capacity *= 2; mask = capacity - 1; keys = new Float64Array(capacity); ids = new Int32Array(capacity).fill(-1);
        for (let i = 0; i < oldIds.length; i++) if (oldIds[i] !== -1) { let j = Math.imul((oldKeys[i] | 0) ^ ((oldKeys[i] / 4294967296) | 0), 0x9e3779b1) & mask; while (ids[j] !== -1) j = (j + 1) & mask; ids[j] = oldIds[i]; keys[j] = oldKeys[i]; }
      }
    }
    sums[gid] += r[value]; counts[gid]++;
  }
  return Array.from({ length: size }, (_, g) => ({ k: order[g], n: counts[g], s: sums[g] }));
}
function mapGroupSum(input, key, value) {
  const groups = new Map();
  for (const r of input) { let g = groups.get(r[key]); if (!g) groups.set(r[key], g = { k: r[key], n: 0, s: 0 }); g.n++; g.s += r[value]; }
  return [...groups.values()];
}
for (const [key, label] of [['g16', 'G=16'], ['g1000', 'G=1000'], ['gN', 'G=100000']]) {
  const plan = q.aggregate({ groupBy: { k: q.field(key) }, measures: { n: q.count(), s: q.sum(q.field('amount')) }, numberMode: 'sequential' });
  const expected = mapGroupSum(rows, key, 'amount');
  await scenario('B11', `group sum/count, numeric ${label}`, N, {
    'handwritten Map': async () => wrap(mapGroupSum(rows, key, 'amount')),
    'probe: compact table': async () => wrap(compactGroupSum(rows, key, 'amount')),
    compute: async () => { const r = await plan.evaluate(immutable, {}, { sizeOf, maxOutputRows: 200_000 }); return wrap(r.rows, r.summary); },
    'compute warm columns': async () => { const r = await plan.evaluate(cached, {}, { sizeOf, maxOutputRows: 200_000 }); return wrap(r.rows, r.summary); },
  }, expected);
}
{
  const plan = q.aggregate({ groupBy: { k: q.field('name') }, measures: { n: q.count(), s: q.sum(q.field('amount')) }, numberMode: 'sequential' });
  await scenario('B13', 'group sum, 8-char strings, G=1000', N, {
    'handwritten Map': async () => wrap(mapGroupSum(rows, 'name', 'amount')),
    compute: async () => { const r = await plan.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows, r.summary); },
  }, mapGroupSum(rows, 'name', 'amount'));
}
{
  const plan = q.aggregate({ groupBy: { a: q.field('g16'), b: q.field('qty'), c: q.field('flag') }, measures: { n: q.count(), s: q.sum(q.field('amount')) }, numberMode: 'sequential' });
  const reference = () => {
    const groups = new Map();
    for (const r of rows) { const k = `${r.g16}|${r.qty}|${r.flag}`; let g = groups.get(k); if (!g) groups.set(k, g = { a: r.g16, b: r.qty, c: r.flag, n: 0, s: 0 }); g.n++; g.s += r.amount; }
    return [...groups.values()];
  };
  await scenario('B14', 'group by 3 fields (composite)', N, {
    'handwritten joined-string Map': async () => wrap(reference()),
    compute: async () => { const r = await plan.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows, r.summary); },
  }, reference());
}
{
  const skewed = Array.from({ length: N }, (_, id) => ({ id, g: id % 10 ? 0 : id % 1000, a: id % 17, b: id % 5, c: id % 3 }));
  const src = createImmutableArraySource(skewed);
  const plan = q.aggregate({ groupBy: { g: q.field('g') }, measures: { n: q.count(), sa: q.sum(q.field('a')), sb: q.sum(q.field('b')), mc: q.max(q.field('c')) }, numberMode: 'sequential' });
  const reference = () => {
    const groups = new Map();
    for (const r of skewed) { let g = groups.get(r.g); if (!g) groups.set(r.g, g = { g: r.g, n: 0, sa: 0, sb: 0, mc: null }); g.n++; g.sa += r.a; g.sb += r.b; if (g.mc === null || r.c > g.mc) g.mc = r.c; }
    return [...groups.values()];
  };
  await scenario('B15', 'skew: 90% in one group, 4 measures', N, {
    handwritten: async () => wrap(reference()),
    compute: async () => { const r = await plan.evaluate(src, {}, { sizeOf: () => 80 }); return wrap(r.rows, r.summary); },
  }, reference());
}

// ---- B16 certified ordered groups -----------------------------------------------------------------------------------
{
  const sorted = [...rows].sort((a, b) => a.g1000 - b.g1000 || a.id - b.id).map(r => ({ id: r.id, g: r.g1000, amount: r.amount }));
  const plain = createImmutableArraySource(sorted);
  const ordered = createImmutableArraySource(sorted, { keyCache: {}, ordering: compileQuery({ sorters: [{ field: 'g' }] }).ordering });
  await ordered.prepareKeys(['g', 'amount']);
  const plan = q.aggregate({ groupBy: { g: q.field('g') }, measures: { n: q.count(), s: q.sum(q.field('amount')) }, numberMode: 'sequential' });
  const expected = mapGroupSum(sorted, 'g', 'amount').map(({ k, n, s }) => ({ g: k, n, s })).slice(0, 20);
  await scenario('B16', 'groups over a source sorted by the key, limit 20', N, {
    hash: async () => { const r = await plan.evaluate(plain, { limit: 20 }, { sizeOf: () => 64 }); return wrap(r.rows, r.summary); },
    'ordered-groups': async () => { const r = await plan.evaluate(ordered, { limit: 20 }, { sizeOf: () => 64 }); return wrap(r.rows, r.summary); },
  }, expected);
}

// ---- B19/B21 ordered and filtered group output ------------------------------------------------------------------------
{
  const plan = q.aggregate({ groupBy: { k: q.field('gN') }, measures: { s: q.sum(q.field('amount')) }, orderBy: [{ field: 's', direction: 'desc' }, { field: 'k' }], numberMode: 'sequential' });
  const reference = () => mapGroupSum(rows, 'gN', 'amount').map(({ k, s }) => ({ k, s })).sort((a, b) => b.s - a.s || a.k - b.k).slice(0, 20);
  await scenario('B19', 'G=100000, ORDER BY sum desc, limit 20', N, {
    'handwritten full sort': async () => wrap(reference()),
    'compute (group-id top-k)': async () => { const r = await plan.evaluate(immutable, { limit: 20 }, { sizeOf }); return wrap(r.rows, r.summary); },
  }, reference());
  const having = q.aggregate({ groupBy: { k: q.field('gN') }, measures: { s: q.sum(q.field('amount')) }, having: [{ field: 's', op: 'gte', value: 100 }], numberMode: 'sequential' });
  const filtered = () => mapGroupSum(rows, 'gN', 'amount').map(({ k, s }) => ({ k, s })).filter(g => g.s >= 100).slice(1000, 1020);
  await scenario('B21', 'G=100000, HAVING sum >= 100, offset 1000 limit 20', N, {
    handwritten: async () => wrap(filtered()),
    compute: async () => { const r = await having.evaluate(immutable, { offset: 1000, limit: 20 }, { sizeOf }); return wrap(r.rows, r.summary); },
  }, filtered());
}

// ---- B22 page plus totals ---------------------------------------------------------------------------------------------
{
  const filters = [{ field: 'flag', op: 'eq', value: true }];
  const view = q.view({ filters, select: { id: q.field('id'), amount: q.field('amount') }, totals: { n: q.count(), s: q.sum(q.field('amount')), mean: q.avg(q.field('amount')), hi: q.max(q.field('qty')), lo: q.min(q.field('qty')) }, orderBy: [{ expr: q.field('amount'), direction: 'desc' }, { expr: q.field('id') }], numberMode: 'sequential' });
  const totalsPlan = q.aggregate({ filters, measures: { n: q.count(), s: q.sum(q.field('amount')), mean: q.avg(q.field('amount')), hi: q.max(q.field('qty')), lo: q.min(q.field('qty')) }, numberMode: 'sequential' });
  const pagePlan = q.rows({ filters, select: { id: q.field('id'), amount: q.field('amount') }, orderBy: [{ expr: q.field('amount'), direction: 'desc' }, { expr: q.field('id') }] });
  const reference = () => {
    const hit = rows.filter(r => r.flag);
    let s = 0, hi = -Infinity, lo = Infinity; for (const r of hit) { s += r.amount; hi = Math.max(hi, r.qty); lo = Math.min(lo, r.qty); }
    return { rows: [...hit].sort((a, b) => b.amount - a.amount || a.id - b.id).slice(0, 50).map(r => ({ id: r.id, amount: r.amount })), totals: { n: hit.length, s, mean: s / hit.length, hi, lo } };
  };
  await scenario('B22', 'filtered top 50 plus 5 totals', N, {
    handwritten: async () => wrap(reference()),
    'two compute scans': async () => { const [page, totals] = [await pagePlan.evaluate(immutable, { limit: 50 }, { sizeOf }), await totalsPlan.evaluate(immutable, {}, { sizeOf })]; return wrap({ rows: page.rows, totals: totals.rows[0] }); },
    'compute view (one scan)': async () => { const r = await view.evaluate(immutable, { limit: 50 }, { sizeOf }); return wrap({ rows: r.rows, totals: r.totals }, r.summary); },
  }, reference());
}

// ---- B26 sources --------------------------------------------------------------------------------------------------
{
  const plan = q.aggregate({ groupBy: { k: q.field('g16') }, measures: { n: q.count(), s: q.sum(q.field('amount')) }, numberMode: 'sequential' });
  const expected = mapGroupSum(rows, 'g16', 'amount').map(({ k, n, s }) => ({ k, n, s }));
  await scenario('B26', 'grouped, G=16, by source kind', N, {
    'copied array': async () => { const r = await plan.evaluate(copied, {}, { sizeOf }); return wrap(r.rows, r.summary); },
    immutable: async () => { const r = await plan.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows, r.summary); },
    'immutable, estimated sizes': async () => { const r = await plan.evaluate(immutable); return wrap(r.rows, r.summary); },
    'immutable, warm columns': async () => { const r = await plan.evaluate(cached, {}, { sizeOf }); return wrap(r.rows, r.summary); },
  }, expected);
}
// ---- B30-B32 exact sums and two-stage aggregation ------------------------------------------------------------------
// Sums of multiples of 1/8 below 2^53 are exact in every mode, so every variant must equal the handwritten Map.
{
  const expected = mapGroupSum(rows, 'g1000', 'amount');
  const mode = numberMode => q.aggregate({ groupBy: { k: q.field('g1000') }, measures: { n: q.count(), s: q.sum(q.field('amount')) }, numberMode });
  const [compensated, exact] = [mode('compensated'), mode('exact')];
  await scenario('B30', 'group sum/count, G=1000, by number mode', N, {
    compensated: async () => { const r = await compensated.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows, r.summary); },
    exact: async () => { const r = await exact.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows, r.summary); },
    'compensated warm columns': async () => { const r = await compensated.evaluate(cached, {}, { sizeOf }); return wrap(r.rows, r.summary); },
    'exact warm columns': async () => { const r = await exact.evaluate(cached, {}, { sizeOf }); return wrap(r.rows, r.summary); },
  }, expected);
}
/** Worker threads that each hold one slice of the rows and answer every message with the plan's partial over it. */
async function partialWorkers(descriptor, parts) {
  const size = Math.ceil(N / parts), dist = new URL('../dist/', import.meta.url).href;
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const [{ forRows }, { createImmutableArraySource }] = await Promise.all([import(workerData.dist + 'compute.mjs'), import(workerData.dist + 'stream.mjs')]);
      const wide = ${wide.toString()};
      const source = createImmutableArraySource(wide(workerData.end, workerData.start)), plan = forRows().aggregate(workerData.descriptor);
      parentPort.on('message', async () => {
        const partial = await plan.partial(source, { sizeOf: () => 640 });
        parentPort.postMessage(partial, partial.states.flatMap(state => Object.values(state).filter(ArrayBuffer.isView).map(view => view.buffer)));
      });
      parentPort.postMessage('ready');
    })();`;
  const started = performance.now();
  const pool = await Promise.all(Array.from({ length: parts }, (_, i) => new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { dist, descriptor, start: i * size, end: Math.min(N, (i + 1) * size) } });
    worker.once('message', () => resolve(worker)); worker.once('error', reject);
  })));
  const ask = () => Promise.all(pool.map(worker => new Promise(resolve => { worker.once('message', resolve); worker.postMessage(0); })));
  return { ask, startMs: performance.now() - started, close: () => Promise.all(pool.map(worker => worker.terminate())) };
}
for (const [id, key, label] of [['B31', 'g1000', 'G=1000'], ['B32', 'gN', 'G=100000']]) {
  const PARTS = 4, size = Math.ceil(N / PARTS);
  const descriptor = { groupBy: { k: q.field(key) }, measures: { n: q.count(), s: q.sum(q.field('amount')) }, numberMode: 'exact' };
  const plan = q.aggregate(descriptor), options = { maxOutputRows: 200_000, maxGroups: 200_000 };
  const parts = Array.from({ length: PARTS }, (_, i) => createImmutableArraySource(rows.slice(i * size, (i + 1) * size)));
  const workers = await partialWorkers(descriptor, PARTS);
  console.log(`${id} ${PARTS} worker threads started in ${workers.startMs.toFixed(1)} ms (outside the timed section)`);
  const inThread = clone => async () => {
    const partials = [];
    for (const part of parts) { const partial = await plan.partial(part, { sizeOf, maxGroups: 200_000 }); partials.push(clone ? structuredClone(partial) : partial); }
    const r = await plan.merge(partials, {}, options); return wrap(r.rows, r.summary);
  };
  try {
    await scenario(id, `group sum/count, ${label}, one pass against ${PARTS} parts plus merge`, N, {
      'one pass': async () => { const r = await plan.evaluate(immutable, {}, { sizeOf, ...options }); return wrap(r.rows, r.summary); },
      'parts in thread': inThread(false),
      'parts in thread, cloned': inThread(true),
      [`${PARTS} worker threads`]: async () => { const r = await plan.merge(await workers.ask(), {}, options); return wrap(r.rows, r.summary); },
    }, mapGroupSum(rows, key, 'amount'));
  } finally { await workers.close(); }
}
// ---- B34-B36 calendar buckets, distinct counts and percentiles ------------------------------------------------------
// Instants are epoch milliseconds computed from id, one minute apart from 2024-03-01, so the rows stay unchanged.
{
  const T0 = Date.UTC(2024, 2, 1), DAY = 86_400_000, at = q.add(q.literal(T0), q.mul(q.field('id'), q.literal(60_000)));
  const byDay = new Map();
  for (const { id } of rows) { const day = Math.floor((T0 + id * 60_000) / DAY); byDay.set(day, (byDay.get(day) ?? 0) + 1); }
  const utc = q.aggregate({ groupBy: { day: q.dateTrunc(at, 'day') }, measures: { n: q.count() } });
  const floor = q.aggregate({ groupBy: { day: q.floor(q.div(at, q.literal(DAY))) }, measures: { n: q.count() } });
  await scenario('B34', 'count by UTC day of a timestamp, against a numeric day key', N, {
    dateTrunc: async () => { const r = await utc.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows.map(({ day, n }) => [day.getTime() / DAY, n]), r.summary); },
    'floor(ms / day)': async () => { const r = await floor.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows.map(({ day, n }) => [day, n]), r.summary); },
  }, [...byDay]);
  // The reference reads each instant's Berlin date from Intl; its first instant comes from the plan's own output.
  const berlin = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }), local = new Map();
  for (const { id } of rows) { const key = berlin.format(T0 + id * 60_000); local.set(key, (local.get(key) ?? 0) + 1); }
  const zoned = q.aggregate({ groupBy: { day: q.dateTrunc(at, 'day', { timeZone: 'Europe/Berlin' }) }, measures: { n: q.count() } });
  await scenario('B35', 'count by Europe/Berlin day of a timestamp, across the DST change of 2024-03-31', N, {
    'dateTrunc Europe/Berlin': async () => { const r = await zoned.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows.map(({ day, n }) => [berlin.format(day), n]), r.summary); },
  }, [...local]);
  const names = new Map(), amounts = new Map();
  for (const row of rows) {
    (names.get(row.g1000) ?? names.set(row.g1000, new Set()).get(row.g1000)).add(row.name);
    (amounts.get(row.g1000) ?? amounts.set(row.g1000, []).get(row.g1000)).push(row.amount);
  }
  const median = xs => { const s = [...xs].sort((a, b) => a - b), h = (s.length - 1) / 2, lo = Math.floor(h); return s[lo] + (h - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]); };
  const distinct = q.aggregate({ groupBy: { k: q.field('g1000') }, measures: { names: q.countDistinct(q.field('name')), median: q.median(q.field('amount')) } });
  await scenario('B36', 'countDistinct and median per group, G=1000', N, {
    'countDistinct + median': async () => { const r = await distinct.evaluate(immutable, {}, { sizeOf }); return wrap(r.rows, r.summary); },
  }, [...names.keys()].map(k => ({ k, names: names.get(k).size, median: median(amounts.get(k)) })));
}
// ---- B33 partials over DBSONL key ranges in worker threads -------------------------------------------------------
{
  const DOCS = 100_000, dir = await mkdtemp(join(os.tmpdir(), 'dataview-bench-partials-'));
  const docs = wide(DOCS).map(({ id, g1000, amount, qty, flag, name }) => ({ id, g1000, amount, qty, flag, name }));
  const descriptor = { groupBy: { k: q.path('value.g1000') }, measures: { n: q.count(), s: q.sum(q.number(q.path('value.amount'))) }, numberMode: 'exact' };
  const plan = q.aggregate(descriptor);
  const backend = await createFileBackend(dir), db = await openDbsonl(backend, 'bench', { create: true });
  const unpooled = await createFileBackend(dir, { scanWorkers: 0 }), single = await openDbsonl(unpooled, 'bench');
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const [{ forRows }, { createDbsonlSource }, { openDbsonl }, { createFileBackend }] = await Promise.all([workerData.compute, workerData.adapter, workerData.dbsonl, workerData.server].map(url => import(url)));
      const db = await openDbsonl(await createFileBackend(workerData.dir, { io: 'sync' }), 'bench'), plan = forRows().aggregate(workerData.descriptor);
      parentPort.on('message', async ({ head, range }) => {
        const partial = await plan.partial(createDbsonlSource(db, { ...range, at: head }));
        parentPort.postMessage(partial, partial.states.flatMap(state => Object.values(state).filter(ArrayBuffer.isView).map(view => view.buffer)));
      });
      parentPort.postMessage('ready');
    })();`;
  const pools = [];
  try {
    for (let s = 0; s < DOCS; s += 5000) await db.batch(docs.slice(s, s + 5000).map(value => ({ operation: 'put', key: `doc:${String(value.id).padStart(8, '0')}`, value })));
    const urls = { compute: new URL('../dist/compute.mjs', import.meta.url).href, adapter: new URL('../dist/adapters/dbsonl.mjs', import.meta.url).href, dbsonl: import.meta.resolve('defuss-dbsonl'), server: import.meta.resolve('defuss-dbsonl/server') };
    const variants = {
      'one pass, no pool': async () => { const r = await plan.evaluate(createDbsonlSource(single)); return wrap(r.rows, r.summary); },
      'one pass, dbsonl scan pool': async () => { const r = await plan.evaluate(createDbsonlSource(db)); return wrap(r.rows, r.summary); },
    };
    for (const workers of [4, 8]) {
      const started = performance.now();
      const pool = await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
        const worker = new Worker(code, { eval: true, workerData: { ...urls, dir, descriptor } });
        worker.once('message', () => resolve(worker)); worker.once('error', reject);
      })));
      pools.push(pool);
      console.log(`B33 ${workers} worker threads opened the database in ${(performance.now() - started).toFixed(1)} ms (outside the timed section)`);
      variants[`${workers} worker threads`] = async () => {
        const session = await db.beginRead();
        try {
          const ranges = await session.split(workers);
          const partials = await Promise.all(ranges.map(({ gte, lt }, i) => new Promise(resolve => { pool[i].once('message', resolve); pool[i].postMessage({ head: session.head, range: { gte, lt } }); })));
          const r = await plan.merge(partials); return wrap(r.rows, r.summary);
        } finally { await session.close(); }
      };
    }
    await scenario('B33', 'DBSONL file, group sum/count, G=1000, one pass against partials over split() ranges', DOCS, variants, mapGroupSum(docs, 'g1000', 'amount'));
  } finally {
    await Promise.all(pools.flat().map(worker => worker.terminate()));
    await single.close(); await db.close(); await rm(dir, { recursive: true, force: true });
  }
}
void cut;

await mkdir('artifacts', { recursive: true });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const report = {
  version, measuredAt: new Date().toISOString(), environment,
  method: `${WARMUPS} warmup and ${SAMPLES} timed rounds per scenario; each round runs every variant once in rotated order. Input construction and source preparation are outside the timed section; source open, scan, validation, aggregation and output collection are inside. Every variant's result was compared with the handwritten loop before timing. p95 is nearest-rank. "probe: compact table" is an unshipped experiment.`,
  scenarios,
};
await writeFile('artifacts/compute-benchmark.json', JSON.stringify(report, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n');
console.log('wrote artifacts/compute-benchmark.json');
