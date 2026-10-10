// The demo's search server: a module worker that answers the Autocomplete's requests with defuss-dataview itself.
// The component sends a dataview request ({ query, filters, sorters, page, pageSize }); this worker hands it to
// createDataview()/evaluateDataview() unchanged, apart from case: defuss-dataview's string operators are
// case-sensitive (README), so the worker matches a lower-cased copy of the name ("search") against a lower-cased query.
// A worker beats the Autocomplete's built-in local mode (rows: […]) here because the request crosses a boundary the way
// it would reach a server, so the page shows the exact request a backend receives.
// VERIFIED: a module worker can import the pinned jsDelivr build (CORS allows any origin; tmp probe, 2026-10-10).
// Module workers do not read the page's import map, so this import carries no integrity hash; the exact version pin
// is its only guard, and tests/unit/docs.test.ts keeps it equal to the page's pinned version.
import { createDataview, evaluateDataview } from 'https://cdn.jsdelivr.net/npm/defuss-dataview@0.4.0/dist/browser.min.mjs';
import { places } from './data.js';

const PLACES = 100_000;
const rows = places(PLACES);

onmessage = ({ data: { id, request } }) => {
  const started = performance.now();
  try {
    const filters = (request.filters ?? []).map((filter) => filter.field === 'search' && typeof filter.value === 'string'
      ? { ...filter, value: filter.value.toLowerCase() } : filter);
    const view = createDataview({ filters, sorters: request.sorters ?? [], page: request.page ?? 0, pageSize: request.pageSize ?? 20 });
    const result = evaluateDataview(rows, view);
    postMessage({
      id, rows: result.entries.map((entry) => entry.row), total: result.matchedRows, hasMore: result.hasNextPage,
      ms: performance.now() - started, totalRows: result.totalRows,
    });
  } catch (error) {
    postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
