// DBSONL scans through the stream adapter: `node scripts/benchmark-dbsonl.mjs [rows] [package dir ...]`.
// Compares the installed defuss-dbsonl with any extra package dirs (for example `bun add defuss-dbsonl@0.5.0` in an
// empty directory, then its node_modules/defuss-dbsonl) on memory and file storage, alternating packages in every run
// so host drift hits all of them. Packages with scanBatches are also timed on it; the stream adapter uses it when
// present. Non-gating: writes artifacts/benchmark-dbsonl.json.
// VERIFIED: on 2026-11-17 (M5 Max, Node 26, 100,000 rows) defuss-dbsonl 0.6.0 beat 0.5.0 on every workload;
// documentation/PERFORMANCE.md has the table.
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { createDbsonlSource } from '../dist/adapters/dbsonl.mjs';
import { evaluateStream } from '../dist/stream.mjs';

const [rowsArg, ...extra] = process.argv.slice(2);
const total = Number(rowsArg ?? 100_000);
const fromDir = async (dir) => ({
  name: `defuss-dbsonl ${JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8')).version}`, index: await import(pathToFileURL(resolve(dir, 'dist/index.mjs')).href), server: await import(pathToFileURL(resolve(dir, 'dist/server.mjs')).href),
});
const packages = [
  { name: `defuss-dbsonl ${JSON.parse(await readFile('node_modules/defuss-dbsonl/package.json', 'utf8')).version} (installed)`, index: await import('defuss-dbsonl'), server: await import('defuss-dbsonl/server') },
  ...await Promise.all(extra.map(fromDir)),
];
const directories = [];
const value = (i) => ({ title: `doc ${i}`, score: (i * 7919) % 1000, tags: ['a', 'b'], at: new Date(1_700_000_000_000 + i) });
async function open(pkg, storage) {
  let backend;
  if (storage === 'memory') backend = pkg.index.createMemoryBackend();
  else { const dir = await mkdtemp(join(tmpdir(), 'dataview-bench-dbsonl-')); directories.push(dir); backend = await pkg.server.createFileBackend(dir); }
  const db = await pkg.index.openDbsonl(backend, 'bench', { create: true });
  for (let start = 0; start < total; start += 5000) {
    const batch = [];
    for (let i = start; i < Math.min(total, start + 5000); i++) batch.push({ operation: 'put', key: `doc:${String(i).padStart(8, '0')}`, value: value(i) });
    await db.batch(batch);
  }
  return db;
}
const top = { filters: [{ field: 'value.score', op: 'gte', value: 500 }], sorters: [{ field: 'value.score', direction: 'desc' }, { field: 'key' }], limit: 50 };
const scenarios = {
  'snapshot.scan': async (db) => { const s = await db.beginRead(); let n = 0; try { for await (const _ of s.scan()) n++; } finally { await s.close(); } return n; },
  'snapshot.scanBatches': async (db) => { const s = await db.beginRead(); let n = 0; try { if (!s.scanBatches) return undefined; for await (const rows of s.scanBatches()) n += rows.length; } finally { await s.close(); } return n; },
  'stream filter + top-50, exact count': async (db) => { const r = await evaluateStream(createDbsonlSource(db), top, { count: 'exact' }); return r.summary.totalMatches + ':' + r.rows.map((row) => row.key).join(); },
  'stream first page / 50': async (db) => { const r = await evaluateStream(createDbsonlSource(db), { limit: 50 }); return r.rows.map((row) => row.key).join(); },
};
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const results = [];
try {
  for (const storage of ['memory', 'file']) {
    const dbs = [];
    for (const pkg of packages) dbs.push(await open(pkg, storage));
    for (const [scenario, run] of Object.entries(scenarios)) {
      const samples = packages.map(() => []), answers = [];
      for (let i = 0; i < packages.length; i++) answers[i] = await run(dbs[i]); // warmup + result
      const expected = answers.find((answer) => answer !== undefined);
      answers.forEach((answer, i) => { if (answer !== undefined && answer !== expected) throw new Error(`${packages[i].name} disagrees on ${scenario}`); });
      for (let round = 0; round < 7; round++) {
        const order = packages.map((_, i) => i); if (round % 2) order.reverse();
        for (const i of order) { if (answers[i] === undefined) continue; globalThis.gc?.(); const started = performance.now(); await run(dbs[i]); samples[i].push(performance.now() - started); }
      }
      packages.forEach((pkg, i) => {
        if (answers[i] === undefined) return;
        const ms = median(samples[i]);
        results.push({ storage, scenario, package: pkg.name, medianMs: ms, rowsPerSecond: Math.round(total / (ms / 1000)) });
        console.log(`${storage.padEnd(7)}${scenario.padEnd(38)}${pkg.name.padEnd(34)}${ms.toFixed(1).padStart(8)} ms`);
      });
    }
    for (const db of dbs) await db.close();
  }
} finally { for (const dir of directories) await rm(dir, { recursive: true, force: true }); }
const environment = { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/benchmark-dbsonl.json', JSON.stringify({ rows: total, measuredAt: new Date().toISOString(), environment, method: '1 warmup that also cross-checks results, then median of 7 alternating runs, gc between runs when --expose-gc', results }, null, 2) + '\n');
