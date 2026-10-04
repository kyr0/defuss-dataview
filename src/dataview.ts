import { compileAccessor } from './fields.js';
import { idKey, selectionKey } from './identity.js';
import { compileQuery } from './query.js';
import { evaluateTree } from './tree.js';
import type { DataviewEntry, DataviewResult, DataviewRow, DataviewState } from './types.js';
export { createDataview } from './normalize.js';

function evaluateFlat<T extends DataviewRow>(rows: readonly T[], view: DataviewState) {
  const query = compileQuery(view);
  const selected = new Set(view.meta.selectedRowIds.map(idKey));
  const getId = compileAccessor(view.idField);
  const offset = view.pageSize ? view.page * view.pageSize : 0;
  const end = view.pageSize ? offset + view.pageSize : Infinity;
  const entries: Array<DataviewEntry<T>> = [];
  let matchedRows = 0;
  function append(row: T) {
    if (matchedRows >= offset && matchedRows < end) {
      const key = selected.size ? selectionKey(getId(row)) : undefined;
      entries.push({ row, meta: {
        depth: 0, hasChildren: false, isExpanded: false, isMatch: true,
        isSelected: key !== undefined && selected.has(key), parentId: null,
      } });
    }
    matchedRows++;
  }
  if (view.sorters.length || !view.filters.length) {
    const ordered = view.filters.length ? rows.filter(query.matches) : view.sorters.length ? [...rows] : rows;
    if (view.sorters.length) (ordered as T[]).sort(query.compare);
    // Counts are already known; unfiltered/unsorted paging remains O(pageSize).
    matchedRows = offset;
    for (let index = offset; index < Math.min(end, ordered.length); index++) append(ordered[index]);
    matchedRows = ordered.length;
  } else {
    // Count without materializing all matches; allocate only the requested page.
    for (const row of rows) if (query.matches(row)) append(row);
  }
  return { entries, matchedRows, visibleRows: matchedRows };
}

/** Apply the query and return grid pagination counts alongside its entries. */
export function evaluateDataview<T extends DataviewRow>(rows: readonly T[], view: DataviewState): DataviewResult<T> {
  const result = view.tree ? evaluateTree(rows, view) : evaluateFlat(rows, view);
  const pageCount = view.pageSize ? Math.ceil(result.visibleRows / view.pageSize) : Number(result.visibleRows > 0);
  return {
    ...result, totalRows: rows.length, page: view.page, pageSize: view.pageSize, pageCount,
    hasPreviousPage: !!view.pageSize && view.page > 0 && pageCount > 0,
    hasNextPage: !!view.pageSize && view.page < pageCount - 1,
  };
}

/** Existing array-returning contract; row objects retain their original identity. */
export function applyDataview<T extends DataviewRow>(rows: readonly T[], view: DataviewState): Array<DataviewEntry<T>> {
  return evaluateDataview(rows, view).entries;
}
