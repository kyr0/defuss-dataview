# Architecture

Version 0.5.0 builds on standalone DataView commit `7ff0498e426f1d40ceaeff409f4fb725dbe81223` (package 0.4.0). DBSONL integration was designed against `kyr0/defuss-dbjsonl` commit `a6063a50e84f872d442efc4bef0ec03cb0986c08`, package 0.4.0, and tested against the npm package. Version 0.6.0 adds `defuss-dataview/compute` on top of the same source protocol.

## Boundaries

| Layer | Responsibility |
| --- | --- |
| values/query/fields | Deterministic equality, ordering, safe access and query compilation |
| table/tree evaluator | Synchronous exact grid results, forest normalization, UI metadata |
| stream executor | One owned snapshot, global query state, bounded sorting/paging/counts |
| compute plans | Prepared projection, aggregation and page-plus-totals over the same snapshot sources ([src/compute/ARCH.md](src/compute/ARCH.md)) |
| record source | Scoped stable records, order/count capabilities, batching and cleanup |
| DBSONL adapter | Map read-session lifecycle and key ranges to the source protocol |
| storage/database/graph | Bytes, durability, mutation/index planning and graph traversal outside this package |

Runtime entries import no Node/DOM modules and have no package dependencies. Query compilation captures configuration explicitly; no mutable-descriptor cache or global data registry exists. Platform/storage APIs remain in caller-provided sources. DBSONL types are structural, so tree-shaking and browser consumers never resolve its native backend through DataView.

## Execution

Filtering uses one compiled own-property accessor per field. Sort keys use one coherent total preorder; no ad-hoc pairwise coercion. Stable encounter ordinals extend that preorder for heap retention. Source ordering can satisfy a requested prefix only with the same comparator fingerprint. Default code-unit string ordering matches DBSONL keys; locale collation creates a different fingerprint.

Unsorted/matching-order execution maintains global offset/limit counters across batches. Unknown hasMore needs a lookahead match; exact filtered totals need exhaustion. The source's exact count may answer an unfiltered total without exhaustion. Summary counts never substitute an observed prefix for an exact total.

An unordered finite sorted page retains k = offset + limit candidates in a max-heap. Invariant: after examining i matching rows, the heap contains the best min(i,k) under (query comparison, encounter ordinal); its root is the worst retained row. A new candidate replaces the root only if strictly better. Final sorting of the retained prefix produces the global page. Time O(n log k + k log k), memory O(k), with independent row/byte admission. Unpaged sorting retains all matches subject to the same budgets. No full external sort is hidden behind a streaming API.

Batches use pull-based iteration and no background prefetch. Periodic configurable host task yields prevent synchronous/in-memory sources from starving timer or message cancellation. Synchronous input rows batch without one awaited promise per row. defuss-dbsonl 0.6.0 supplies native batches; row-only providers retain per-record work. Output arrays are fresh and never reused. Batch events precede final success, so consumers must understand partial output on later failure.

## Resource lifetime

Configuration is compiled at call time; a snapshot opens at first pull. The executor owns it until completion, error, cancellation or consumer return. It calls both iterator return and session close, including when one cleanup fails. Cleanup errors aggregate, preserving the processing error first. Completion is emitted only after cleanup succeeds. Cancellation is cooperative and does not abandon pending I/O. Paused iterators intentionally retain snapshot pins.

Budgets account rows, full binary backings and candidate overhead. VM overhead, caller memory, source buffers, input/output batches, sorting and collector scopes are disclosed separately. Estimates are deterministic accounting, not proof of a physical heap ceiling. Getters are excluded from default accounting; a custom pure sizeOf may represent other trusted row classes.

## Arrays and forests

Array sources default to cloning values on open; immutable mode trusts caller immutability. The synchronous table/tree API retains row identities. Tree evaluation builds an ID index and parent array, cuts cycles deterministically, propagates inclusion with visited state, and walks preorder iteratively. Its hierarchy memory is O(n); sorting adds sibling work. Selection uses canonical JSON IDs, distinct from value equality.

## Evidence

Tests exercise real memory/native/OPFS storage, seeded array/stream equivalence, adversarial ties and late winners, mixed-type comparator laws, explicit limits, source contract errors, cleanup failure aggregation and package consumption. `tests/fixtures/` preserves historical source/tests as immutable provenance; the current contract is tested under src/. Differential tests compare the optimized compiler and byte accounting with a committed pre-optimization build in `tests/reference/`, whose hashes `npm run verify` checks; benchmark reports and their environment land in `artifacts/`.

The optimization design and benchmark reproduction are in [documentation/PERFORMANCE.md](documentation/PERFORMANCE.md). Source-private measured scans, fused external validation, admission-before-allocation top-k, guarded scalar query paths and versioned immutable array snapshots preserve the common engine contracts.


## Revision cache and explicit indexes

Each immutable membership revision owns a lazy bounded numeric accounting cache.
No generic object-identity memoization exists. A prepared query captures compilation
alone; each invocation still owns its session and execution buffers. The optional
index owns a filtered, stable-sorted row-reference array and uses a WeakSet to
validate process-local cursor authority and exact revision. Rebuild publication
is atomic; its synchronous cost and separate source memory limits are explicit.

defuss-dbsonl 0.6.0 snapshots supply bounded batch pulls (`scanBatches`); the
adapter uses them when present and batches `scan()` rows itself otherwise, so an
older or row-only database still works. The adapter's own size check keeps
structural-provider validation intact. Library consumers install defuss-dbsonl
only if they use the adapter.

Optional revision key caches retain raw field columns across queries. Exact revision/field identities, admission reservations and private pinned leases separate cache efficiency from correctness. Block summaries only bypass predicates after full batch validation. See [documentation/KEY-CACHE.md](documentation/KEY-CACHE.md) and [src/stream/ARCH.md](src/stream/ARCH.md) for lifecycle and memory boundaries.
