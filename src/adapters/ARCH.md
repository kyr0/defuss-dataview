# Structural integrations

dbsonl.ts depends only on DataView contracts. A database supplies beginRead(), and each owned snapshot supplies revision/count/scan/close. The adapter batches live records without spreading application values. Whole-store count is omitted for ranges. Only ascending code-unit key ordering is declared. The adapter closes snapshots, never the database. Native/OPFS storage remains an application choice.


The optional scanBatches capability admits native batch pulls while retaining the
row-only fallback. Construction uses the adapter's sizeOf, which records each size by row identity;
nativeBatches reuses those sizes, measures any emitted row it did not size, and checks
batch length and byte budget before its private handoff. This calls the user's estimator
once per row instead of twice. VERIFIED: paired against measuring twice, filter + top-50
with an exact count over 100,000 defuss-dbsonl 0.6.0 rows took 0.85× of the time on memory and on file storage.
Processing and iterator-return failures are aggregated, and outer session cleanup
still runs. The provider owns storage; DataView owns only its read-session lifetime.

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
