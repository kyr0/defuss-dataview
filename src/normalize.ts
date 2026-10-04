import { fieldParts } from './fields.js';
import { uniqueIds } from './identity.js';
import type { DataviewFilterOperator, DataviewMeta, DataviewRequest, DataviewSortDirection, DataviewState } from './types.js';

const operators: readonly DataviewFilterOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'endsWith'];
const array = (value: unknown, name: string): unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`Dataview ${name} must be an array.`);
  return value;
};
export function normalizeMeta(meta: Partial<DataviewMeta> = {}): DataviewMeta {
  return {
    selectedRowIds: uniqueIds(Array.isArray(meta.selectedRowIds) ? meta.selectedRowIds : []),
    lockedColumns: Array.isArray(meta.lockedColumns)
      ? [...new Set(meta.lockedColumns.filter(column => typeof column === 'string' && column.length > 0))] : [],
  };
}
export function createDataview(request: DataviewRequest = {}): DataviewState {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new TypeError('Dataview request must be an object.');
  const filters = (request.filters === undefined ? [] : array(request.filters, 'filters') as NonNullable<DataviewRequest['filters']>).map(filter => {
    fieldParts(filter?.field);
    if (!operators.includes(filter.op)) throw new TypeError(`Dataview filter op '${String(filter.op)}' is not supported.`);
    // Preserve strict reference equality for eq/neq and array membership filters.
    return { field: filter.field, op: filter.op, value: filter.value };
  });
  const sorters = (request.sorters === undefined ? [] : array(request.sorters, 'sorters') as NonNullable<DataviewRequest['sorters']>).map(sorter => {
    fieldParts(sorter?.field);
    const raw = sorter.direction ?? sorter.dir ?? 'asc';
    if (typeof raw !== 'string' || !['asc', 'desc'].includes(raw.toLowerCase())) throw new TypeError(`Dataview sorter direction '${String(raw)}' is not supported.`);
    return { field: sorter.field, direction: raw.toLowerCase() as DataviewSortDirection };
  });
  const page = request.page ?? 0, pageSize = request.pageSize;
  if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('Dataview page must be a safe integer >= 0.');
  if (pageSize != null && (!Number.isSafeInteger(pageSize) || pageSize <= 0)) throw new RangeError('Dataview pageSize must be a safe integer > 0.');
  if (pageSize != null && !Number.isSafeInteger(page * pageSize)) throw new RangeError('Dataview page offset exceeds the safe integer range.');
  let tree: DataviewState['tree'];
  if (request.tree !== undefined) {
    const input = request.tree;
    if (typeof input !== 'object' || input === null) throw new TypeError('Dataview tree must be an object.');
    fieldParts(input.idField); fieldParts(input.parentIdField);
    if (input.maxDepth != null && (!Number.isSafeInteger(input.maxDepth) || input.maxDepth < 0)) throw new RangeError('Dataview tree maxDepth must be a safe integer >= 0.');
    for (const flag of ['includeAncestors', 'includeDescendantsOfMatch', 'expandAll'] as const) {
      if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new TypeError(`Dataview tree ${flag} must be boolean.`);
    }
    tree = {
      idField: input.idField, parentIdField: input.parentIdField,
      expandedIds: uniqueIds(input.expandedIds === undefined ? [] : array(input.expandedIds, 'expandedIds')),
      expandAll: input.expandAll ?? input.expandedIds === undefined,
      collapsedIds: uniqueIds(input.collapsedIds === undefined ? [] : array(input.collapsedIds, 'collapsedIds')),
      maxDepth: input.maxDepth,
      includeAncestors: input.includeAncestors ?? true,
      includeDescendantsOfMatch: input.includeDescendantsOfMatch ?? false,
    };
  }
  const idField = request.idField ?? tree?.idField ?? 'id';
  fieldParts(idField);
  return { filters, sorters, page, pageSize, idField, meta: normalizeMeta(request.meta), tree };
}
