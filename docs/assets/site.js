// The landing page script. index.html loads defuss-shadcn (df$) from jsDelivr first; this module wires the page and runs
// the query explorer on defuss-dataview, which the page's import map pins to the newest published release.
// VERIFIED: tests/e2e/docs.spec.ts fails while that pin differs from npm's latest version, and the browser refuses the
// module when its bytes do not match the integrity hash, so the explorer shows what `npm install` gets.
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
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); apply(); }
});
function setQuery(text) {
  query.value = text;
  paintQuery();
}
$('ex-format').addEventListener('click', () => {
  try { setQuery(JSON.stringify(JSON.parse(query.value), null, 2)); } catch (failure) { showError(failure); }
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
function showError(failure) {
  $('ex-error-title').textContent = failure instanceof SyntaxError ? 'The JSON does not parse' : 'createDataview() threw';
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

function apply() {
  let view, result;
  try {
    view = createDataview(JSON.parse(query.value || '{}'));
    result = evaluateDataview(rows, view);
  } catch (failure) {
    showError(failure);
    counts.replaceChildren();
    df$.shadcn.dataGrid.setSource(grid, [], { cells });
    $('ex-pages').hidden = true;
    $('ex-state').textContent = '';
    stale.textContent = '';
    return;
  }
  error.hidden = true;
  stale.textContent = '';
  counts.replaceChildren(
    statistic('totalRows', result.totalRows), statistic('matchedRows', result.matchedRows), statistic('visibleRows', result.visibleRows),
    statistic('pageCount', result.pageCount), statistic('hasPreviousPage', result.hasPreviousPage), statistic('hasNextPage', result.hasNextPage));
  // The grid shows the entries in the order evaluateDataview() returned them: its own sorting is off (data-sortable).
  // VERIFIED: tests/e2e/docs.spec.ts reads the grid's rows back in that order, depth and flags included.
  const records = result.entries.map(({ row, meta }, key) => ({ key, name: row.name, id: row.id, score: row.score, ...meta }));
  grid.style.setProperty('--dv-result-rows', String(Math.min(Math.max(records.length, 3), 12)));
  df$.shadcn.dataGrid.setSource(grid, records, { cells });
  showPages(view, result);
  $('ex-state').textContent = JSON.stringify(view, null, 2);
}
$('ex-apply').addEventListener('click', apply);

// ---- pages: the pager shows the result's page state and writes a picked page back into the request -----------------
const pager = $('ex-pager');
function showPages(view, result) {
  $('ex-pages').hidden = !view.pageSize;
  if (!view.pageSize) return;
  const last = Math.max(result.pageCount, 1);
  pager.api.setState('default', { minPage: 1, maxPage: last, activePage: Math.min(view.page + 1, last) });
  $('ex-page-note').textContent = view.page < result.pageCount
    ? `"page": ${view.page} is page ${number.format(view.page + 1)} of ${number.format(result.pageCount)}, ${view.pageSize} entries each`
    : `"page": ${view.page} is past the last page (${number.format(result.pageCount)})`;
}
pager.addEventListener('pagination-change', (event) => {
  try {
    const request = JSON.parse(query.value || '{}');
    request.page = event.detail.page - 1;
    setQuery(JSON.stringify(request, null, 2));
  } catch (failure) {
    showError(failure);
    return;
  }
  apply();
});

for (const button of document.querySelectorAll('.dv-examples [data-descriptor]')) {
  button.addEventListener('click', () => {
    if (button.dataset.rows === 'cycle') { rows = CYCLE.map((row) => ({ ...row })); showRows(); } // the only example with its own rows
    setQuery(JSON.stringify(JSON.parse(button.dataset.descriptor), null, 2));
    apply();
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
  const { unit, browser, original } = m.tests;
  const failing = unit.total - unit.passed + browser.total - browser.passed;
  stat('stat-coverage', `${m.coverage.lines}%`, `of source lines covered by the unit tests; ${m.coverage.branches}% of branches, ${m.coverage.functions}% of functions`);
  stat('stat-tests', number.format(unit.passed + browser.passed), `tests passing: ${unit.passed} unit tests, ${original} of them kept from the original package, and ${browser.passed} in Chromium${failing ? `; ${failing} failing` : ''}`);
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

const loadEcharts = () => new Promise((resolve, reject) => {
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
