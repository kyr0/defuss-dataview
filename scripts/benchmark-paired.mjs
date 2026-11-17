// Paired table/tree comparison of two builds on one machine: `node scripts/benchmark-paired.mjs <old index.mjs> [new index.mjs]`.
// VERIFIED: alternating calls cancel most drift; two runs on 2026-11-15 agreed within 0.06 on every ratio, while the
// 0.4.0 README table from another machine (M4, Node 24) put the 1M-row tree at 236 ms against 651 ms here. The README's
// release comparison comes from this script with the previous npm release (`npm pack defuss-dataview@<version>`).
// Non-gating: it writes artifacts/benchmark-paired.json and prints one line per scenario.
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const [oldPath, newPath = 'dist/index.mjs'] = process.argv.slice(2);
if (!oldPath) throw new Error('usage: node scripts/benchmark-paired.mjs <old index.mjs> [new index.mjs]');
const load = (path) => import(pathToFileURL(resolve(path)).href);
const old = await load(oldPath), now = await load(newPath);
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const tree = (n) => Array.from({ length: n }, (_, i) => ({ id: i, parentId: i === 0 ? null : Math.floor((i - 1) / 4), score: (i * 7919) % 100, name: 'n' + i }));
const chain = (n) => Array.from({ length: n + 1 }, (_, i) => ({ id: i, parentId: i ? i - 1 : null, score: i }));
const list = (n) => Array.from({ length: n }, (_, i) => ({ id: i, name: 'n' + (i % 977), score: (i * 7919) % 1000 }));
const forest = { idField: 'id', parentIdField: 'parentId' };
const cases = [
  ['list filter + sort + page / 100k', list(100_000), { filters: [{ field: 'score', op: 'gte', value: 500 }], sorters: [{ field: 'score', direction: 'desc' }, { field: 'name' }], pageSize: 50 }],
  ['tree all open + page / 100k', tree(100_000), { tree: forest, pageSize: 50 }],
  ['tree filter + sort siblings + page / 100k', tree(100_000), { tree: forest, filters: [{ field: 'score', op: 'gte', value: 90 }], sorters: [{ field: 'score', direction: 'desc' }], pageSize: 50 }],
  ['chain all open + page / depth 100k', chain(100_000), { tree: forest, pageSize: 50 }],
  ['tree all open + page / 1M', tree(1_000_000), { tree: forest, pageSize: 50 }],
];
const scenarios = [];
for (const [name, rows, request] of cases) {
  const runs = rows.length >= 1_000_000 ? 5 : 11, before = [], after = [];
  const oldView = old.createDataview(request), newView = now.createDataview(request);
  for (let warmup = 0; warmup < 3; warmup++) { old.evaluateDataview(rows, oldView); now.evaluateDataview(rows, newView); }
  for (let run = 0; run < runs; run++) {
    const order = run % 2 ? [[old, oldView, before], [now, newView, after]] : [[now, newView, after], [old, oldView, before]];
    for (const [api, view, samples] of order) { const started = performance.now(); api.evaluateDataview(rows, view); samples.push(performance.now() - started); }
  }
  const scenario = { name, rows: rows.length, runs, oldMedianMs: median(before), newMedianMs: median(after), ratio: median(after) / median(before) };
  scenarios.push(scenario);
  console.log(`${name.padEnd(44)} old ${scenario.oldMedianMs.toFixed(2)} ms  new ${scenario.newMedianMs.toFixed(2)} ms  ratio ${scenario.ratio.toFixed(2)}`);
}
const environment = { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/benchmark-paired.json', JSON.stringify({ old: oldPath, new: newPath, measuredAt: new Date().toISOString(), environment, method: '3 warmups, alternating paired calls, median of 11 (5 at 1,000,000 rows); ratio = new / old', scenarios }, null, 2) + '\n');
