// Ledger: one defuss-shadcn Big Data component per tab, each querying generated records through defuss-dataview
// (defuss-shadcn 0.9.8 bundles defuss-dataview 0.4.0), and an inspector that shows what the active component holds.
// The page reaches the components only through df$.shadcn.*, el.api, el.store and their CustomEvents.
// VERIFIED (Chromium probe, 2026-10-10): dataGrid.query() and setSource() apply synchronously, so timing the call
// times the query; with 1,000,000 rows setSource took 14 ms, a text filter 65 ms and a sort 691 ms.
// Each tab generates its records on first use rather than all at load: VERIFIED (Chromium probe): 1,000,000 orders add
// about 64 MB of heap, so a visitor who never opens a tab never pays for its data.
import { orders, files, taxonomy, logs } from './data.js';
import { jsonLines } from '../assets/json.js';

const $ = (id) => document.getElementById(id);
const { dataGrid, dataTree, virtualList, autocomplete, propertyGrid } = df$.shadcn;
const number = new Intl.NumberFormat('en');
const LATENCY_MS = Number($('latency').textContent);
const SIZES = { files: 50_000, taxonomy: 100_000, logs: 250_000, places: 100_000 };
const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// ---- inspector ------------------------------------------------------------------------------------------------------
const inspector = {
  stats: $('ins-stats'), presets: $('ins-presets'), query: $('ins-query'), record: $('ins-record'),
  ms: $('ins-ms'), what: $('ins-ms-what'), note: $('ins-query-note'),
};
const defaultNote = [...inspector.note.childNodes].map((node) => node.cloneNode(true));

function statistic(title, value) {
  const box = document.createElement('div');
  box.className = 'statistic';
  const label = document.createElement('p');
  label.className = 'statistic-title';
  label.textContent = title;
  const figure = document.createElement('p');
  figure.className = 'statistic-value';
  figure.textContent = typeof value === 'number' ? number.format(value) : value;
  box.append(label, figure);
  return box;
}

function report(what, ms) {
  inspector.ms.textContent = `${ms < 10 ? ms.toFixed(1) : number.format(Math.round(ms))} ms`;
  inspector.what.textContent = what;
}

/** Time a synchronous component call: the query runs inside it (see the header note). */
function measure(what, call) {
  const started = performance.now();
  call();
  report(what, performance.now() - started);
}

function showRecord(record) {
  propertyGrid.configure(inspector.record, { source: record ? { ...record } : {} });
}

let pending = 0;
function refresh() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    const tab = TABS[active];
    if (!tab.loaded) return;
    inspector.stats.replaceChildren(...tab.stats().map(([title, value]) => statistic(title, value)));
    inspector.query.replaceChildren(...jsonLines(JSON.stringify(tab.query(), null, 2)));
  });
}

function activateInspector(name) {
  const tab = TABS[name];
  $('ins-component').textContent = tab.component;
  $('ins-api').textContent = tab.api;
  if (tab.note) inspector.note.textContent = tab.note;
  else inspector.note.replaceChildren(...defaultNote.map((node) => node.cloneNode(true)));
  inspector.record.dataset.emptyText = tab.recordHint;
  inspector.presets.replaceChildren(...tab.presets.map(([label, what, call]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.dataset.variant = 'outline';
    button.dataset.size = 'xs';
    button.textContent = label;
    button.addEventListener('click', () => (what ? measure(what, call) : call()));
    return button;
  }));
  inspector.ms.textContent = '–';
  inspector.what.textContent = 'Use an example query or change the size.';
  showRecord(null);
  refresh();
}

// ---- Orders: Data Grid ----------------------------------------------------------------------------------------------
const ordersGrid = $('orders');
let orderCount = 100_000;

async function loadOrders(count) {
  orderCount = count;
  ordersGrid.api.setState('loading');
  await frame(); // let the skeleton paint before a long synchronous generation
  const started = performance.now();
  const rows = orders(count);
  const generated = performance.now() - started;
  measure(`dataGrid.setSource() with ${number.format(count)} orders (generated in ${number.format(Math.round(generated))} ms)`,
    () => dataGrid.setSource(ordersGrid, rows, { cells: { status: statusCell } }));
  refresh();
}

function statusCell(el, record) {
  const badge = document.createElement('span');
  badge.className = 'badge dv-status';
  badge.dataset.variant = record.status === 'Paid' ? 'secondary' : 'outline';
  badge.dataset.size = 'sm';
  badge.dataset.status = record.status.toLowerCase();
  badge.textContent = record.status;
  el.append(badge);
}

$('orders-size').addEventListener('click', (event) => {
  const toggle = event.target.closest('.toggle');
  if (toggle && Number(toggle.value) !== orderCount) void loadOrders(Number(toggle.value));
});
$('orders-paging').addEventListener('change', (event) => {
  // VERIFIED (probe): the grid reads data-paging on its next query, so the element is not rebuilt.
  ordersGrid.dataset.paging = event.target.value;
  measure(`dataGrid.query({ page: 0 }) with data-paging="${event.target.value}"`, () => dataGrid.query(ordersGrid, { page: 0 }));
});

// A row is a recycled element: read the record through rows()[data-index], as the Data Grid skill says.
function gridRecord(grid, event) {
  const row = event.target.closest('.data-grid-body .data-grid-row');
  return row && row.dataset.index !== undefined ? dataGrid.rows(grid)[Number(row.dataset.index)] : undefined;
}
for (const grid of [ordersGrid, $('files')]) {
  // capture: the grid handles Shift/Ctrl clicks (range and toggle selection) without letting them bubble
  grid.addEventListener('click', (event) => { const record = gridRecord(grid, event); if (record) showRecord(record); }, { capture: true });
  grid.addEventListener('data-grid-activate', (event) => showRecord(event.detail.record));
}

// ---- Files: tree grid -----------------------------------------------------------------------------------------------
const filesGrid = $('files');
$('files-expand').addEventListener('click', () => measure('dataGrid.expandAll()', () => dataGrid.expandAll(filesGrid)));
$('files-collapse').addEventListener('click', () => measure('dataGrid.collapseAll()', () => dataGrid.collapseAll(filesGrid)));

// ---- Taxonomy: Data Tree --------------------------------------------------------------------------------------------
const tree = $('taxonomy');
$('taxonomy-expand').addEventListener('click', () => measure('dataTree.expandAll()', () => dataTree.expandAll(tree)));
$('taxonomy-collapse').addEventListener('click', () => measure('dataTree.collapseAll()', () => dataTree.collapseAll(tree)));
tree.addEventListener('data-tree-select', (event) => { showRecord(event.detail.record); refresh(); });

// ---- Logs: Virtual List ---------------------------------------------------------------------------------------------
const list = $('logs');
let logRows = [];
function renderLog(row, record) {
  row.textContent = ''; // rows are recycled, never fresh
  row.dataset.id = String(record.id);
  const level = document.createElement('span');
  level.className = 'dv-level';
  level.dataset.level = record.level;
  level.textContent = record.level;
  const time = document.createElement('time');
  time.className = 'dv-time';
  time.dateTime = record.time;
  time.textContent = record.time.slice(11, 23);
  const message = document.createElement('span');
  message.className = 'dv-message';
  message.textContent = record.message;
  row.append(level, time, message);
}
list.addEventListener('click', (event) => {
  const row = event.target.closest('[data-id]');
  if (row) showRecord(logRows[Number(row.dataset.id) - 1]); // ids are 1..n in generation order
});

// ---- Search: Autocomplete over a worker -----------------------------------------------------------------------------
const place = $('place');
const worker = new Worker(new URL('./search.worker.js', import.meta.url), { type: 'module' });
const waiting = new Map();
let requestId = 0;
let lastRequest = null;
let lastAnswer = null;
worker.addEventListener('message', ({ data }) => {
  const settle = waiting.get(data.id);
  waiting.delete(data.id);
  settle?.(data);
});
worker.addEventListener('error', (event) => {
  for (const settle of waiting.values()) settle({ error: event.message || 'The search worker failed.' });
  waiting.clear();
});

/** The Autocomplete's loader: wait out the simulated latency, then ask the worker; an abort drops the answer.
 * HYPOTHESIS: without the latency the worker answers within a frame, so the loading state and the abort of a request in
 * flight would never show; falsified if the skeleton shows on a zero-latency run. */
function search(request, { signal }) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const abort = () => { clearTimeout(timer); waiting.delete(id); reject(signal.reason); };
    const timer = setTimeout(() => {
      waiting.set(id, (data) => {
        signal.removeEventListener('abort', abort);
        if (data.error) return reject(new Error(data.error));
        lastAnswer = data;
        report(`evaluateDataview() in the worker: page ${request.page}, ${number.format(data.total)} matches`, data.ms);
        resolve({ rows: data.rows, total: data.total, hasMore: data.hasMore });
        refresh();
      });
      worker.postMessage({ id, request });
    }, LATENCY_MS);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}
place.addEventListener('autocomplete-request', (event) => { lastRequest = event.detail.request; refresh(); });
place.addEventListener('autocomplete-select', (event) => { showRecord(event.detail.record); refresh(); });

// ---- tabs -----------------------------------------------------------------------------------------------------------
const TABS = {
  orders: {
    component: 'Data Grid', api: 'df$.shadcn.dataGrid', recordHint: 'Click a row.',
    load: () => loadOrders(orderCount),
    query: () => ordersGrid.api.getState().config,
    stats: () => [['Orders', orderCount], ['Shown', dataGrid.rows(ordersGrid).length], ['Selected', dataGrid.selected(ordersGrid).length]],
    presets: [
      ['Largest amounts', 'dataGrid.query() sorting by amount', () => dataGrid.query(ordersGrid, { sorters: [{ field: 'amount', direction: 'desc' }] })],
      ['Region, then amount', 'dataGrid.query() with a multisort', () => dataGrid.query(ordersGrid, { sorters: [{ field: 'region', direction: 'asc' }, { field: 'amount', direction: 'desc' }] })],
      ['EU over €1,000', 'dataGrid.query() with two filters', () => dataGrid.query(ordersGrid, { filters: [{ field: 'region', op: 'eq', value: 'EU' }, { field: 'amount', op: 'gt', value: 1000 }], page: 0 })],
      ['Lock customer', 'dataGrid.query() locking two columns', () => dataGrid.query(ordersGrid, { locked: ['id', 'customer'] })],
      ['Reset', 'dataGrid.query() back to the source order', () => dataGrid.query(ordersGrid, { filters: [], sorters: [], locked: ['id'], selected: [], page: 0 })],
    ],
  },
  files: {
    component: 'Data Grid (tree grid)', api: 'df$.shadcn.dataGrid', recordHint: 'Click a row.',
    load() {
      const rows = files(SIZES.files);
      measure(`dataGrid.setSource() with ${number.format(rows.length)} files and folders`, () => dataGrid.setSource(filesGrid, rows));
    },
    query: () => filesGrid.api.getState().config,
    stats: () => [['Nodes', SIZES.files], ['Shown', dataGrid.rows(filesGrid).length], ['Selected', dataGrid.selected(filesGrid).length]],
    presets: [
      ['Largest first', 'dataGrid.query() sorting siblings by size', () => dataGrid.query(filesGrid, { sorters: [{ field: 'size', direction: 'desc' }] })],
      ['Only .json', 'dataGrid.query() keeping the folders on the way', () => dataGrid.query(filesGrid, { filters: [{ field: 'name', op: 'contains', value: '.json' }] })],
      ['Reset', 'dataGrid.query() back to the source order', () => dataGrid.query(filesGrid, { filters: [], sorters: [], expanded: [], collapsed: [], selected: [] })],
    ],
  },
  taxonomy: {
    component: 'Data Tree', api: 'df$.shadcn.dataTree', recordHint: 'Select a node.',
    load() {
      const rows = taxonomy(SIZES.taxonomy);
      measure(`dataTree.setSource() with ${number.format(rows.length)} nodes`, () => dataTree.setSource(tree, rows));
    },
    query: () => tree.api.getState().config,
    stats: () => [['Nodes', SIZES.taxonomy], ['Selected', dataTree.selected(tree)?.name ?? '–']], // one record or null
    presets: [
      ['Filter “steel”', 'dataTree.query() with a filter', () => dataTree.query(tree, { filters: [{ field: 'name', op: 'contains', value: 'steel' }] })],
      ['Z to A', 'dataTree.query() sorting siblings', () => dataTree.query(tree, { sorters: [{ field: 'name', direction: 'desc' }] })],
      ['Reset', 'dataTree.query() back to the source order', () => dataTree.query(tree, { filters: [], sorters: [], expanded: [], collapsed: [] })],
    ],
  },
  logs: {
    component: 'Virtual List', api: 'df$.shadcn.virtualList', recordHint: 'Click a line.',
    load() {
      logRows = logs(SIZES.logs);
      measure(`virtualList.setSource() with ${number.format(logRows.length)} lines`, () => virtualList.setSource(list, logRows, { render: renderLog }));
    },
    query: () => list.api.getState().config,
    stats: () => [['Lines', SIZES.logs], ['Shown', virtualList.rows(list).length]],
    presets: [
      ['Errors only', 'virtualList.query() with a filter', () => virtualList.query(list, { filters: [{ field: 'level', op: 'eq', value: 'error' }] })],
      ['Slower than 1 s', 'virtualList.query() with a number filter', () => virtualList.query(list, { filters: [{ field: 'ms', op: 'gt', value: 1000 }] })],
      ['Slowest first', 'virtualList.query() sorting by duration', () => virtualList.query(list, { sorters: [{ field: 'ms', direction: 'desc' }] })],
      ['Reset', 'virtualList.query() back to time order', () => virtualList.query(list, { filters: [], sorters: [] })],
    ],
  },
  search: {
    component: 'Autocomplete', api: 'df$.shadcn.autocomplete', recordHint: 'Pick a place.',
    note: 'This is the request the Autocomplete sent. The worker runs it through createDataview() and evaluateDataview(); it lower-cases the query, because defuss-dataview\'s string operators are case-sensitive.',
    load() {
      autocomplete.configure(place, { label: (record) => `${record.name}, ${record.country}`, load: search });
    },
    query: () => lastRequest ?? {},
    stats: () => [['Places', SIZES.places], ['Loaded', autocomplete.records(place).length], ['Matches', lastAnswer?.total ?? 0]],
    presets: [
      ['Search “ber”', null, () => void autocomplete.search(place, 'ber')],
      ['Search “new lis”', null, () => void autocomplete.search(place, 'new lis')],
      ['Search “xyz”', null, () => void autocomplete.search(place, 'xyz')],
    ],
  },
};

for (const [name, tab] of Object.entries(TABS)) {
  const el = { orders: ordersGrid, files: filesGrid, taxonomy: tree, logs: list, search: place }[name];
  el.store.subscribe(() => { if (name === active) refresh(); });
  tab.loaded = false;
}

let active = 'orders';
function activate(name) {
  active = name;
  const tab = TABS[name];
  activateInspector(name);
  if (!tab.loaded) {
    tab.loaded = true;
    void tab.load();
  }
  refresh();
}
const tablist = $('dv-tablist');
new MutationObserver(() => {
  const name = tablist.querySelector('[aria-selected="true"]')?.id.slice('tab-'.length);
  if (name && name !== active) activate(name);
}).observe(tablist, { subtree: true, attributeFilter: ['aria-selected'] });

$('reload').addEventListener('click', () => location.reload());
// A narrow frame keeps the inspector folded to its title bar; its own tool opens it again.
if (matchMedia('(max-width: 48rem)').matches) $('inspector').api.setState('minimized');
activate('orders');
