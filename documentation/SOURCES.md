# Record source protocol

A record source is an execution boundary, not a byte adapter. Storage, decoding, live-record resolution and snapshot lifetime belong below it. The database or graph layer chooses the candidate scope and access path; DataView filters/ranks/pages that scope.

```ts
interface RecordSource<T extends object> {
  open(options?: {signal?: CancellationSignal}): Promise<RecordSession<T>>;
}
interface RecordSession<T extends object> {
  readonly consistency: 'snapshot';
  readonly revision: string | number | bigint;
  readonly count?: number;
  readonly ordering?: QueryOrdering;
  scan(request: ScanRequest<T>): AsyncIterable<readonly T[]>;
  close(): Promise<void>;
}
```

A source must:

1. Open a fresh owned session for each query. Open failures release partially acquired resources internally.
2. Preserve membership, ordering, values and metadata for the entire session. Return immutable/owned rows; never reuse mutable decode buffers across pulls.
3. Report only exact scoped counts. Omit count if computing it would require a scan. A range/candidate source is its own scope.
4. Assert ordering only when every emitted row respects that comparator and key sequence. Use the compiler's ordering descriptor. An ordered prefix of the source can satisfy a shorter requested key list. Query ties preserve scan encounter order.
5. Respect `batchSize`, `maxBatchBytes`, `maxRowBytes`, `sizeOf` and cancellation. Emit nonempty batches. Do not hide unbounded read-ahead or concurrent requests.
6. Supply an iterator `return()` that releases iterator-local resources. Keep session-owned pins/resources until session close.
7. Make `close()` idempotent, stop new work, drain admitted reads, and release resources even after a failed iterator.

The executor independently validates external batch/row sizes and validates counts at observed exhaustion and excess row counts. Built-in scans validate row/batch sizes once and transfer their measurements privately. It cannot detect a dishonest ordering claim or changes to unseen data. Cancellation does not permit force-closing an in-flight uncooperative source. Custom sources must uphold the contract.

## Array source

`createArraySource(rows, {isolation: 'clone', revision: 0, ordering?})` clones on open. Rows must be structured-cloneable. `immutable` copies the row list and trusts caller immutability of referenced values. Source allocations are outside query retention budgets. Do not claim an ordering unless rows actually satisfy it. Mutating the original list affects later opens; a new execution may therefore need a caller-managed revision label.

## DBSONL adapter

`createDbsonlSource(db, {gte?, lt?, at?})` accepts a structural `beginRead()` interface. Each result row is `{key, value, revision}`; paths into stored documents start with `value.`. It neither spreads user values nor reserves application field names. It preserves undefined, scalar, cyclic and binary application values without conversion.

`beginRead()` gives snapshot `revision`, whole-store `count`, `scan()` and `close()`. The adapter uses whole-store count only without range bounds. `key asc` uses the same deterministic code-unit comparator as the default DataView ordering. Descending or locale key sorting falls back to global sorting. No predicate/limit pushdown is inferred: pushing a limit before filtering would change results. When scanBatches is present, the adapter passes bounded native batch options and independently validates emitted records. Otherwise it groups the row iterator into batches.

### One snapshot across workers

`at` pins every execution of the source to one snapshot head, such as defuss-dbsonl's `session.head`, instead of the latest one. Sources in several worker threads, each with its own database handle, then read one snapshot, and their partial aggregates merge (COMPUTE_API.md). defuss-dbsonl's `session.split(parts, {gte?, lt?})` cuts a snapshot into key ranges with exact row counts:

```js
const session = await db.beginRead();
const ranges = await session.split(4);
// In each worker: plan.partial(createDbsonlSource(workerDb, { gte, lt, at: head }))
// Close the session once every worker's partial has resolved.
```

Keep the session open until then; defuss-dbsonl rejects a head it already collected with `CONFLICT`, which the source passes on. `examples/compute-partials.mjs` runs four worker threads over one file database.

A stream query splits the same way. Each worker answers the query over its range with `offset: 0` and `limit: offset + limit`, and with `count: 'exact'` when the caller needs the total. The caller then merges the parts:

```js
// parts: each worker's evaluateStream(createDbsonlSource(workerDb, { gte, lt, at: head }), { filters, sorters, limit: offset + limit }, { count: 'exact' })
const page = await evaluateStream(createImmutableArraySource(parts.flatMap(part => part.rows)), { sorters, offset, limit });
const totalMatches = parts.reduce((sum, part) => sum + part.summary.totalMatches, 0);
```

The parts' rows contain the global first `offset + limit` rows, and concatenating the parts in key order keeps tied rows in key order, as one pass does. VERIFIED: `src/adapters/dbsonl.test.ts` compares the merge with one pass, with ties, an offset and the exact count; MONGODB.md times it with eight workers.

Give each worker's database handle a larger page cache for large scans. VERIFIED: over 1,000,000 file documents, eight workers took 843 ms with defuss-dbsonl's default 8 MiB and 1,024 pages, and 387 ms with `{ maxCacheBytes: 64 * 2 ** 20, maxCachePages: 8192 }`; raising one limit alone gave 673 to 715 ms (one-off probe, 2026-11-20). UNKNOWN: why the default cache slows a scan of contiguous key ranges.

### Projection of one revision

`createDbsonlSource(db, {projection: {fields, maxBytes?}})` keeps copies of each row's key, revision and the listed field paths, for example `['value.score']`, once a scan reads the whole scope. `source.prepare()` runs that scan explicitly; `source.projected` reports `{revision, rows, bytes}`, or undefined before a complete scan or when the copies would exceed `maxBytes` (default 64 MiB of estimated bytes, about 220 bytes per row for a key and one number).

Keeping the copies costs time on that scan: VERIFIED: in the MongoDB benchmark, `prepare()` took 1.1 times a full query over 100,000 documents and 1.4 times over 1,000,000, and a full query that records copies pays the same. Configure a projection where the data changes less often than it is queried.

A later query uses the copies only when all of these hold; otherwise it scans as before:

- the snapshot it opens has the revision the copies were made at, so any commit sends the next query back to a full scan, which then keeps the new revision;
- every filter and sort field is a listed path, a path below one, `key` or `revision`;
- it has a limit and `offset + limit` is at most 1/16 of the kept rows, because each returned row is a point read (VERIFIED: 20 to 42 µs each, against 2.5 to 3 µs per scanned row);
- it uses the default `sizeOf`, because the copies were measured with it.

The executor then runs the same compiled predicates and comparator over the copies, which resolve every allowed path to the same value through the same own-property accessor, and fetches the stored rows of the returned page with `snapshot.get()` from the query's own snapshot. Returned rows are measured again and split under `maxBatchBytes`; `maxRowBytes` applies to the copies a query reads and the stored rows it returns, so a query over the copies does not fail on an oversized row it does not return, as a full scan would. `peakBufferedBytes` counts the retained copies.

Why not alternatives: an index on a value field would make dataview a database planner and require maintaining it on every write, and inferring a key range or limit from a predicate would change results; caching whole decoded documents would hold every value in memory. The copies hold only what the configured queries read and are discarded, never patched, when the revision changes.

The adapter does not call `db.close()`, perform writes, own storage, create indexes or repair data. It releases its snapshot after query completion, early return, errors and cancellation. Directly opened adapter sessions must also be closed by their caller. DBSONL pins keep old generations available during concurrent writes and compaction.

## Graph and database integration

A DB planner can supply an equality/range-index candidate source. A graph planner can supply a typed neighborhood snapshot with stable path metadata. The count describes only those candidates, not all possible matches elsewhere. Approximate/adaptive graph completeness should be represented by the graph API outside this exact source evaluator. Traversal, visited/path state, joins, uniqueness and search-index revision coordination remain planner/model responsibilities.

## Accounting fast path

Built-in array and DBSONL sessions register an internal measured scanner. The executor invokes it directly only while the public scan method retains its original identity. No flag/property on public batches can bypass validation, and only explicit immutable revision sources may cache default accounting across requests. A source wrapper replacing `scan`, or an adapter loaded from a separate standalone bundle, receives ordinary independent input validation. A wrapper merely forwarding an unchanged built-in session retains the fast path. `batchRows` is public batching, not authorization to trust a custom source's byte claims.


The optional structural `scanBatches({gte?, lt?, limit?, signal?, batchSize?, maxBatchBytes?})`
returns async arrays of records. The native provider must honor `batchSize` and ownership.
DataView passes no `sizeOf`, because defuss-dbsonl 0.7.0 runs only scans without one in its
worker pool, and no byte budget it could apply: the provider would count encoded frame bytes,
DataView counts its own row estimate, and those are different budgets. DataView measures every
emitted row once with the request's `sizeOf`, checks `maxRowBytes`, and yields a native batch
over `maxBatchBytes` as spans that fit. A provider cannot report a size, and no native metadata
bypasses checks.

The first 4,096 rows come from a scan with that `limit`, which defuss-dbsonl runs in the calling
thread while the limit is below its pool threshold (5,000 rows by default); the rest come from a second scan of the same snapshot starting at the last key read, with
that row skipped, so a short page never starts the pool. VERIFIED: without the prefix, a first
page of 50 over 100,000 file rows took 15 ms instead of 1.5 ms, about the decoding time of 4,800
rows in one thread (defuss-dbsonl 0.7.0, 2026-11-20). A provider that ignores `limit` returns every row from the first scan, and the
second scan then yields nothing new.
