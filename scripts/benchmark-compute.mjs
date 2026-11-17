// defuss-dataview/compute benchmark (plan BENCHMARK_MATRIX core scenarios). It runs the built package, checks every
// variant against a handwritten loop outside the timed section, and alternates variants within each sample round so
// drift affects them equally. Raw samples are kept; nothing is trimmed. Writes artifacts/compute-benchmark.json.
// Usage: bun run build && bun run benchmark:compute [-- --samples 9 --rows 200000]
// The compact-table rows are a probe only: the experimental open-addressed table below is not shipped, and
// documentation/COMPUTE_PERFORMANCE.md records why Map stays the grouping store.
// Rotating the variant order inside each round, rather than timing each variant in its own block, keeps thermal and
// GC drift from favouring whichever variant runs first.
// VERIFIED: a full run on 2026-11-17 (Apple M5 Max, Node.js 26.13.1) produced the figures in COMPUTE_PERFORMANCE.md.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
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
function wide(n) {
  return Array.from({ length: n }, (_, id) => {
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
  await scenario('B10', 'sum of cancelling magnitudes', N, { sequential: run('sequential'), compensated: run('compensated') }, ['number']);
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
