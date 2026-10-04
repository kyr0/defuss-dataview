import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as improved from '../dist/index.mjs';
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['tests/fixtures/upstream-src/index.ts'], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: 'artifacts/upstream-benchmark.mjs' });
const upstream = await import('../artifacts/upstream-benchmark.mjs');
const flat = Array.from({ length: 100000 }, (_, id) => ({ id, score: id % 100, name: `Item ${id}` }));
const balanced = Array.from({ length: 50000 }, (_, id) => ({ id, parentId: id ? Math.floor((id - 1) / 4) : null }));
const deep = Array.from({ length: 2000 }, (_, id) => ({ id, parentId: id ? id - 1 : null }));
const scenarios = [
  { name: '100k flat filter + page', rows: flat, request: { filters: [{ field: 'score', op: 'gte', value: 50 }], pageSize: 50 } },
  { name: '100k flat filter + sort + page', rows: flat, request: { filters: [{ field: 'score', op: 'gte', value: 50 }], sorters: [{ field: 'score', direction: 'desc' }], pageSize: 50 } },
  { name: '50k balanced tree + page', rows: balanced, request: { tree: { idField: 'id', parentIdField: 'parentId' }, pageSize: 50 } },
  { name: '2k deep tree + page', rows: deep, request: { tree: { idField: 'id', parentIdField: 'parentId' }, pageSize: 50 } },
];
const results = [];
for (const scenario of scenarios) {
  const oldView = upstream.createDataview(scenario.request), newView = improved.createDataview(scenario.request);
  assert.deepEqual(improved.applyDataview(scenario.rows, newView), upstream.applyDataview(scenario.rows, oldView));
  for (let warmup = 0; warmup < 3; warmup++) { upstream.applyDataview(scenario.rows, oldView); improved.applyDataview(scenario.rows, newView); }
  const oldTimes = [], newTimes = [];
  const measure = (api, view, times) => { const start = performance.now(); api.applyDataview(scenario.rows, view); times.push(performance.now() - start); };
  for (let trial = 0; trial < 9; trial++) {
    if (trial % 2) { measure(improved, newView, newTimes); measure(upstream, oldView, oldTimes); }
    else { measure(upstream, oldView, oldTimes); measure(improved, newView, newTimes); }
  }
  const median = values => [...values].sort((a, b) => a - b)[4];
  results.push({ scenario: scenario.name, upstreamMedianMs: median(oldTimes), improvedMedianMs: median(newTimes), samples: { upstreamMs: oldTimes, improvedMs: newTimes } });
}
await writeFile('artifacts/benchmark-comparison.json', JSON.stringify({ node: process.version, sourceCommit: '50aae32aa9aea45612510703e75875ed98aa6386', trials: 9, warmups: 3, caveat: 'Local non-gating measurements; includes stronger validation, own-property access and pagination counts in the improved implementation. No universal speedup claim.', results }, null, 2) + '\n');
console.table(results.map(({ samples: _samples, ...result }) => result));
