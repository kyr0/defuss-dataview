import { idKey, sameIds, uniqueIds } from './identity.js';
import { normalizeMeta } from './normalize.js';
import type { DataviewJsonValue, DataviewMeta, DataviewState } from './types.js';

export function updateMeta<T extends DataviewState>(view: T, updates: Partial<DataviewMeta>): T {
  const normalized = normalizeMeta({ ...view.meta, ...updates });
  const selectedSame = sameIds(view.meta.selectedRowIds, normalized.selectedRowIds);
  const lockedSame = view.meta.lockedColumns.length === normalized.lockedColumns.length
    && view.meta.lockedColumns.every((column, index) => column === normalized.lockedColumns[index]);
  if (selectedSame && lockedSame) return view;
  return { ...view, meta: {
    ...view.meta,
    selectedRowIds: selectedSame ? view.meta.selectedRowIds : normalized.selectedRowIds,
    lockedColumns: lockedSame ? view.meta.lockedColumns : normalized.lockedColumns,
  } };
}
export const setSelectedRows = <T extends DataviewState>(view: T, selectedRowIds: DataviewJsonValue[]): T => updateMeta(view, { selectedRowIds });
export const setLockedColumns = <T extends DataviewState>(view: T, lockedColumns: string[]): T => updateMeta(view, { lockedColumns });
function toggle(ids: readonly DataviewJsonValue[], id: DataviewJsonValue): DataviewJsonValue[] {
  const key = idKey(id);
  return ids.some(value => idKey(value) === key) ? ids.filter(value => idKey(value) !== key) : [...ids, id];
}
export const toggleSelectedRow = <T extends DataviewState>(view: T, id: DataviewJsonValue): T => setSelectedRows(view, toggle(view.meta.selectedRowIds, id));
export function setExpandedIds<T extends DataviewState>(view: T, ids: DataviewJsonValue[]): T {
  if (!view.tree) return view;
  const expandedIds = uniqueIds(ids);
  if (view.tree.expandAll === false && !view.tree.collapsedIds?.length && sameIds(view.tree.expandedIds, expandedIds)) return view;
  return { ...view, tree: { ...view.tree, expandedIds, expandAll: false, collapsedIds: [] } };
}
export function toggleExpanded<T extends DataviewState>(view: T, id: DataviewJsonValue): T {
  if (!view.tree) return view;
  if (view.tree.expandAll ?? view.tree.expandedIds.length === 0) {
    return { ...view, tree: { ...view.tree, expandAll: true, collapsedIds: uniqueIds(toggle(view.tree.collapsedIds ?? [], id)) } };
  }
  return setExpandedIds(view, toggle(view.tree.expandedIds, id));
}
