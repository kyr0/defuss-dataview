# Stream engine

types.ts is the storage-independent source/event contract. executor.ts owns snapshot lifetime, pagination, exact/unknown counts, resource admission and successful completion. heap.ts implements stable top-k retention without I/O. common.ts owns errors, cancellation, accounting and cleanup aggregation. batches.ts groups rows without unbounded prefetch; array.ts supplies the in-memory reference source.

The executor performs no writes, index creation or graph traversal. A source is trusted for snapshot/order guarantees; observed batch/count violations fail. Sorting, collector, source/input and output memory scopes are separate. All abort/error/early-return paths must reach both iterator and session cleanup.

projection.ts is a second private registry of the same kind: a session may answer a bounded page from copies of the fields the query reads, and the executor then asks it for the stored rows of the returned page, measures them again and splits them under the output byte budget.

measured.ts is a module-private session registry. Built-in sources register a direct measured scan, bound to the identity of the original public scan method. The executor calls that scanner itself; arbitrary public batches never supply trusted sizes. Replacing/decorating scan or using a separate bundled instance falls back to independent validation. Measurements are query-local except for an explicitly immutable revision cache; immutable row values and pure stable estimators remain source contracts. The collector receives byte totals through a private callback and still enforces its own row/byte budget.

Top-k compares raw rows against its worst candidate before allocating; a later equal key cannot beat the root's earlier ordinal. Only admitted candidates mutate the heap; full finite heaps recycle the evicted root after budget checks. The unbounded-sort path still collects directly before native stable sorting. Generic stream sorting does not cache keys. sort-keys.ts provides explicitly opted-in index-build projection with a separate transient accounting cap and the shared typed comparator.

createImmutableArraySource owns copied membership per bigint revision, amortizing O(n) copying across O(1) opens. It deliberately requires transitively immutable caller values. createArraySource still clones or copies on every open.


accounting-cache.ts owns lazy 4096-row Float64 pages, bounded by numeric payload
bytes. Pages belong to a membership revision, never to a process-global row cache.
array.ts privately emits spans and reuses scratch only after the next pull.
indexed.ts builds an explicit filter/order scope and validates revision-bound
cursor tokens. Synchronous index builds precede atomic publication. Default row
accounting stays lazy, and query budgets apply even after cache preparation.

Fully measured cache pages privately lend numeric spans. Cache sentinels decode in the executor; current row/batch budgets are checked before the span is exposed. Public sources cannot forge this path.

key-cache.ts owns source/revision columns, SLRU queues, reservations and pinned
leases; admission.ts supplies bounded popularity policies. key-capability.ts binds
private acceleration to unchanged scan identity. block-summary.ts proves only
nonmatches; executor.ts applies its predicate bypass after full batch validation
and maintains all scan/count budgets. query-internals.ts shares the compiler's
captured operands/comparator privately. No public source can forge this capability.
Columnar sort-keys.ts builds an index permutation instead of per-row decorated objects.
