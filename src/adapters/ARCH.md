# Structural integrations

dbsonl.ts depends only on DataView contracts. A database supplies beginRead(), and each owned snapshot supplies revision/count/scan/close. The adapter batches live records without spreading application values. Whole-store count is omitted for ranges. Only ascending code-unit key ordering is declared. The adapter closes snapshots, never the database. Native/OPFS storage remains an application choice.


The optional scanBatches capability admits native batch pulls while retaining the
row-only fallback. The adapter passes no sizeOf and no byte budget of its own units:
defuss-dbsonl 0.7.0 runs only scans without sizeOf in its worker pool, because a function
cannot cross to a worker, and it would apply a byte budget to encoded bytes, a different
measure that could reject rows the request admits. nativeBatches measures every emitted row
once with the request's sizeOf, checks maxRowBytes and batch length, and yields a native
batch over maxBatchBytes as spans of the same array. The first 4,096 rows come from a scan
with that limit, which the provider runs in the calling thread below its default pool
threshold of 5,000 rows; the rest from a scan of the
same snapshot at the last key read, which skips that row, since the next key can exceed the
key length bound. VERIFIED: on file storage (100,000 rows, 2026-11-20) filter + top-50 with
an exact count took 0.53× of the time of the previous adapter, a first page of 50 stayed at
1.5 ms instead of the 15 ms the pool start costs, and memory storage was unchanged.
Processing and iterator-return failures are aggregated, and outer session cleanup
still runs. The provider owns storage; DataView owns only its read-session lifetime.

`at` pins every execution to one snapshot head, which the adapter passes to beginRead({ at })
unchanged and only checks for being an object. Sources in several workers then read one
snapshot, so their partial aggregates share a revision and merge. The provider decides which
heads it still holds.

The opt-in projection keeps copies of key, revision and configured field paths for one
snapshot revision, recorded while a complete measured scan passes and published only when
that scan ends inside the byte cap. A session whose revision matches registers a private
projection plan (src/stream/projection.ts), bound like measured scans to the session's
original scan method. The executor uses it only for a bounded page whose fields the copies
cover, then fetches the returned rows with snapshot.get() from that same snapshot, so a
returned row is always the stored one at the query's revision. Memory: one copy per row in
the scope while kept, plus the same again while a newer revision is recorded. Security and
privacy: the copies are values already read through the snapshot and never leave the source
object; nothing is written to storage.
