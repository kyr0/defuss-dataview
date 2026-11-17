import { compileAccessor } from './fields.js';
import { idKey, rowIdKey, selectionKey } from './identity.js';
import { compileQuery } from './query.js';
import type { DataviewEntry, DataviewJsonValue, DataviewRow, DataviewState } from './types.js';

export function evaluateTree<T extends DataviewRow>(rows: readonly T[], view: DataviewState) {
  const tree = view.tree!;
  const getId = compileAccessor(tree.idField), getParent = compileAccessor(tree.parentIdField);
  const ids = rows.map(row => getId(row));
  // Finite numeric IDs get their canonical string only when expansion state needs it (keyAt); every other ID is
  // validated and encoded here, so invalid identifiers still throw before any traversal.
  const keys = ids.map(id => typeof id === 'number' && Number.isFinite(id) ? undefined : rowIdKey(id));
  const keyAt = (index: number) => keys[index] ?? (typeof ids[index] === 'number' ? JSON.stringify(ids[index]) : undefined);
  const parents = rows.map(row => getParent(row));
  // VERIFIED (paired benchmark, documentation/PERFORMANCE.md): finite numbers index by value. JSON.stringify is
  // injective on them except -0/0, which a Map's SameValueZero also joins, so this is the canonical string identity
  // without hashing a fresh string per row. Filling backwards keeps the first duplicate with one Map write per row
  // instead of has() + set().
  const byId = new Map<string, number>(), byNumber = new Map<number, number>();
  for (let index = rows.length - 1; index >= 0; index--) {
    const id = ids[index];
    if (typeof id === 'number') byNumber.set(id, index);
    else { const key = keys[index]; if (key !== undefined) byId.set(key, index); }
  }
  const parentIndex = new Int32Array(rows.length);
  for (let index = 0; index < rows.length; index++) {
    const value = parents[index];
    let parent = -1;
    if (typeof value === 'number' && Number.isFinite(value)) parent = byNumber.get(value) ?? -1;
    else {
      // rowIdKey still validates every other parent value, and throws for non-finite numbers.
      const key = rowIdKey(value);
      if (key !== undefined) parent = byId.get(key) ?? -1;
    }
    parentIndex[index] = parent === index ? -1 : parent;
  }
  // Break one edge per cycle in O(n); lowest input index becomes a root.
  const color = new Uint8Array(rows.length);
  for (let start = 0; start < rows.length; start++) {
    if (color[start] !== 0) continue;
    const trail: number[] = [];
    let current = start;
    while (current !== -1 && color[current] === 0) {
      color[current] = 1; trail.push(current); current = parentIndex[current];
    }
    if (current !== -1 && color[current] === 1) {
      let root = current;
      for (let node = parentIndex[current]; node !== current; node = parentIndex[node]) root = Math.min(root, node);
      parentIndex[root] = -1;
    }
    for (const node of trail) color[node] = 2;
  }
  // VERIFIED: map() builds the 1M-slot array in about 5 ms, Array.from({ length }) in about 19 ms (Node 26, 2026-11-16).
  const children: Array<number[] | undefined> = rows.map(() => undefined);
  const roots: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const parent = parentIndex[index];
    if (parent === -1) roots.push(index);
    else (children[parent] ??= []).push(index);
  }
  const query = compileQuery(view);
  if (view.sorters.length) {
    const compare = (left: number, right: number) => query.compare(rows[left], rows[right]) || left - right;
    roots.sort(compare);
    for (const group of children) if (group && group.length > 1) group.sort(compare);
  }
  const matched = new Uint8Array(rows.length);
  let matchedRows = 0;
  for (let index = 0; index < rows.length; index++) {
    if (query.matches(rows[index])) { matched[index] = 1; matchedRows++; }
  }
  const included = matched.slice();
  if (tree.includeAncestors) {
    const done = new Uint8Array(rows.length);
    for (let index = 0; index < rows.length; index++) {
      if (!matched[index]) continue;
      for (let parent = parentIndex[index]; parent !== -1 && !done[parent]; parent = parentIndex[parent]) {
        done[parent] = 1; included[parent] = 1;
      }
    }
  }
  if (tree.includeDescendantsOfMatch) {
    const done = new Uint8Array(rows.length);
    const stack: number[] = [];
    for (let index = 0; index < rows.length; index++) {
      if (!matched[index] || done[index]) continue;
      stack.push(index);
      while (stack.length) {
        const node = stack.pop()!;
        if (done[node]) continue;
        done[node] = 1; included[node] = 1;
        for (const child of children[node] ?? []) stack.push(child);
      }
    }
  }
  const expanded = new Set(tree.expandedIds.map(idKey));
  const collapsed = new Set((tree.collapsedIds ?? []).map(idKey));
  const all = tree.expandAll ?? tree.expandedIds.length === 0;
  const selected = new Set(view.meta.selectedRowIds.map(idKey));
  const getSelectionId = compileAccessor(view.idField);
  const offset = view.pageSize ? view.page * view.pageSize : 0;
  const end = view.pageSize ? offset + view.pageSize : Infinity;
  const entries: Array<DataviewEntry<T>> = [];
  let visibleRows = 0;
  // VERIFIED (cpu profile: 13% in GC before): two typed stacks instead of one object per visited node. After cycle
  // cutting each row is pushed at most once, so rows.length bounds both and the walk allocates nothing per node.
  const stackIndex = new Int32Array(rows.length), stackDepth = new Int32Array(rows.length);
  let top = 0;
  for (let index = roots.length - 1; index >= 0; index--) { stackIndex[top] = roots[index]; stackDepth[top++] = 0; }
  const anyCollapsed = collapsed.size > 0;
  while (top) {
    const index = stackIndex[--top], depth = stackDepth[top];
    const group = children[index];
    const hasChildren = !!group?.length;
    let isOpen = all;
    if (!all || anyCollapsed) { const key = keyAt(index); isOpen = all ? key === undefined || !collapsed.has(key) : key !== undefined && expanded.has(key); }
    const canDescend = isOpen && (tree.maxDepth === undefined || depth < tree.maxDepth);
    if (included[index]) {
      if (visibleRows >= offset && visibleRows < end) {
        const selectedKey = selected.size ? selectionKey(getSelectionId(rows[index])) : undefined;
        entries.push({ row: rows[index], meta: {
          depth, hasChildren, isExpanded: hasChildren && canDescend,
          isMatch: matched[index] === 1,
          isSelected: selectedKey !== undefined && selected.has(selectedKey),
          parentId: (parents[index] ?? null) as DataviewJsonValue | null,
        } });
      }
      visibleRows++;
    }
    if (canDescend && group) for (let child = group.length - 1; child >= 0; child--) { stackIndex[top] = group[child]; stackDepth[top++] = depth + 1; }
  }
  return { entries, matchedRows, visibleRows };
}
