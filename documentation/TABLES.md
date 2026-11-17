# Table and tree API

`createDataview(request?)` validates and normalizes a request. `evaluateDataview(rows, state)` returns `{entries, totalRows, matchedRows, visibleRows, page, pageSize, pageCount, hasPreviousPage, hasNextPage}`. Every entry is `{row, meta}`. `applyDataview` returns the entries only.

- `totalRows`: supplied array length.
- `matchedRows`: exact filter matches before hierarchy inclusion.
- `visibleRows`: exact included rows after expansion/depth, before pagination.
- `page`: zero-based; default 0. `pageSize`: positive safe integer or omitted. Unpaged results have one page when nonempty and zero when empty.
- Row metadata: `depth`, `hasChildren`, `isExpanded`, `isMatch`, `isSelected`, `parentId`.

Filters, sorting and `semantics` use the shared compiler described in README. Flat unsorted paging avoids materializing all matches; filtered counts still scan input. Flat sorted shallow pages use stable top-k for large inputs, with a native-sort fallback for reverse runs. Deep pages, small inputs and unpaged requests use native sorting. Counts remain exact, and returned rows retain their identity. See PERFORMANCE.md for selection thresholds. The array API returns synchronous results and does not acquire a snapshot.

## Hierarchy

`tree` requires `idField` and `parentIdField`; both support safe own-property paths. `expandedIds` defaults to all expanded when omitted. Explicit `[]` collapses all. `expandAll` can override that choice; `collapsedIds` are exceptions to expand-all. `maxDepth` is a nonnegative integer. `includeAncestors` defaults true; `includeDescendantsOfMatch` defaults false.

Duplicate identifiers use the first matching row as a parent target. A missing parent becomes a root. For a cycle, cut the lowest input-index member's parent link, retaining the rows as a finite forest. Traversal and ancestor propagation are iterative. Children sort within siblings; roots sort together. Tree evaluation uses O(n) hierarchy memory, plus sibling sorting. This is a forest projection, not a general graph database.

## Identity and UI state

`idField` defaults to `tree.idField`, or `id`. IDs are finite JSON values; object key order does not affect canonical identity. Selection/expansion normalization copies IDs. Undefined, NaN, Infinity, BigInt, Date, symbols, functions, accessors, cycles and lossy/sparse JSON representations are invalid IDs. Non-JSON row IDs are unselected rather than crashing evaluation. Non-ID fields support the richer value semantics.

`setSelectedRows(view, ids)`, `toggleSelectedRow(view, id)`, `setLockedColumns(view, columns)`, `setExpandedIds(view, ids)`, `toggleExpanded(view, id)`, and `updateMeta(view, patch)` return updated state and preserve unrelated state. Semantic no-ops retain identity where possible. `updateMeta` accepts query-independent metadata.

## Row helpers

- `addRows(rows, newRows, anchorId?, position?, idField?)`: immutable insertion relative to a row identifier; position before/after.
- `updateRows(rows, ids, patches, idField?)`: immutable shallow patches matching IDs. Equal patches avoid allocation; unchanged rows retain identity.
- `removeRows(rows, ids, idField?)`: immutable removal of explicitly named rows; it does not infer descendant removal.
- `setParent(rows, id, parentId, idField?, parentIdField?)`: immutable parent-field change with cycle guards and nested path support.

Generated TypeScript declarations are authoritative for parameter types. See `examples/index.html` for a working table/tree UI, `examples/stream.mjs` for a source query, and `examples/dbsonl.mjs` for persistence integration.
