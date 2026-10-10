// Writes docs/assets/metrics.json, the data behind the website's "Measured" section: scaling benchmarks of the built
// dist/ (lists by length, trees by depth and by size) plus coverage and test counts from the last test runs.
// Run it through `make site-metrics`, which builds and runs the tests first. Benchmarks stay non-gating: they describe
// one machine, which the file names, and the page shows that machine next to the numbers.
// VERIFIED: on an Apple M4 with Node 24.14 (2026-10-10) the benchmark part takes about 10 s; repeated runs moved the
// 1,000,000-row filter + page median between 28 and 32 ms, which is why the page names the machine and the date.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createDataview, evaluateDataview } from '../dist/index.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const round = (ms) => Math.round(ms * 1000) / 1000;

/** Median and minimum of `runs` timed evaluateDataview() calls after `warmups` untimed ones. */
function time(rows, request, runs) {
  const view = createDataview(request);
  for (let warmup = 0; warmup < 3; warmup++) evaluateDataview(rows, view);
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    const result = evaluateDataview(rows, view);
    samples.push(performance.now() - started);
    if (!result.totalRows) throw new Error('empty benchmark input');
  }
  return { medianMs: round(median(samples)), minMs: round(Math.min(...samples)), runs };
}
const runsFor = (count) => (count >= 1_000_000 ? 5 : count >= 100_000 ? 9 : 15);

// Lists: rows { id, name, score }; the filter keeps half of them, pages are 50 rows.
const LENGTHS = [1_000, 10_000, 100_000, 1_000_000];
const list = (count) => Array.from({ length: count }, (_, id) => ({ id, name: `Item ${id}`, score: (id * 7919) % 100 }));
const LIST_SCENARIOS = [
  ['filter + page', { filters: [{ field: 'score', op: 'gte', value: 50 }], page: 0, pageSize: 50 }],
  ['filter + sort + page', { filters: [{ field: 'score', op: 'gte', value: 50 }], sorters: [{ field: 'score', direction: 'desc' }, { field: 'name', direction: 'asc' }], page: 0, pageSize: 50 }],
];

// Trees by depth: a chain where every row is the child of the one before, so depth = length - 1.
const DEPTHS = [10, 100, 1_000, 10_000, 100_000];
const chain = (depth) => Array.from({ length: depth + 1 }, (_, id) => ({ id, parentId: id ? id - 1 : null, name: `Level ${id}` }));
const TREE = { idField: 'id', parentIdField: 'parentId' };
const DEPTH_SCENARIOS = [
  ['all open + page', () => ({ tree: TREE, page: 0, pageSize: 50 })],
  ['match the deepest row + its ancestors', (depth) => ({ tree: TREE, filters: [{ field: 'id', op: 'eq', value: depth }], page: 0, pageSize: 50 })],
];

// Trees by size: a balanced tree with four children per node.
const SIZES = [1_000, 10_000, 100_000, 1_000_000];
const balanced = (count) => Array.from({ length: count }, (_, id) => ({ id, parentId: id ? Math.floor((id - 1) / 4) : null, score: (id * 7919) % 100 }));
const SIZE_SCENARIOS = [
  ['all open + page', { tree: TREE, page: 0, pageSize: 50 }],
  ['filter + sort siblings + page', { tree: TREE, filters: [{ field: 'score', op: 'gte', value: 90 }], sorters: [{ field: 'score', direction: 'desc' }], page: 0, pageSize: 50 }],
];

const benchmarks = { lists: [], depth: [], size: [] };
for (const count of LENGTHS) {
  const rows = list(count);
  for (const [scenario, request] of LIST_SCENARIOS) benchmarks.lists.push({ scenario, rows: count, ...time(rows, request, runsFor(count)) });
}
for (const depth of DEPTHS) {
  const rows = chain(depth);
  for (const [scenario, request] of DEPTH_SCENARIOS) benchmarks.depth.push({ scenario, depth, rows: rows.length, ...time(rows, request(depth), runsFor(rows.length)) });
}
for (const count of SIZES) {
  const rows = balanced(count);
  for (const [scenario, request] of SIZE_SCENARIOS) benchmarks.size.push({ scenario, rows: count, ...time(rows, request, runsFor(count)) });
}

// Coverage and test counts come from the runs `make site-metrics` did just before; their dates go into the file too.
const json = async (path) => ({ data: JSON.parse(await readFile(path, 'utf8')), at: (await stat(path)).mtime.toISOString() });
const coverage = await json('coverage/coverage-summary.json');
const unit = await json('artifacts/unit-results.json');
const browser = await json('artifacts/browser-results.json');
const provenance = JSON.parse(await readFile('tests/fixtures/provenance.json', 'utf8'));
const originalFiles = new Set(provenance.originalTests.map((file) => file.path));
const originalTests = unit.data.testResults.filter((file) => [...originalFiles].some((path) => file.name.endsWith(path)))
  .reduce((sum, file) => sum + file.assertionResults.length, 0);
const pct = (key) => coverage.data.total[key].pct;

const metrics = {
  version: pkg.version,
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length },
  method: 'Median of 15 timed evaluateDataview() calls (9 at 100,000 rows, 5 at 1,000,000) after 3 untimed ones, on dist/index.mjs. Rows are generated before timing; createDataview() runs once per scenario.',
  benchmarks,
  coverage: { lines: pct('lines'), statements: pct('statements'), functions: pct('functions'), branches: pct('branches'), at: coverage.at },
  tests: {
    unit: { total: unit.data.numTotalTests, passed: unit.data.numPassedTests, files: unit.data.numTotalTestSuites, at: unit.at },
    original: originalTests,
    browser: { total: browser.data.stats.expected + browser.data.stats.unexpected + browser.data.stats.flaky + browser.data.stats.skipped, passed: browser.data.stats.expected, at: browser.at },
  },
};
await writeFile('docs/assets/metrics.json', `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`docs/assets/metrics.json: ${metrics.version} @ ${metrics.commit}, ${metrics.environment.cpu}, node ${metrics.environment.node}`);
for (const [group, rows] of Object.entries(benchmarks)) console.table(rows.map(({ runs: _runs, ...row }) => ({ group, ...row })));
