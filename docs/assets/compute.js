// The landing page's live compute panel: prepared defuss-dataview/compute plans over seeded orders, run in this browser.
// The import map pins 'defuss-dataview/compute' to this local build's browser-compute.mjs by hash. That bundle also
// exports the stream sources, so a source and a plan share one module instance and the plan can lease prepared columns.
// VERIFIED: tests/e2e/docs.spec.ts runs every preset, checks results against plain loops and sees columns pinned.
// It is a module of its own, so a failure here leaves the rest of the page working.
import { createImmutableArraySource, forRows } from 'defuss-dataview/compute';
import { orders } from '../demo/data.js';
import { codeLines, jsonLines } from './json.js';

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en');
const money = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const q = forRows();
const field = (name) => q.field(name);
const amount = field('amount');
const gross = q.mul(amount, q.literal(1.19));

// Every preset pairs the plan it runs with the source text it shows; the text is written out, never evaluated.
// Each text starts with the same imports, source and builder, so it runs as written once orders exist.
const PRELUDE = `import { forRows } from 'defuss-dataview/compute';
import { createImmutableArraySource } from 'defuss-dataview/stream';

// orders: [{ id, customer, region, product, amount, date, status }, …]
const source = createImmutableArraySource(orders);
const q = forRows();
`;
const PLANS = {
  regions: {
    note: 'Hash grouping by region with four measures; the paid revenue counts only paid orders, through a measure predicate.',
    plan: q.aggregate({
      groupBy: { region: field('region') },
      measures: {
        orders: q.count(),
        paidRevenue: q.sum(amount, { where: q.eq(field('status'), q.literal('Paid')) }),
        averageOrder: q.avg(amount),
        largest: q.max(amount),
      },
      orderBy: [{ field: 'paidRevenue', direction: 'desc' }],
    }),
    page: {},
    code: PRELUDE + `const amount = q.field('amount');
const byRegion = q.aggregate({
  groupBy: { region: q.field('region') },
  measures: {
    orders: q.count(),
    paidRevenue: q.sum(amount, { where: q.eq(q.field('status'), q.literal('Paid')) }),
    averageOrder: q.avg(amount),
    largest: q.max(amount),
  },
  orderBy: [{ field: 'paidRevenue', direction: 'desc' }],
});
const { rows, summary } = await byRegion.evaluate(source, {}, { count: 'exact' });`,
  },
  pairs: {
    note: 'A composite key of two fields, a where clause before grouping, then HAVING on a measure, ordering and a page of 10 of the groups that remain.',
    plan: q.aggregate({
      where: q.neq(field('status'), q.literal('Failed')),
      groupBy: { region: field('region'), product: field('product') },
      measures: { orders: q.count(), revenue: q.sum(amount), averageOrder: q.avg(amount) },
      having: [{ field: 'averageOrder', op: 'gte', value: 750 }],
      orderBy: [{ field: 'revenue', direction: 'desc' }],
    }),
    page: { limit: 10 },
    code: PRELUDE + `const amount = q.field('amount');
const pairs = q.aggregate({
  where: q.neq(q.field('status'), q.literal('Failed')),
  groupBy: { region: q.field('region'), product: q.field('product') },
  measures: { orders: q.count(), revenue: q.sum(amount), averageOrder: q.avg(amount) },
  having: [{ field: 'averageOrder', op: 'gte', value: 750 }],
  orderBy: [{ field: 'revenue', direction: 'desc' }],
});
const { rows, summary } = await pairs.evaluate(source, { limit: 10 }, { count: 'exact' });`,
  },
  top: {
    note: 'A computed column used both as a hidden sort key and as an output. A stable top-k heap keeps 10 candidates; the selected columns are computed only for the 10 rows returned.',
    plan: q.rows({
      filters: [{ field: 'status', op: 'eq', value: 'Paid' }],
      select: { id: field('id'), customer: field('customer'), net: amount, gross },
      orderBy: [{ expr: gross, direction: 'desc' }, { expr: field('id') }],
    }),
    page: { limit: 10 },
    code: PRELUDE + `const gross = q.mul(q.field('amount'), q.literal(1.19));
const top = q.rows({
  filters: [{ field: 'status', op: 'eq', value: 'Paid' }],
  select: { id: q.field('id'), customer: q.field('customer'), net: q.field('amount'), gross },
  orderBy: [{ expr: gross, direction: 'desc' }, { expr: q.field('id') }],
});
const { rows, summary } = await top.evaluate(source, { limit: 10 }, { count: 'exact' });`,
  },
  view: {
    note: 'One scan returns the newest 10 EU orders and totals over every EU order, both from the same snapshot.',
    plan: q.view({
      filters: [{ field: 'region', op: 'eq', value: 'EU' }],
      select: { id: field('id'), date: field('date'), customer: field('customer'), status: field('status'), amount },
      totals: { orders: q.count(), revenue: q.sum(amount), averageOrder: q.avg(amount), refunded: q.count(undefined, { where: q.eq(field('status'), q.literal('Refunded')) }) },
      orderBy: [{ expr: field('date'), direction: 'desc' }, { expr: field('id') }],
    }),
    page: { limit: 10 },
    code: PRELUDE + `const amount = q.field('amount');
const table = q.view({
  filters: [{ field: 'region', op: 'eq', value: 'EU' }],
  select: { id: q.field('id'), date: q.field('date'), customer: q.field('customer'), status: q.field('status'), amount },
  totals: {
    orders: q.count(),
    revenue: q.sum(amount),
    averageOrder: q.avg(amount),
    refunded: q.count(undefined, { where: q.eq(q.field('status'), q.literal('Refunded')) }),
  },
  orderBy: [{ expr: q.field('date'), direction: 'desc' }, { expr: q.field('id') }],
});
const { rows, totals, summary } = await table.evaluate(source, { limit: 10 });`,
  },
  distinct: {
    note: 'Grouping without measures and a finite page: the plan stops once it has seen one group more than the page needs, so it scans only a few rows and reports the total as unknown.',
    plan: q.aggregate({ groupBy: { product: field('product') }, measures: {} }),
    page: { limit: 5 },
    code: PRELUDE + `const products = q.aggregate({ groupBy: { product: q.field('product') }, measures: {} });
const { rows, summary } = await products.evaluate(source, { limit: 5 });
// summary.strategy === 'first-seen', summary.totalResultRows === null`,
  },
};

// ---- sources: one dataset per size, a plain source and one with a key cache for prepared columns ------------------------
const datasets = new Map();
function dataset(size) {
  let entry = datasets.get(size);
  if (!entry) {
    const rows = orders(size);
    entry = { rows, plain: createImmutableArraySource(rows), cached: createImmutableArraySource(rows, { keyCache: { maxBytes: 512 * 1024 * 1024 } }) };
    datasets.set(size, entry);
  }
  return entry;
}

// ---- controls ------------------------------------------------------------------------------------------------------
// The choices live here, not in aria-pressed: the toggle group flips its own buttons before page listeners run.
let selected = 'regions';
const choice = { 'cp-size': 100_000, 'cp-columns': 'rows' };
function showPlan() {
  for (const button of $('cp-plans').querySelectorAll('[data-plan]')) {
    const on = button.dataset.plan === selected;
    button.setAttribute('aria-pressed', String(on));
    button.dataset.variant = on ? 'default' : 'secondary';
  }
  $('cp-plan-note').textContent = PLANS[selected].note;
  $('cp-code').replaceChildren(...codeLines(PLANS[selected].code));
}
$('cp-plans').addEventListener('click', (event) => {
  const button = event.target.closest('[data-plan]');
  if (!button) return;
  selected = button.dataset.plan;
  showPlan();
  void run();
});
// A document listener runs after the toggle group's own, so it can restore exactly one pressed button per group.
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('#cp-size .toggle, #cp-columns .toggle');
  if (!button) return;
  const group = button.closest('.toggle-group');
  for (const toggle of group.querySelectorAll('.toggle')) toggle.setAttribute('aria-pressed', String(toggle === button));
  const value = group.id === 'cp-size' ? Number(button.dataset.value) : button.dataset.value;
  if (choice[group.id] === value) return;
  choice[group.id] = value;
  void run();
});
$('cp-run').addEventListener('click', () => void run());

// ---- output ----------------------------------------------------------------------------------------------------------
const text = (value) => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number') return Number.isInteger(value) ? number.format(value) : money.format(value);
  return String(value);
};
const bytes = (value) => (value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`);
function statistic(title, value, kind) {
  const box = document.createElement('div');
  box.className = 'statistic';
  box.dataset.summary = kind ?? title;
  const label = document.createElement('p');
  label.className = 'statistic-title';
  label.textContent = title;
  const figure = document.createElement('p');
  figure.className = 'statistic-value';
  figure.textContent = value;
  box.append(label, figure);
  return box;
}
function showRows(rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  $('cp-head').replaceChildren(...columns.map((name) => {
    const cell = document.createElement('th');
    cell.className = 'table-head';
    cell.textContent = name;
    if (rows.some((row) => typeof row[name] === 'number' || typeof row[name] === 'bigint')) cell.dataset.numeric = '';
    return cell;
  }));
  $('cp-body').replaceChildren(...rows.map((row) => {
    const line = document.createElement('tr');
    line.className = 'table-row';
    line.append(...columns.map((name) => {
      const cell = document.createElement('td');
      cell.className = 'table-cell';
      const value = row[name];
      if (typeof value === 'number' || typeof value === 'bigint') cell.dataset.numeric = '';
      cell.textContent = text(value);
      return cell;
    }));
    return line;
  }));
}

// ---- run: prepare columns if asked, evaluate, then show the summary, rows, totals and explain() ---------------------------
let generation = 0;
async function run() {
  const current = ++generation;
  const size = choice['cp-size'], columns = choice['cp-columns'] === 'columns';
  const { plan, page } = PLANS[selected];
  const status = $('cp-status');
  $('cp-run').disabled = true;
  try {
    if (!datasets.has(size)) {
      status.textContent = `Generating ${number.format(size)} orders…`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const data = dataset(size);
    let prepared = '';
    if (columns) {
      const fields = plan.explain().requiredFields;
      status.textContent = `Preparing columns ${fields.join(', ')}…`;
      const started = performance.now();
      await data.cached.prepareKeys(fields);
      prepared = ` after prepareKeys([${fields.map((name) => `'${name}'`).join(', ')}]) in ${(performance.now() - started).toFixed(1)} ms`;
    }
    status.textContent = 'Running…';
    const started = performance.now();
    const result = await plan.evaluate(columns ? data.cached : data.plain, page, selected === 'distinct' || selected === 'view' ? {} : { count: 'exact' });
    const elapsed = performance.now() - started;
    if (current !== generation) return;
    const { summary } = result;
    $('cp-error').hidden = true;
    $('cp-summary').replaceChildren(
      statistic('time', `${elapsed.toFixed(1)} ms`, 'time'),
      statistic('strategy', summary.strategy),
      statistic('scannedRows', number.format(summary.scannedRows)),
      statistic('totalResultRows', summary.totalResultRows === null ? 'unknown' : number.format(summary.totalResultRows)),
      statistic('returnedRows', number.format(summary.returnedRows)),
      statistic('peakWorkingBytes', bytes(summary.peakWorkingBytes)),
      statistic('cacheBytesPinned', bytes(summary.cacheBytesPinned)),
    );
    showRows(result.rows);
    const totals = $('cp-totals');
    totals.hidden = !result.totals;
    totals.replaceChildren(...(result.totals ? Object.entries(result.totals).map(([name, value]) => statistic(`totals.${name}`, text(value), `totals.${name}`)) : []));
    $('cp-explain').replaceChildren(...jsonLines(JSON.stringify({ explain: plan.explain(), summary }, (_, value) => (typeof value === 'bigint' ? String(value) : value), 2)));
    status.textContent = `${number.format(size)} orders, ${columns ? 'prepared columns' : 'fields read from rows'}${prepared}.`;
  } catch (failure) {
    if (current !== generation) return;
    $('cp-error-message').textContent = failure instanceof Error ? failure.message : String(failure);
    $('cp-error').hidden = false;
    status.textContent = '';
  } finally {
    if (current === generation) $('cp-run').disabled = false;
  }
}

showPlan();

// ---- row reads against prepared columns: the two ways to give a plan its source, as code in the comparison card ------
const PLAN_CODE = `import { forRows } from 'defuss-dataview/compute';
import { createImmutableArraySource } from 'defuss-dataview/stream';

const q = forRows();
const byRegion = q.aggregate({
  groupBy: { region: q.field('region') },
  measures: { revenue: q.sum(q.field('amount')) },
});

// orders: [{ id, customer, region, product, amount, date, status }, …]
`;
const SOURCE_CODE = {
  rows: PLAN_CODE + `// Nothing to prepare: every run reads row.region and row.amount.
const source = createImmutableArraySource(orders);
const { rows, summary } = await byRegion.evaluate(source, {}, { count: 'exact' });
// summary.cacheBytesPinned === 0`,
  columns: PLAN_CODE + `// 1. Give the source a key cache; it is off by default and bounded by maxBytes.
const source = createImmutableArraySource(orders, {
  keyCache: { maxBytes: 512 * 1024 * 1024 },
});
// 2. Build one column per field the plan reads, once.
//    explain().requiredFields is ['region', 'amount'] here.
await source.prepareKeys(byRegion.explain().requiredFields);
// 3. Run plans as before: they read the columns, not the rows.
const { rows, summary } = await byRegion.evaluate(source, {}, { count: 'exact' });
// summary.cacheBytesPinned > 0`,
};
$('cp-prep-rows').replaceChildren(...codeLines(SOURCE_CODE.rows));
$('cp-prep-columns').replaceChildren(...codeLines(SOURCE_CODE.columns));

// The first run waits until the panel nears the viewport, so the 100,000 orders are not generated for readers who never scroll here.
new IntersectionObserver((records, observer) => {
  if (!records.some((record) => record.isIntersecting)) return;
  observer.disconnect();
  void run();
}, { rootMargin: '400px 0px' }).observe($('compute'));

// ---- versus MongoDB: assets/mongodb-compute.json (bun run benchmark:mongodb-compute) fills the table ------------------
// Each row compares dataview's row-read engine, which needs no preparation, with the faster of MongoDB's two variants.
// VERIFIED: tests/e2e/docs.spec.ts checks every query row, both sizes and the verdict count against the JSON.
const ENGINES = ['dataview, row reads', 'dataview, prepared columns', 'MongoDB', 'MongoDB + indexes'];
const ms = (value) => (value < 10 ? `${value.toFixed(2)} ms` : `${number.format(Math.round(value))} ms`);
let versus = { size: '1000000' };
function showVersus(data) {
  const run = data.sizes[versus.size] ?? Object.values(data.sizes)[0];
  const body = $('cp-vs-body');
  let wins = 0, total = 0;
  body.replaceChildren(...Object.entries(data.queries).map(([id, label]) => {
    const times = ENGINES.map((engine) => run.results.find((r) => r.query === id && r.engine === engine)?.medianMs);
    const fastest = Math.min(...times);
    const ratio = Math.min(times[2], times[3]) / times[0];
    total++; if (ratio > 1) wins++;
    const line = document.createElement('tr');
    line.className = 'table-row';
    line.dataset.query = id;
    const cell = (content, numeric) => { const td = document.createElement('td'); td.className = 'table-cell'; td.textContent = content; if (numeric) td.dataset.numeric = ''; return td; };
    // The verdict comes right after the query, so a phone shows it without scrolling the table sideways.
    const verdict = cell(ratio >= 1 ? `${ratio.toFixed(1)}× faster` : `${(1 / ratio).toFixed(1)}× slower`, true);
    verdict.dataset.verdict = ratio >= 1 ? 'win' : 'loss';
    line.append(cell(label), verdict, ...times.map((value) => { const td = cell(ms(value), true); if (value === fastest) td.dataset.fastest = ''; return td; }));
    return line;
  }));
  $('cp-vs-wins').textContent = `faster in ${wins} of ${total}`;
  $('cp-vs-prepare').textContent = `prepareKeys() over the ${run.prepare.fields.length} fields of all five plans took ${ms(run.prepare.ms)} once for ${number.format(Number(versus.size in data.sizes ? versus.size : Object.keys(data.sizes)[0]))} orders`;
  const env = run.environment;
  $('cp-vs-source').textContent = `Medians of 7 alternating runs with bun run benchmark:mongodb-compute on an ${env.cpu}, Node.js ${env.node}, MongoDB ${env.mongodb} (${env.storageEngine}), ${run.measuredAt.slice(0, 10)}.`;
}
fetch('assets/mongodb-compute.json').then((response) => {
  if (!response.ok) throw new Error(`assets/mongodb-compute.json answered ${response.status}`);
  return response.json();
}).then((data) => {
  showVersus(data);
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('#cp-vs-size .toggle');
    if (!button) return;
    for (const toggle of button.parentElement.querySelectorAll('.toggle')) toggle.setAttribute('aria-pressed', String(toggle === button));
    versus = { size: button.dataset.value };
    showVersus(data);
  });
});
