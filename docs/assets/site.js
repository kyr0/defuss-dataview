// The landing page script. index.html loads defuss-shadcn (df$) from jsDelivr first; this module wires the page and runs
// the query explorer on defuss-dataview, which the page's import map pins to this local build.
// VERIFIED: tests/e2e/docs.spec.ts fails while that pin differs from the local package version, and the browser refuses the
// module when its bytes do not match the integrity hash, so the explorer exercises exactly the built artifact.
import { createDataview, evaluateDataview } from 'defuss-dataview';
import { units } from '../demo/data.js';
import { jsonLines } from './json.js';

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---- theme: this page and the demo frame follow one switch -----------------------------------------------------------
// VERIFIED: the frame is same-origin, so the page repaints its root directly; tests/e2e/docs.spec.ts checks both roots.
// A postMessage protocol would also work across origins, which this site does not need.
const themeToggle = $('theme-toggle');
const frame = document.querySelector('#playground iframe');
const paint = (doc, dark) => {
  doc.documentElement.classList.toggle('dark', dark);
  doc.documentElement.style.colorScheme = dark ? 'dark' : 'light';
};
const frameDocument = () => { try { return frame.contentDocument; } catch { return null; } };
function setTheme(dark) {
  paint(document, dark);
  const doc = frameDocument();
  if (doc?.documentElement) paint(doc, dark);
  themeToggle.checked = dark;
  try { localStorage.setItem('defuss-shadcn-theme', JSON.stringify(dark ? 'dark' : 'light')); } catch {}
}
themeToggle.checked = document.documentElement.classList.contains('dark');
themeToggle.addEventListener('change', () => setTheme(themeToggle.checked));
frame.addEventListener('load', () => {
  const doc = frameDocument();
  if (doc?.documentElement) paint(doc, document.documentElement.classList.contains('dark'));
});
$('playground-restart').addEventListener('click', () => {
  // replace(): restarting the demo must not add an entry to the tab's session history
  frame.contentWindow?.location.replace(frame.src);
});

// ---- in-page links scroll without adding history entries ------------------------------------------------------------
// Layout offsets ignore transforms, so a section still in its scroll-driven reveal lands at its scroll margin
// (defuss-dom-router measured scrollIntoView() 62 px off for such a section).
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest('a[href^="#"]');
  let id = '';
  try { id = anchor ? decodeURIComponent(anchor.hash.slice(1)) : ''; } catch { return; }
  const target = id && document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  let top = 0;
  for (let node = target; node; node = node.offsetParent) top += node.offsetTop;
  scrollTo({ top: top - parseFloat(getComputedStyle(target).scrollMarginTop || '0'), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  history.replaceState(history.state, '', anchor.hash);
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
});

// ---- copy buttons ---------------------------------------------------------------------------------------------------
async function copyText(text, status, label) {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Copied';
  } catch {
    status.textContent = 'Copy failed';
  }
  if (!label) return;
  label.textContent = status.textContent;
  setTimeout(() => { label.textContent = 'Copy prompt'; }, 2000);
}
// The explorer's editor has its own copy and format buttons (below); these blocks copy their visible lines.
for (const button of document.querySelectorAll('.mk-code-block:not(.dv-editor) .mk-code-block-copy')) {
  button.addEventListener('click', () => {
    const block = button.closest('.mk-code-block');
    const tab = block.querySelector('.mk-code-block-tabs input:checked')?.value;
    const pre = tab ? block.querySelector(`pre[data-tab="${tab}"]`) : block.querySelector('pre');
    const lines = [...pre.querySelectorAll('code > span')].map((line) => line.textContent);
    void copyText(lines.join('\n'), block.querySelector('.mk-code-block-status'));
  });
}
$('copy-prompt').addEventListener('click', () => void copyText(
  [...document.querySelectorAll('#agent-prompt pre:not([data-tone]) code')].map((code) => code.textContent).join('\n'),
  $('copy-prompt-status'), $('copy-prompt').querySelector('span')));

// ---- query explorer -------------------------------------------------------------------------------------------------
// The rows live in one array, the one Apply evaluates; the Virtual List shows a window of it as inputs, and every edit
// writes straight into the array. A table with an input per cell would mean 50,000 inputs for the demo rows.
// VERIFIED: tests/e2e/docs.spec.ts finds fewer than 200 inputs on the page while the array holds 10,000 rows.
// The demo rows are seeded org units (../demo/data.js); in cycle, rows 1-3 name each other as parents.
const DEMO_ROWS = 10_000;
const CYCLE = [
  { id: 1, parentId: 3, name: 'Loop A', region: 'EU', score: 10 },
  { id: 2, parentId: 1, name: 'Loop B', region: 'EU', score: 20 },
  { id: 3, parentId: 2, name: 'Loop C', region: 'US', score: 30 },
  { id: 4, parentId: null, name: 'Root', region: 'US', score: 40 },
  { id: 5, parentId: 4, name: 'Child', region: 'APAC', score: 50 },
];
const FIELDS = ['id', 'parentId', 'name', 'region', 'score'];
const TEXT_FIELDS = new Set(['name', 'region']);
const list = $('ex-rows');
const query = $('ex-query');
const highlight = $('ex-highlight');
const grid = $('ex-grid');
const stale = $('ex-stale');
const number = new Intl.NumberFormat('en');
let rows = units(DEMO_ROWS);

/** A cell's text as a row value: empty is null, a decimal number is a number, anything else stays a string. */
const valueOf = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
};

function cellsFor(row) {
  const cells = document.createElement('div');
  cells.className = 'dv-row-cells';
  for (const field of FIELDS) {
    const input = document.createElement('input');
    input.className = 'input';
    input.dataset.size = 'sm';
    input.dataset.field = field;
    input.spellcheck = false;
    cells.append(input);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn dv-remove';
  remove.dataset.variant = 'ghost';
  remove.dataset.size = 'icon-sm';
  remove.innerHTML = '<svg class="dv-icon" aria-hidden="true"><use href="#i-x"/></svg>';
  cells.append(remove);
  row.textContent = '';
  row.append(cells);
  return cells;
}
/** Fill a recycled row element with the record at index; a focused input keeps what is being typed into it. */
function renderRow(row, index) {
  const cells = row.firstElementChild?.classList.contains('dv-row-cells') ? row.firstElementChild : cellsFor(row);
  const moved = row.dataset.index !== String(index);
  row.dataset.index = String(index);
  for (const input of cells.querySelectorAll('input')) {
    const value = rows[index][input.dataset.field];
    if (moved || document.activeElement !== input) input.value = value == null ? '' : String(value);
    input.setAttribute('aria-label', `${input.dataset.field} of row ${index + 1}`);
  }
  cells.querySelector('.dv-remove').setAttribute('aria-label', `Remove row ${index + 1}`);
}
function showRows() {
  df$.shadcn.virtualList.setData(list, rows.length, renderRow);
  $('ex-row-count').textContent = number.format(rows.length);
}
const indexOf = (el) => Number(el.closest('[data-index]').dataset.index);

function markStale() {
  stale.textContent = 'Edited: press Apply to run the query again.';
}
list.addEventListener('input', (event) => {
  const input = event.target.closest('input[data-field]');
  if (!input) return;
  const field = input.dataset.field;
  rows[indexOf(input)][field] = TEXT_FIELDS.has(field) ? input.value : valueOf(input.value);
  markStale();
});
list.addEventListener('click', (event) => {
  const remove = event.target.closest('.dv-remove');
  if (!remove) return;
  rows.splice(indexOf(remove), 1);
  showRows();
  markStale();
});
$('ex-demo-rows').addEventListener('click', () => { rows = units(DEMO_ROWS); showRows(); markStale(); });
$('ex-random-rows').addEventListener('click', () => { rows = units(DEMO_ROWS, Math.floor(Math.random() * 2 ** 31)); showRows(); markStale(); });
$('ex-add-row').addEventListener('click', () => {
  const ids = rows.map((row) => row.id).filter((id) => typeof id === 'number');
  rows.push({ id: ids.length ? Math.max(...ids) + 1 : 1, parentId: null, name: `Unit ${rows.length + 1}`, region: 'EU', score: 50 });
  showRows();
  list.scrollTop = list.scrollHeight;
  markStale();
  // the new row renders on the list's next frame
  requestAnimationFrame(() => requestAnimationFrame(() => list.querySelector(`[data-index="${rows.length - 1}"] input[data-field="name"]`)?.focus()));
});

// ---- the request editor: a transparent textarea over the Code Example block's own highlighted lines -------------------
// Keeping the textarea native keeps typing, selection, undo and accessibility the browser's; the <pre> behind it only
// paints. The token colours are the block's keyword / string classes; numbers and literals take the dv-json-literal hue.
// A contenteditable editor would have to restore the caret after every repaint; a code-editor library would be the
// page's only dependency besides defuss-shadcn.
// VERIFIED: with the textarea text tinted red, it covered the painted lines exactly in Chromium (screenshot, 2026-10-10).
function paintQuery() {
  highlight.replaceChildren(...jsonLines(query.value));
  syncScroll();
}
function syncScroll() {
  highlight.parentElement.scrollTop = query.scrollTop;
  highlight.parentElement.scrollLeft = query.scrollLeft;
}
query.addEventListener('input', () => { paintQuery(); markStale(); });
query.addEventListener('scroll', syncScroll);
query.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void apply(); }
});
function setQuery(text) {
  query.value = text;
  paintQuery();
}
$('ex-format').addEventListener('click', () => {
  try { setQuery(JSON.stringify(JSON.parse(query.value), null, 2)); } catch (failure) { showError(failure, 'createDataview() threw'); }
});
$('ex-copy').addEventListener('click', () => void copyText(query.value, $('ex-copy-status')));

// ---- apply: evaluate, then show counts, entries and the normalized state ----------------------------------------------
const counts = $('ex-counts');
const error = $('ex-error');

function statistic(title, value) {
  const box = document.createElement('div');
  box.className = 'statistic';
  box.dataset.count = title;
  const label = document.createElement('p');
  label.className = 'statistic-title';
  label.textContent = title;
  const figure = document.createElement('p');
  figure.className = 'statistic-value';
  figure.textContent = String(value);
  box.append(label, figure);
  return box;
}
function showError(failure, title) {
  $('ex-error-title').textContent = failure instanceof SyntaxError ? 'The JSON does not parse' : title;
  $('ex-error-message').textContent = failure instanceof Error ? failure.message : String(failure);
  error.hidden = false;
}

const glyph = (record) => (record.hasChildren ? (record.isExpanded ? '▾ ' : '▸ ') : '');
const cells = {
  name(el, record) {
    el.textContent = `${glyph(record)}${record.name ?? ''}`;
    el.style.paddingInlineStart = `${record.depth * 1.25}rem`;
  },
  ...Object.fromEntries(['hasChildren', 'isExpanded', 'isMatch', 'isSelected'].map((field) => [field, (el, record) => {
    el.textContent = String(record[field]);
    el.dataset.kind = String(record[field]);
  }])),
  parentId(el, record) { el.textContent = JSON.stringify(record.parentId); },
};

// A request with exactly one of these keys is a compute plan: { "aggregate" | "rows" | "view": descriptor, "page"? }.
// Plans are plain expression nodes ({ "v": 1, "op": ... }), which forRows() accepts as they are and validates once.
// The compute bundle loads on the first plan, so a failure there leaves descriptor queries working.
const PLAN_KINDS = ['aggregate', 'rows', 'view'];
const planKind = (request) => {
  const kinds = PLAN_KINDS.filter((kind) => request !== null && typeof request === 'object' && Object.hasOwn(request, kind));
  if (kinds.length > 1) throw new TypeError(`A plan names one kind; this request names ${kinds.join(' and ')}.`);
  return kinds[0];
};
let computeModule;
const loadCompute = () => (computeModule ??= import('defuss-dataview/compute'));
const decimal = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const cellText = (value) => (typeof value === 'number' ? decimal.format(value) : typeof value === 'bigint' ? `${value}n` : value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value));

function clearResult() {
  counts.replaceChildren();
  df$.shadcn.dataGrid.setSource(grid, [], { cells });
  $('ex-pages').hidden = true;
  $('ex-state').replaceChildren();
  $('ex-compute').hidden = true;
  $('ex-totals').hidden = true;
  stale.textContent = '';
}
function showMode(compute, kind) {
  grid.style.display = compute ? 'none' : '';
  $('ex-compute').hidden = !compute;
  $('ex-state-label').innerHTML = compute ? '<code>plan.explain()</code> and the summary' : 'Normalized state from <code>createDataview()</code>';
  $('ex-state-file').textContent = compute ? `plan = forRows().${kind}(request.${kind})` : 'view = createDataview(request)';
}

let applied = 0;
async function apply() {
  const current = ++applied;
  let request, kind;
  try {
    request = JSON.parse(query.value || '{}');
    kind = planKind(request);
  } catch (failure) {
    showError(failure, 'createDataview() threw');
    clearResult();
    return;
  }
  if (kind) return applyPlan(request, kind, current);
  let view, result;
  try {
    view = createDataview(request);
    result = evaluateDataview(rows, view);
  } catch (failure) {
    showError(failure, 'createDataview() threw');
    clearResult();
    return;
  }
  error.hidden = true;
  stale.textContent = '';
  showMode(false);
  $('ex-totals').hidden = true;
  counts.replaceChildren(
    statistic('totalRows', result.totalRows), statistic('matchedRows', result.matchedRows), statistic('visibleRows', result.visibleRows),
    statistic('pageCount', result.pageCount), statistic('hasPreviousPage', result.hasPreviousPage), statistic('hasNextPage', result.hasNextPage));
  // The grid shows the entries in the order evaluateDataview() returned them: its own sorting is off (data-sortable).
  // VERIFIED: tests/e2e/docs.spec.ts reads the grid's rows back in that order, depth and flags included.
  const records = result.entries.map(({ row, meta }, key) => ({ key, name: row.name, id: row.id, score: row.score, ...meta }));
  grid.style.setProperty('--dv-result-rows', String(Math.min(Math.max(records.length, 3), 12)));
  df$.shadcn.dataGrid.setSource(grid, records, { cells });
  showPages(view.pageSize, view.page, result.pageCount, 'page');
  $('ex-state').replaceChildren(...jsonLines(JSON.stringify(view, null, 2)));
}

async function applyPlan(request, kind, current) {
  let plan, result;
  const extra = Object.keys(request).filter((key) => key !== kind && key !== 'page');
  try {
    if (extra.length) throw new TypeError(`A plan request takes "${kind}" and "page"; remove ${extra.map((key) => `"${key}"`).join(', ')}.`);
    const { forRows, createImmutableArraySource } = await loadCompute();
    plan = forRows()[kind](request[kind]);
    result = await plan.evaluate(createImmutableArraySource(rows), request.page ?? {}, { count: 'exact' });
  } catch (failure) {
    if (current !== applied) return;
    showError(failure, `forRows().${kind}() threw`);
    clearResult();
    return;
  }
  if (current !== applied) return;
  const { summary } = result;
  error.hidden = true;
  stale.textContent = '';
  showMode(true, kind);
  counts.replaceChildren(
    statistic('strategy', summary.strategy), statistic('scannedRows', summary.scannedRows),
    statistic('observedInputMatches', summary.observedInputMatches), statistic('totalResultRows', summary.totalResultRows ?? 'unknown'),
    statistic('returnedRows', summary.returnedRows), statistic('hasMore', summary.hasMore));
  const columns = [...new Set(result.rows.flatMap((row) => Object.keys(row)))];
  $('ex-compute-head').replaceChildren(...columns.map((name) => {
    const th = document.createElement('th');
    th.className = 'table-head';
    th.textContent = name;
    if (result.rows.some((row) => typeof row[name] === 'number')) th.dataset.numeric = '';
    return th;
  }));
  $('ex-compute-body').replaceChildren(...result.rows.map((row) => {
    const tr = document.createElement('tr');
    tr.className = 'table-row';
    tr.append(...columns.map((name) => {
      const td = document.createElement('td');
      td.className = 'table-cell';
      td.textContent = cellText(row[name]);
      if (typeof row[name] === 'number') td.dataset.numeric = '';
      return td;
    }));
    return tr;
  }));
  const totals = $('ex-totals');
  totals.hidden = !result.totals;
  totals.replaceChildren(...Object.entries(result.totals ?? {}).map(([name, value]) => statistic(`totals.${name}`, cellText(value))));
  const { offset = 0, limit } = request.page ?? {};
  showPages(limit, Math.floor(offset / (limit || 1)), summary.totalResultRows === null ? 0 : Math.ceil(summary.totalResultRows / limit), 'offset');
  $('ex-state').replaceChildren(...jsonLines(JSON.stringify({ explain: plan.explain(), summary }, (_, value) => (typeof value === 'bigint' ? String(value) : value), 2)));
}
$('ex-apply').addEventListener('click', () => void apply());

// ---- pages: the pager shows the result's page state and writes a picked page back into the request -----------------
// A descriptor pages with "page" and "pageSize"; a plan with "page": { "offset", "limit" }.
const pager = $('ex-pager');
let pagedBy = 'page';
function showPages(size, index, pageCount, by) {
  pagedBy = by;
  $('ex-pages').hidden = !size;
  if (!size) return;
  const last = Math.max(pageCount, 1);
  pager.api.setState('default', { minPage: 1, maxPage: last, activePage: Math.min(index + 1, last) });
  const at = by === 'page' ? `"page": ${index}` : `"offset": ${number.format(index * size)}`;
  $('ex-page-note').textContent = index < pageCount
    ? `${at} is page ${number.format(index + 1)} of ${number.format(pageCount)}, ${size} ${by === 'page' ? 'entries' : 'rows'} each`
    : `${at} is past the last page (${number.format(pageCount)})`;
}
pager.addEventListener('pagination-change', (event) => {
  try {
    const request = JSON.parse(query.value || '{}');
    if (pagedBy === 'page') request.page = event.detail.page - 1;
    else request.page = { ...request.page, offset: (event.detail.page - 1) * request.page.limit };
    setQuery(JSON.stringify(request, null, 2));
  } catch (failure) {
    showError(failure, 'createDataview() threw');
    return;
  }
  void apply();
});

for (const button of document.querySelectorAll('.dv-examples [data-descriptor]')) {
  button.addEventListener('click', () => {
    if (button.dataset.rows === 'cycle') { rows = CYCLE.map((row) => ({ ...row })); showRows(); } // the only example with its own rows
    setQuery(JSON.stringify(JSON.parse(button.dataset.descriptor), null, 2));
    void apply();
  });
}
showRows();
document.querySelector('.dv-examples [data-descriptor]').click();

// ---- measurements: assets/metrics.json (make site-metrics) fills the stats, the charts and the table ---------------
// The Chart component draws with ECharts, about 370 kB gzip, so it loads only when the section nears the viewport.
// Series colours: the theme's own blue, then the dataviz reference orange, stepped per mode (site.css). The pair passed
// the dataviz palette validator in light and dark (adjacent and all pairs, colour-blind and normal vision).
const ECHARTS = { src: 'https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js', integrity: 'sha384-C2iskrW/uPW46KzOjrvJIQo4YkV8lkD+QS0CrDN18IIPIpT/g2USu8bTP3nvmIAD' };
const SERIES = ['var(--dv-series-1)', 'var(--dv-series-2)'];
const ms = (value) => (value < 1 ? `${value.toFixed(2)} ms` : value < 10 ? `${value.toFixed(1)} ms` : `${number.format(Math.round(value))} ms`);
const compact = (value) => (value >= 1e6 ? `${value / 1e6}M` : value >= 1e3 ? `${value / 1e3}K` : String(value));
const metrics = fetch('assets/metrics.json').then((response) => {
  if (!response.ok) throw new Error(`assets/metrics.json answered ${response.status}`);
  return response.json();
});

function showMetrics(m) {
  const stat = (id, value, label) => {
    $(id).querySelector('.mk-stat-value').textContent = value;
    $(id).querySelector('.mk-stat-label').textContent = label;
  };
  const { unit, browser } = m.tests;
  const failing = unit.total - unit.passed + browser.total - browser.passed;
  stat('stat-coverage', `${m.coverage.lines}%`, `of source lines covered by the unit tests; ${m.coverage.branches}% of branches, ${m.coverage.functions}% of functions`);
  stat('stat-tests', number.format(unit.passed + browser.passed), `tests passing: ${unit.passed} unit/integration tests and ${browser.passed} in Chromium${failing ? `; ${failing} failing` : ''}`);
  $('metrics-source').textContent = `${m.environment.cpu}, Node ${m.environment.node}, ${m.environment.platform}, ${m.measuredAt.slice(0, 10)}, commit ${m.commit}.`;

  const shapes = { lists: 'List', depth: 'Chain tree', size: 'Balanced tree' };
  const cellOf = (text) => { const td = document.createElement('td'); td.className = 'table-cell'; td.textContent = text; return td; };
  $('perf-table').replaceChildren(...Object.entries(m.benchmarks).flatMap(([group, rows]) => rows.map((row) => {
    const tr = document.createElement('tr');
    tr.className = 'table-row';
    tr.append(cellOf(shapes[group]), cellOf(row.scenario), cellOf(number.format(row.rows)), cellOf(row.depth === undefined ? '–' : number.format(row.depth)),
      cellOf(ms(row.medianMs)), cellOf(ms(row.minMs)), cellOf(String(row.runs)));
    return tr;
  })));

  const at = (group, scenario, rows) => m.benchmarks[group].find((row) => row.scenario === scenario && row.rows === rows)?.medianMs;
  const biggestList = Math.max(...m.benchmarks.lists.map((row) => row.rows));
  const chain = m.benchmarks.depth.filter((row) => row.scenario === 'all open + page').at(-1);
  const balanced = m.benchmarks.size.find((row) => row.scenario === 'all open + page' && row.rows === chain.depth);
  $('perf-lists-dek').textContent = `${number.format(biggestList)} rows: ${ms(at('lists', 'filter + page', biggestList))} to filter and page, ${ms(at('lists', 'filter + sort + page', biggestList))} with a two-key sort.`;
  $('perf-depth-dek').textContent = `A chain ${number.format(chain.depth)} levels deep: ${ms(chain.medianMs)}.${balanced ? ` A balanced tree of ${number.format(balanced.rows)} nodes, four children each: ${ms(balanced.medianMs)}.` : ''}`;
}

function lineChart(el, xName, [min, max], series) {
  df$.shadcn.chart.mount(el, {
    aria: { enabled: true },
    grid: { left: 64, right: 76, top: 44, bottom: 56 },
    // line keys for line series; no border, or the markers' surface ring would paint over the thin key
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 18, itemHeight: 4, itemStyle: { borderWidth: 0 } },
    tooltip: { trigger: 'axis', valueFormatter: (value) => ms(value) },
    xAxis: { type: 'log', logBase: 10, min, max, name: xName, nameLocation: 'middle', nameGap: 32, axisLabel: { formatter: compact }, splitLine: { show: false } },
    yAxis: { type: 'log', logBase: 10, axisLabel: { formatter: (value) => `${value < 1 ? String(value) : number.format(value)} ms` } },
    series: series.map(({ name, points, endLabel = true }, index) => ({
      id: name, name, type: 'line', data: points, symbol: 'circle', symbolSize: 8,
      lineStyle: { width: 2, color: SERIES[index] }, itemStyle: { color: SERIES[index], borderColor: 'var(--background)', borderWidth: 2 },
      endLabel: { show: endLabel, formatter: ({ value }) => ms(value[1]), color: 'var(--muted-foreground)' },
    })),
  });
}
function drawCharts(m) {
  const points = (group, scenario) => m.benchmarks[group].filter((row) => row.scenario === scenario).map((row) => [row.rows, row.medianMs]);
  lineChart($('perf-lists'), 'rows', [1e3, 1e6], [
    { name: 'filter + page', points: points('lists', 'filter + page') },
    { name: 'filter + sort + page', points: points('lists', 'filter + sort + page') },
  ]);
  lineChart($('perf-depth'), 'nodes', [10, 1e6], [
    // its end sits on the balanced line: the caption carries that value instead of a colliding label
    { name: 'chain, depth = nodes − 1', points: points('depth', 'all open + page'), endLabel: false },
    { name: 'balanced, 4 children per node', points: points('size', 'all open + page') },
  ]);
}

// One script element for both chart sections, whichever nears the viewport first.
let echartsLoad;
const loadEcharts = () => echartsLoad ??= new Promise((resolve, reject) => {
  const script = document.createElement('script');
  Object.assign(script, { src: ECHARTS.src, integrity: ECHARTS.integrity, crossOrigin: 'anonymous', onload: resolve });
  script.onerror = () => reject(new Error('ECharts did not load'));
  document.head.append(script);
});
void metrics.then(showMetrics);
new IntersectionObserver((records, observer) => {
  if (!records.some((record) => record.isIntersecting)) return;
  observer.disconnect();
  void Promise.all([loadEcharts(), metrics]).then(([, m]) => drawCharts(m));
}, { rootMargin: '600px 0px' }).observe($('perf'));

// ---- MongoDB comparison: assets/mongodb.json (bun run benchmark:mongodb) fills the figures, gauges, charts and table ---
// Like-for-like pairings, each [dataview engine, MongoDB engine]; the gauges and verdicts show MongoDB time / dataview time.
// VERIFIED: the docs e2e test derives the pairing counts and gauge values from mongodb.json and toggles both switches.
const PAIRINGS = {
  scan: { label: 'No index', dataview: 'dataview + immutable array', mongodb: 'MongoDB' },
  index: { label: 'Indexed', dataview: 'dataview fixed-query index', mongodb: 'MongoDB + index' },
  // Every figure is a repeated query after a warm-up. On defuss-dbsonl that means a projection of the queried fields,
  // kept by one full scan of the revision; the full scan itself is listed with the other preparation steps.
  stored: { label: 'Stored on disk', dataview: 'dataview + DBSONL file, same revision', mongodb: 'MongoDB' },
};
const FULL_SCAN = 'dataview + DBSONL file';
// After a write the projection is gone: eight worker threads, each scanning one key range of the file, answer instead.
const AFTER_WRITE = 'dataview + DBSONL file, 8 workers';
const QUERIES = { top: 'Filter, sort, count', page: 'First page by key' };
const comparison = fetch('assets/mongodb.json').then((response) => {
  if (!response.ok) throw new Error(`assets/mongodb.json answered ${response.status}`);
  return response.json();
});
const duration = (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)} s` : value < 1 ? `${value.toFixed(2)} ms` : value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`);
const times = (value) => `${value < 10 ? value.toFixed(1) : number.format(Math.round(value))}×`;
const verdict = (ratio) => (ratio >= 1 ? `${times(ratio)} faster` : `${times(1 / ratio)} slower`);
const docs = (rows) => number.format(Number(rows));

function pairings(data) {
  return Object.entries(data.sizes).flatMap(([rows, run]) => {
    const median = (query, engine) => run.results.find((result) => result.query === query && result.engine === engine)?.medianMs;
    return Object.keys(QUERIES).flatMap((query) => Object.entries(PAIRINGS).map(([pairing, { dataview, mongodb }]) => {
      const ours = median(query, dataview), theirs = median(query, mongodb);
      return { rows, query, pairing, ours, theirs, ratio: theirs / ours };
    }));
  });
}

function showComparison(data) {
  const all = pairings(data), wins = all.filter((p) => p.ratio >= 1);
  const largest = Object.keys(data.sizes).map(Number).sort((a, b) => b - a)[0];
  const pick = (query, pairing, rows = largest) => all.find((p) => p.query === query && p.pairing === pairing && Number(p.rows) === rows);
  const index = pick('top', 'index'), scan = pick('top', 'scan');
  $('vs-hit-wins').textContent = `${wins.length} of ${all.length}`;
  $('vs-hit-index').textContent = times(index.ratio);
  $('vs-hit-index-text').textContent = `faster with a fixed-query index than MongoDB with its index over ${docs(largest)} documents: ${duration(index.ours)} against ${duration(index.theirs)} for a filtered, sorted page with an exact count`;
  $('vs-hit-scan').textContent = times(scan.ratio);
  $('vs-hit-scan-text').textContent = `faster scanning ${docs(largest)} documents in memory than MongoDB without an index: ${duration(scan.ours)} against ${duration(scan.theirs)}`;
  const stored = pick('top', 'stored');
  $('vs-hit-stored').textContent = times(stored.ratio);
  $('vs-hit-stored-text').textContent = `faster stored on disk: defuss-dataview over a defuss-dbsonl file of ${docs(largest)} documents against MongoDB: ${duration(stored.ours)} against ${duration(stored.theirs)}`;
  const median = (rows, query, engine) => data.sizes[rows].results.find((r) => r.query === query && r.engine === engine)?.medianMs;
  const fullScan = median(largest, 'top', FULL_SCAN);
  if (fullScan !== undefined) $('vs-full-scan').textContent = times(fullScan / stored.ours);
  const env = data.sizes[largest].environment;
  $('vs-source').textContent = `Medians of 7 alternating runs with bun run benchmark:mongodb on an ${env.cpu}, Node.js ${env.node}, MongoDB ${env.mongodb} (${env.storageEngine}), ${data.sizes[largest].measuredAt.slice(0, 10)}.`;

  const listed = new Set([...Object.values(PAIRINGS).flatMap((p) => [p.dataview, p.mongodb]), FULL_SCAN, AFTER_WRITE]);
  const engines = [...new Set(Object.values(data.sizes).flatMap((run) => run.results.map((r) => r.engine)))].filter((engine) => listed.has(engine));
  const sizes = Object.keys(data.sizes).sort((a, b) => a - b);
  const afterWrite = sizes.filter((rows) => median(rows, 'top', AFTER_WRITE) !== undefined)
    .map((rows) => `${duration(median(rows, 'top', AFTER_WRITE))} against ${duration(median(rows, 'top', 'MongoDB'))} over ${docs(rows)} documents`);
  if (afterWrite.length) $('vs-after-write').textContent = afterWrite.join(', and ');
  const cell = (text, header) => { const el = document.createElement(header ? 'th' : 'td'); el.className = 'table-cell'; if (header) el.scope = 'row'; el.textContent = text; return el; };
  $('vs-table').replaceChildren(...engines.map((engine) => {
    const tr = document.createElement('tr');
    tr.className = 'table-row';
    tr.append(cell(engine, true), ...Object.keys(QUERIES).flatMap((query) => sizes.map((rows) => {
      const value = data.sizes[rows].results.find((r) => r.query === query && r.engine === engine)?.medianMs;
      return cell(value === undefined ? '–' : duration(value));
    })));
    return tr;
  }));
  $('vs-prepare').textContent = sizes.map((rows) => {
    const { loads, builds } = data.sizes[rows];
    return `${docs(rows)} documents: ${[...loads.map((l) => `load ${l.engine} ${duration(l.ms)}`), ...builds.map((b) => `dataview ${b.index} ${duration(b.ms)}`)].join(', ')}`;
  }).join('. ') + '.';

  const ui = window.df$?.shadcn;
  if (!ui?.tacho) return all;
  const tick = (power) => (power < 0 ? `1/${2 ** -power}×` : `${2 ** power}×`);
  // The gauges show log2(MongoDB time / dataview time): 0 is a tie, and every labelled step is four times the last.
  // The meter clamps a ratio beyond its scale to the end stop; the readout then says so instead of naming the stop.
  ui.tacho.format('vs-mongodb', (value, context) => (context.tick ? tick(Math.round(value))
    : value >= context.max ? `over ${times(2 ** context.max)} faster` : value <= context.min ? `over ${times(2 ** -context.min)} slower` : verdict(2 ** value)));
  const choice = { size: String(largest), query: 'top' };
  const show = () => {
    for (const pairing of Object.keys(PAIRINGS)) {
      const p = pick(choice.query, pairing, Number(choice.size));
      ui.tacho.value(`#vs-${pairing}`, Math.log2(p.ratio));
      $(`vs-${pairing}-times`).textContent = `${duration(p.ours)} against ${duration(p.theirs)}`;
    }
  };
  // A document listener runs after the toggle group's own, so exactly one button of each group stays pressed.
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('.dv-vs-controls .toggle');
    if (!button) return;
    const group = button.closest('.toggle-group');
    for (const toggle of group.querySelectorAll('.toggle')) toggle.setAttribute('aria-pressed', String(toggle === button));
    choice[group.dataset.key] = button.dataset.value;
    show();
  });
  show();
  return all;
}

function dumbbell(el, all, query) {
  const rows = all.filter((p) => p.query === query).sort((a, b) => Object.keys(PAIRINGS).indexOf(a.pairing) - Object.keys(PAIRINGS).indexOf(b.pairing) || a.rows - b.rows)
    .map((p) => ({ ...p, label: `{w|${PAIRINGS[p.pairing].label}}\n{r|${docs(p.rows)} documents}`, title: `${PAIRINGS[p.pairing].label}, ${docs(p.rows)} documents` }));
  const scale = (value) => (value >= 1000 ? `${value / 1000} s` : `${value} ms`);
  // ECharts writes a generated description over the container's aria-label; it gets the authored one instead.
  const description = el.getAttribute('aria-label');
  df$.shadcn.chart.mount(el, {
    baseOption: {
      aria: { enabled: true, label: { description } },
      legend: { right: 0, data: ['defuss-dataview', 'MongoDB'] },
      grid: { left: 16, right: 96, top: 40, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (items) => { const row = rows[items[0].dataIndex]; return `<strong>${row.title}</strong><br>defuss-dataview: ${duration(row.ours)}<br>MongoDB: ${duration(row.theirs)}<br>${verdict(row.ratio)}`; },
      },
      xAxis: { type: 'log', min: 0.01, max: 10000, axisLabel: { formatter: scale } },
      yAxis: {
        type: 'category', inverse: true, data: rows.map((row) => row.label), axisLine: { show: false },
        axisLabel: { lineHeight: 17, rich: { w: { color: 'var(--foreground)', fontWeight: 600, fontSize: 13 }, r: { color: 'var(--muted-foreground)', fontSize: 12 } } },
      },
      series: [
        {
          // The connector: a line between the two engines, green where dataview took less time.
          type: 'custom', silent: true, tooltip: { show: false }, encode: { x: [0, 1], y: 2 },
          data: rows.map((row, index) => [Math.min(row.ours, row.theirs), Math.max(row.ours, row.theirs), index, row.ratio >= 1 ? 1 : 0]),
          renderItem: (_params, api) => {
            const [x1, y] = api.coord([api.value(0), api.value(2)]), [x2] = api.coord([api.value(1), api.value(2)]);
            return { type: 'line', shape: { x1, y1: y, x2, y2: y }, style: { stroke: df$.shadcn.chart.color(el, api.value(3) ? '--dv-ok' : '--dv-fail', 0.5), lineWidth: 5, lineCap: 'round' } };
          },
        },
        { name: 'MongoDB', type: 'scatter', symbolSize: 14, z: 3, data: rows.map((row) => row.theirs), itemStyle: { opacity: 1, color: 'var(--card)', borderColor: 'var(--muted-foreground)', borderWidth: 2.5 } },
        { name: 'defuss-dataview', type: 'scatter', symbolSize: 14, z: 4, data: rows.map((row) => row.ours), itemStyle: { opacity: 1, color: 'var(--primary)' } },
        {
          // The verdict, right of whichever engine took longer.
          type: 'scatter', symbolSize: 0, silent: true, tooltip: { show: false },
          label: { show: true, position: 'right', distance: 12, fontWeight: 700, formatter: ({ dataIndex }) => verdict(rows[dataIndex].ratio) },
          data: rows.map((row) => ({ value: Math.max(row.ours, row.theirs), label: { color: row.ratio >= 1 ? 'var(--dv-ok)' : 'var(--dv-fail)' } })),
        },
      ],
    },
    // A phone-width chart labels two decades four apart and uses smaller verdicts, so the plot keeps its width.
    media: [{
      query: { maxWidth: 440 },
      option: {
        grid: { right: 76 },
        xAxis: { axisLabel: { formatter: (value) => ([0.01, 100].includes(value) ? scale(value) : '') } },
        series: [{}, {}, {}, { label: { fontSize: 11, distance: 8 } }],
      },
    }],
  });
}

const compared = comparison.then(showComparison);
new IntersectionObserver((records, observer) => {
  if (!records.some((record) => record.isIntersecting)) return;
  observer.disconnect();
  void Promise.all([loadEcharts(), compared]).then(([, all]) => {
    dumbbell($('vs-chart-top'), all, 'top');
    dumbbell($('vs-chart-page'), all, 'page');
  });
}, { rootMargin: '600px 0px' }).observe($('mongodb'));
