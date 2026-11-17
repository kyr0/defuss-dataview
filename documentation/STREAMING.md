# Streaming API

## Functions

| Function | Result |
| --- | --- |
| `streamQuery(source, request?, options?)` | `AsyncGenerator<QueryEvent<T>>` |
| `evaluateStream(source, request?, options?)` | `Promise<{rows: T[], summary: QuerySummary}>` |
| `createArraySource(rows, options?)` | Repeatable `RecordSource<T>` |
| `createImmutableArraySource(rows, options?)` | `ImmutableArraySource<T>` with O(1) opens and atomic membership replacement |
| `toStreamRequest(view)` | Flat `StreamRequest`; rejects tree state |
| `batchRows(iterable, scanRequest)` | Bounded batches from synchronous/asynchronous rows |
| `estimateRowBytes(value)` | Deterministic accounted size, including retained binary backings |

`compileQuery(descriptor)` from `/query` returns `matches`, `compare`, `hasFilters`, and immutable `ordering`. `orderingSatisfies(actual, requested)` checks comparator identity and sort-prefix compatibility. `createValueOperations(semantics)` exposes `equal`, `compare`, `comparisonId`, `equality`; `compareValues` uses the default order.

## Request and options

`StreamRequest`: `filters`, `sorters`, `semantics`, `offset` (default 0), `limit` (optional). Offset/limit and their sum must be safe nonnegative integers. Limit zero returns no rows and still establishes counts/hasMore according to the selected execution strategy. Filters combine with AND. Sorters are ordered priority keys. `direction` is asc/desc, with asc default; `dir` is an accepted shorthand.

`StreamOptions`: `count: 'none' | 'exact'`, `batchSize`, `maxBatchBytes`, `maxRowBytes`, `maxBufferedRows`, `maxBufferedBytes`, `maxScannedRows`, `sizeOf`, `signal`, `yieldEveryBatches` (default 32; 0 disables host fairness). Byte/row capacities are positive safe integers. `maxScannedRows` permits zero. Source/output batch and sorting/collection limits have separate scopes. `sizeOf` must return a nonnegative safe integer, remain pure and stable, and account for the retained representation of a row. Callbacks and source code are trusted application code.

Configuration is captured when `streamQuery()` is called. `source.open()` runs only on the first pull. A supplied structural signal needs only `aborted` and optional `reason`; native `AbortSignal` works. Cancellation is cooperative before/after pulls and between rows. Every 32 input batches by default, a host task yields to the event loop so timer/message-driven cancellation can actually run for in-memory sources; resolved promises alone are insufficient. Zero disables these fairness yields; a runtime without `setImmediate`, `scheduler.postTask` or `setTimeout` needs it, because the default throws a `TypeError` there. Key-cache builds and `prepare()` yield to the host every 16,384 rows where they can and run without task boundaries where the host has none, so cancellation is then observed only between those chunks, and a query waiting on another query's build observes it when that build finishes. It cannot interrupt an uncooperative pending source promise, synchronous comparator, `sizeOf`, native clone or JavaScript sort. Cleanup awaits in-flight source work according to its session contract.

## Event protocol

1. Zero or more `{type: 'batch', rows}` events. Nonempty fresh arrays, bounded by row/byte batch limits.
2. Exactly one `{type: 'complete', summary}` on successful full consumption. Both iterator and session cleanup have already succeeded.
3. Iterator completion.

On failure the generator throws; no success event follows. Batches already yielded cannot be retracted. Consumers performing irreversible effects must stage them until completion or deliberately accept partial processing. Early return closes the scan and snapshot. Calling `return()` before first `next()` acquires nothing. Holding a paused iterator holds its snapshot; dropping a JS reference does not guarantee prompt cleanup. Use `for await` with `break`, or `try/finally { await iterator.return(undefined); }`.

## Summary

| Field | Meaning |
| --- | --- |
| `revision` | Source snapshot revision; number, string or bigint |
| `sourceRows` | Exact rows in source scope, or null |
| `totalMatches` | Exact matches before pagination, or null |
| `scannedRows` | Rows examined; excludes unexamined remainder of a prefetched source batch |
| `observedMatches` | Predicate matches observed, including lookahead |
| `returnedRows` | Emitted output rows |
| `sourceExhausted` | Iterator returned done; false after early limit stop |
| `hasMore` | At least one match lies after the requested page |
| `strategy` | scan, ordered, top-k or sort |
| `peakBufferedRows/Bytes` | Sorting-candidate peak, or output-batch peak for scan/ordered; excludes source and collector |

A source can decode up to one input batch beyond the last examined row. `batchRows()` additionally may hold one pending row while splitting a byte-full batch. defuss-dbsonl 0.6.0 supports native batches; row-only providers retain per-record asynchronous work. Both paths may retain one pending row when splitting a byte-full batch.

## Errors

| Error | Cause |
| --- | --- |
| `DataviewError.code = ABORTED` | Cancellation observed; signal reason attached as cause |
| `LIMIT_EXCEEDED` | Row, candidate, collector or scan work limit exceeded |
| `SOURCE_CONTRACT` | Non-snapshot source, invalid batch/row or observed count mismatch |
| `CLOSED` | Adapter/session used after close |
| `TypeError` / `RangeError` | Invalid query, options, row accounting or source metadata |
| `AggregateError` | One or more cleanup failures; original processing error is first when present |

Source/storage errors propagate unchanged when cleanup succeeds. Always attempt both iterator return and session close; a failure in one cannot suppress the other. A complete event is never emitted after cleanup failure.

## Immutable revisioned arrays

`createImmutableArraySource<T>(rows, {ordering?})` returns a `RecordSource<T>` plus readonly `count`, readonly bigint `revision` (initially `0n`), and `replace(rows): bigint`. Creation and replacement own a shallow copy of membership. Replacement increments the revision after the copy succeeds; existing readers retain old membership, revision and count. Opening a session pins the current membership without copying. Caller rows, nested objects, Dates and binary buffers must remain immutable, including returned values. Closing is idempotent; a closed session cannot scan again. Ordering remains a caller promise for every published revision.

Use this source for read-heavy immutable data. Use `createArraySource` for value cloning at each query or membership captured from an externally managed array. Retaining many simultaneous revisions retains their membership arrays until readers release them; executor budgets do not limit caller/source snapshot storage.

## Prepared execution

`prepareStreamQuery<T>(descriptor?)` returns a frozen `PreparedStreamQuery<T>` with
`ordering`, `stream(source, page?, options?)` and `evaluate(source, page?, options?)`.
`page` contains only offset/limit. Compilation captures the same operands as
compileQuery: Date/binary operands and membership lists are copied under value
semantics; opaque objects and identity-mode operands retain identity. Keep such
identity operands immutable when reusing a prepared plan. Each execution pins a
fresh source revision. Concurrent executions share no counters, buffers or pins.

## Revision accounting

`createImmutableArraySource(rows, {ordering?, maxCachedBytes?})` additionally
exposes `cachedBytes` and `prepare({signal?})`. The latter resolves to
`{revision, cachedRows, cachedBytes}` for the revision pinned at invocation, even
if replace runs while preparation yields. The default cap is 64 MiB; zero disables
caching. Normal queries fill pages lazily. Preparation measures the capped prefix
without applying query row/batch limits; subsequent queries enforce their own
limits. Measurement failures reject preparation and leave any valid earlier
measurements available. Caller values must remain transitively immutable.

## Materialized indexes and cursor pages

```ts
import { createIndexedArraySource } from 'defuss-dataview/stream';
const index = createIndexedArraySource(records, {
  filters: [{ field: 'active', op: 'eq', value: true }],
  sorters: [{ field: 'score', direction: 'desc' }],
}, { maxIndexRows: 100000, maxIndexBytes: 800000, maxCachedBytes: 800000 });
const first = await index.readPage({ limit: 50 });
if (first.nextCursor) {
  const second = await index.readPage({ after: first.nextCursor, limit: 50 });
}
```

`createIndexedArraySource<T>(rows, descriptor?, options?)` materializes the filter
and ordering scope, retaining row references and stable ties. It implements
RecordSource and exposes count, inputRows, revision, cachedBytes, prepare and
atomic replace. A descriptor has no pagination; readPage defaults to limit 50.
Returned `IndexedPage<T>` includes rows, summary, indexRows and optional nextCursor.
No nextCursor means no later rows. A zero-sized page can return a cursor at its
unchanged position. A page can use all normal execution/collector budgets.

`IndexCursor` is a frozen process-local token with revision and position fields.
Only tokens minted by that index instance are accepted. Copies, serialized fields,
foreign tokens and tokens from an older published revision throw RangeError.
An already-admitted page remains pinned through replacement; any cursor it returns
then belongs to its old revision. This is cursor pagination over an immutable
materialized scope, not a durable database cursor or automatic secondary index.

Index creation/replacement runs synchronously, rejects invalid record objects,
and enforces explicit reference budgets. Filtered-out rows do not occupy index
slots. Default accounting is lazy; creation alone does not certify row-byte limits.
All indexed row graphs and identity-based query operands must remain immutable.
See PERFORMANCE.md for build, cache, sorting and retention cost scopes.

Index options additionally accept cacheSortKeys (default false) and maxSortKeyBytes (default 16 MiB). The opt-in requires pure/stable sort accessors. A build projects all matching keys only if their accounted entries fit; otherwise it uses the general comparator. sortKeyBytes reports transient build accounting, not retained bytes. See PERFORMANCE.md for the exact formula and separate memory scopes.

Immutable sources additionally accept keyCache options and expose prepareKeys, clearKeyCache and keyCacheStats. Persistent column caching, shared builds, cancellation, admission and optional block summaries are documented in KEY-CACHE.md.
