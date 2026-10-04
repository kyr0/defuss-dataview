# defuss-dataview

Isomorphic functional filters, sorting, pagination, tree traversal and UI metadata for tables and tree grids. Zero runtime dependencies. ESM and CommonJS, TypeScript declarations, standalone browser modules and worker support.

Version **0.4.0** improves upstream 0.3.1 while retaining every existing exported function and the array return contract of `applyDataview`. Read the [migration notes](#migration-from-031) before upgrading: a few incorrect behaviors are intentionally corrected.

## Install

```sh
npm install defuss-dataview
```

Before publication, install the included `artifacts/defuss-dataview-0.4.0.tgz` instead. Runtime Node engine requirements are unchanged from 0.3.1; use Node 22 or 24 for development/release tooling.

## Filter, sort, page

```ts
import { createDataview, applyDataview, evaluateDataview } from 'defuss-dataview';

const data = [
  { id: 1, name: 'Ada', score: 92 },
  { id: 2, name: 'Grace', score: 98 },
  { id: 3, name: 'Linus', score: 75 },
];
const view = createDataview({
  filters: [{ field: 'score', op: 'gte', value: 80 }],
  sorters: [{ field: 'score', direction: 'desc' }],
  page: 0, pageSize: 1,
  meta: { selectedRowIds: [2], lockedColumns: ['name'] },
});

const entries = applyDataview(data, view); // Existing [{ row, meta }] contract.
console.log(entries[0].row.name);         // Grace
console.log(entries[0].meta.isSelected);  // true

const result = evaluateDataview(data, view);
console.log(result.matchedRows); // 2
console.log(result.pageCount);   // 2
console.log(result.hasNextPage); // true
```

Both apply functions accept readonly backing arrays and preserve row object identities. They never sort or mutate the backing array. Treat descriptors and row data as immutable while applying a query; no caching or mutation tracking is hidden inside the package.

| Function | Return / behavior |
| --- | --- |
| `createDataview(request = {})` | Normalized `DataviewState` |
| `applyDataview(rows, view)` | `Array<{ row, meta }>` |
| `evaluateDataview(rows, view)` | Entries plus counts and paging state |
| `updateMeta(view, updates)` | Update UI metadata without rebuilding query state |
| `setSelectedRows(view, ids)` / `toggleSelectedRow(view, id)` | Replace/toggle selection |
| `setLockedColumns(view, columns)` | Deduplicated nonempty column names |
| `setExpandedIds(view, ids)` / `toggleExpanded(view, id)` | Explicit expansion list / toggle effective expansion |
| `updateRows(rows, ids, updates, idField = 'id')` | Batch shallow patches; unchanged rows retain identity |
| `addRows(rows, newRows, anchorId?, position = 'after', idField = 'id')` | Insert before/after the first anchor; missing anchor appends |
| `removeRows(rows, ids, idField = 'id')` | Remove matching rows, without implicit subtree deletion |
| `setParent(rows, nodeId, parentId, idField = 'id', parentIdField = 'parentId')` | Immutable move; reject self/descendant/cyclic parent chains |

Data patch helpers retain the input array on a no-op. Matching update IDs repeated in one batch use the last patch, preserving the old behavior. Matching duplicate row IDs are all updated/removed. `updateRows` is a shallow merge: patch keys are literal property names, not dot-path assignments. IDs and `setParent` field arguments do support dot paths. Array-index segments use dot syntax such as `links.0.parent`; bracket syntax is not a path syntax here.

`setParent` changes the named parent path, copying only its ancestors. Moving to a missing parent remains allowed (an orphan renders as a root); use `null` to detach. It does not mutate descendants. Generic `updateRows` and `addRows` do not enforce graph integrity, so external or patched graphs can still contain cycles; traversal handles those deterministically.

## Descriptor and query semantics

Fields use nonempty dot paths and own-property traversal. `__proto__`, `prototype`, `constructor`, empty segments and empty paths are rejected. Fields inherited from a prototype do not participate. Accessors/getters on actual own row properties may execute; rows should be ordinary application data.

Filters are ANDed; available operators are `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `startsWith`, `endsWith`. Equality and array membership retain strict JavaScript equality, including reference equality for object-valued filter operands. String operations are case-sensitive. An `in` operand that is not an array matches nothing. Null, missing, `NaN`, and invalid-date cells do not match relational operators. JSON-compatible filter operands can be serialized, but object reference equality does not survive a JSON round trip; use scalar field predicates for portable queries.

Sorters accept `direction` or its alias `dir` (`asc` default); `direction` takes precedence. Equal values preserve input order. Mixed values use ascending type order: booleans, numbers, BigInts, strings, valid Dates, other values, invalid numbers/dates, nullish values. Descending reverses that ordering. Numbers and Dates sort numerically; strings use the runtime's `localeCompare`, which can differ between host locales. BigInts and other values retain the legacy lexical `String(value)` comparison. Objects with throwing/string-conversion side effects are outside the plain-data sorting contract. `NaN` values tie stably; `null` and `undefined` also tie stably.

Pages are zero-based safe nonnegative integers; `pageSize` must be a positive safe integer and the offset must stay in the safe integer range. Omit `pageSize` to disable paging (`page` then has no effect). Out-of-range pages return an empty array rather than clamping state. Use `createDataview({ ...view, page: 0, filters: nextFilters })` when a UI filter changes. Normalization validates structure; filter values remain caller-owned references to preserve equality semantics.

## Counts for grid controls

`evaluateDataview` returns:

| Field | Meaning |
| --- | --- |
| `entries` | The requested page; identical to `applyDataview` output |
| `totalRows` | Backing input length |
| `matchedRows` | Rows satisfying filters, before ancestor/descendant inclusion and collapse |
| `visibleRows` | Included rows passing expansion/maxDepth, before paging |
| `page`, `pageSize` | Descriptor values |
| `pageCount` | `ceil(visibleRows / pageSize)`; unpaged: 1 if nonempty, otherwise 0 |
| `hasPreviousPage`, `hasNextPage` | Paging navigation flags; both false when unpaged |

Flat views have equal `matchedRows` and `visibleRows`. Tree views can have more visible rows than matches (included ancestors), or fewer (collapsed matches). Counts are not inferred from a page's length. If a requested page exceeds the last page, `hasPreviousPage` remains true when any page exists, allowing the application to recover or clamp explicitly.

## Trees and expansion

```ts
import { createDataview, applyDataview, toggleExpanded, setExpandedIds } from 'defuss-dataview';

const rows = [
  { id: 1, parentId: null, name: 'Root' },
  { id: 2, parentId: 1, name: 'Child' },
];
let view = createDataview({ tree: { idField: 'id', parentIdField: 'parentId' } });
console.log(applyDataview(rows, view).length); // 2: omitted expansion list opens all.
view = toggleExpanded(view, 1);
console.log(applyDataview(rows, view).length); // 1: toggling closes this root.
view = setExpandedIds(view, []);              // Explicitly collapse all.
```

| Tree option | Behavior |
| --- | --- |
| `idField`, `parentIdField` | Required dot paths defining graph identity |
| Omitted `expandedIds` | Defaults to `expandAll: true` |
| Explicit `expandedIds: []` | Defaults to `expandAll: false`: collapse all |
| Nonempty `expandedIds` | Expand listed IDs only, unless `expandAll` is explicitly true |
| `expandAll: true` | Expand all except `collapsedIds` |
| `collapsedIds` | Exceptions used only in expand-all mode |
| `maxDepth` | Nonnegative safe integer, root depth 0; capped nodes are not reported expanded |
| `includeAncestors` | Include ancestors of matches; default true |
| `includeDescendantsOfMatch` | Include descendants of matching nodes; default false |

Expansion flags are explicit JSON state; default-mode toggles update `collapsedIds`, so they work without access to backing rows. `setExpandedIds` switches to explicit-list mode and clears exceptions. Expand/collapse helpers are no-ops on flat views. To expand all again, use `createDataview({ ...view, tree: { ...view.tree!, expandAll: true, collapsedIds: [] } })`.

Traversal is sorted preorder: sort roots and each sibling group separately. Filters do not promote descendants to root level; depths retain hierarchy position, and a collapsed excluded ancestor still hides its descendants. Paging applies to the visible flattened sequence, so a page may begin at a child. `hasChildren` describes the source hierarchy, even when children do not match the filter.

Missing/null IDs are unindexed; missing/null or unknown parents become roots. Duplicate IDs keep separate rows, with parent references resolving to the first occurrence. Self-parent rows render as roots. For longer cycles, traversal cuts one rendering edge per cycle at its lowest original input index. This also retains cyclic components beside ordinary roots. Input rows are unchanged and `meta.parentId` retains the original parent value, including the cut edge. IDs should still be unique for meaningful selection and moves.

Every entry has `{ depth, hasChildren, isExpanded, isMatch, isSelected, parentId }`. Flat entries have depth 0, no children/expansion, true `isMatch`, and null `parentId`. An explicit top-level `idField` controls selection even in a tree; otherwise it inherits `tree.idField`.

## Identity and controlled state

Selection, expansion, parent linking and patch helpers share canonical JSON ID matching. Objects compare by JSON contents independent of property-key order; arrays preserve order; numeric and string IDs remain distinct. Finite numbers, booleans, strings, plain objects and dense arrays are supported. `-0` and `0` share their JSON identity. `null`/missing row IDs are not selectable or indexed as tree parents; patch helpers can explicitly match a null ID. Missing IDs never alias null.

Non-finite numbers, `undefined` as an explicit ID, BigInts, dates, functions, symbols, cycles, accessors, hidden properties and sparse/extended arrays are rejected as identifiers. Ordinary non-ID row fields may still contain Dates, BigInts, etc. Normalization copies selection and expansion IDs, so caller mutation does not change normalized state. Meta updates preserve extensions on the view, retain untouched query references, and return the same view for a semantic no-op. Extension fields on `view.meta` are also retained.

For a controlled grid, keep data and view separately: patch data with `updateRows`/`setParent`, change query state with `createDataview`, change selection/expansion with the helpers, then reapply. There are no globals, subscriptions, storage access, DOM dependencies or automatic persistence. A store such as `defuss-store` can own the descriptor, but is not required.

## Browser and worker use

Bundlers resolve `import ... from 'defuss-dataview'`; CommonJS uses `require('defuss-dataview')`. Direct browser/module-worker scripts can import the distributed `dist/browser.mjs` or `dist/browser.min.mjs` asset by URL. They are physical assets, not additional package-export subpaths. Source maps are included. Public types need only ES2022 libraries, with no DOM or Node ambient types.

Run the complete interactive example after building:

```sh
npm run dev
# http://127.0.0.1:4179
```

The example implements sorting, search, paging, selection, tree expansion and JSON descriptor restoration. Its real Chromium tests also execute a 30,000-level hierarchy inside a module worker.

## Migration from 0.3.1

All 67 original tests remain byte-for-byte unchanged and pass. Deliberate corrections requiring attention:

- **Explicit `expandedIds: []` now collapses all.** Omit it, or set `expandAll: true`, to open all. Old saved descriptors normalized by 0.3.1 cannot distinguish omitted from explicit empty lists; migrate those intentionally.
- Cycles terminate and no longer disappear beside other roots; deep/wide trees no longer depend on recursion or spread argument limits.
- Object/array IDs now use structural JSON identity consistently; unsupported/lossy IDs fail instead of colliding.
- Inherited properties and unsafe/malformed paths no longer match. Data-patch field arguments now honor the same dot paths as queries.
- No-op patches/meta updates preserve references. View extension fields are retained.
- Mixed-type ordering is explicit and transitive for ordinary scalar data; NaN/invalid dates tie stably. Invalid/nullish relational cells no longer match.
- `setParent` rejects moves into self, descendants, or an existing cyclic parent chain. It still allows unknown parents and does not validate unrelated components.
- Paging/depth validation rejects unsafe integers. A node stopped by `maxDepth` is not reported expanded.

The legacy filter operators, strict filter equality, `dir` alias, null sort direction, lexical BigInt fallback, duplicate-parent first-wins policy, row-reference preservation, patch signatures and all public exports remain available. `evaluateDataview` is additive.

## Develop, verify, benchmark

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
```

The standalone package has its own TypeScript config, exact development lockfile, Makefile aliases and CI. `check` runs lint, source/API type checks, dual builds, unit coverage, Chromium/worker tests, an isolated npm-tarball install and release verification. The tarball consumer checks ESM and CommonJS runtime imports, both declaration modes, Bundler resolution, SSR without DOM globals, and browser bundling without workspace aliases.

`npm run audit:upstream` reproduces ten defects against pinned original source, with a separate process deadline for the infinite loop. `npm run benchmark:compare` records nine alternating local samples after three warmups, first checking output equivalence. `npm run benchmark` retains the original 10k/50k/1M benchmark scenarios. Benchmarks are non-gating: robustness and consistent identity add work, and no universal speedup is claimed. Reports are in `artifacts/`; build sizes are measured in `dist/stats.json`.

See [ARCH.md](./ARCH.md), [CHANGELOG.md](./CHANGELOG.md), [RELEASE.md](./RELEASE.md), and `NOTICE` for implementation details, release instructions and upstream provenance.
