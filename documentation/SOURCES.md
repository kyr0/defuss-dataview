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

`createDbsonlSource(db, {gte?, lt?})` accepts a structural `beginRead()` interface. Each result row is `{key, value, revision}`; paths into stored documents start with `value.`. It neither spreads user values nor reserves application field names. It preserves undefined, scalar, cyclic and binary application values without conversion.

`beginRead()` gives snapshot `revision`, whole-store `count`, `scan()` and `close()`. The adapter uses whole-store count only without range bounds. `key asc` uses the same deterministic code-unit comparator as the default DataView ordering. Descending or locale key sorting falls back to global sorting. No predicate/limit pushdown is inferred: pushing a limit before filtering would change results. When scanBatches is present, the adapter passes bounded native batch options and independently validates emitted records. Otherwise it groups the row iterator into batches.

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


The optional structural `scanBatches({gte?, lt?, signal?, batchSize?, maxBatchBytes?,
sizeOf?})` returns async arrays of records. The native provider must honor row/byte
construction bounds and ownership. DataView passes a sizeOf callback that also
checks maxRowBytes and records each size against the row object it measured. For an
emitted row it reuses that size; a row it did not measure (another object, or one the
provider sized without the callback) is measured on arrival. A provider cannot report a
size, but one that mutates a row after measuring it can understate it, as it could by
mutating after emission. No native metadata bypasses checks.
defuss-dbsonl's default batch accounting uses encoded frame bytes;
DataView explicitly supplies decoded row accounting. These are different budgets.
