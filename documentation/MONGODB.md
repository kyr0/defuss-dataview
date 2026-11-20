# Comparison with MongoDB

This page compares defuss-dataview with MongoDB on the same documents and queries: dataview over rows already in memory, with and without a fixed-query index, dataview over defuss-dbsonl storage, and MongoDB with and without a secondary index. These numbers come from one machine and one MongoDB setup. They show where each design spends its time, not which product is faster in general.

## Setup

VERIFIED: `bun run benchmark:mongodb -- <rows>` on 2026-11-20: Apple M5 Max, macOS (Darwin 25.6.0), Node.js v26.13.1, MongoDB 9.0.8 standalone with WiredTiger over loopback, Node driver 7.8.0, defuss-dbsonl 0.7.0. WiredTiger's cache was configured for 25.2 GB. Every DBSONL handle opens with a 64 MiB, 8,192-page cache instead of the default 8 MiB and 1,024 pages ([SOURCES.md](SOURCES.md#one-snapshot-across-workers) has the measurement).

- **Documents:** `{ key, title, score, tags, at }`, where `key` is `doc:00000000` onward, `score` is `(i * 7919) % 1000`, `tags` is a two-string array and `at` a Date. MongoDB stores `key` as `_id` as well; DBSONL stores each document under its key.
- **Top query:** `score >= 500`, sorted by `score` descending then `key`, the first 50 rows, plus the exact number of matches (half of all documents).
- **Page query:** the first 50 documents in key order.
- **Engines:**
  - **dataview + immutable array:** `evaluateStream` over `createImmutableArraySource(docs)` after `prepare()`. The source declares key order, because the rows are generated in it.
  - **dataview fixed-query index:** `createIndexedArraySource(docs, descriptor)` built once per query, before timing; a page is `readPage({ limit: 50 })` and the exact count is the index's `count`.
  - **dataview + DBSONL:** `evaluateStream` over `createDbsonlSource(db)` on memory and on file storage. On file storage, defuss-dbsonl reads all but the first 4,096 rows in its pool of worker threads.
  - **dataview + DBSONL file, 8 workers:** each query pins one snapshot, cuts it into 8 key ranges with `session.split(8)`, and has 8 worker threads answer it over one range each, at that head, with `offset: 0`, `limit: 50` and the exact count. The calling thread merges the parts with `evaluateStream` over their rows and adds the counts ([SOURCES.md](SOURCES.md#one-snapshot-across-workers)). Each worker opened its file backend with `io: 'sync'` and its database handle before timing, as a long-lived worker would.
  - **dataview + DBSONL file, same revision:** the same file storage through `createDbsonlSource(db, { projection: { fields: ['value.score'] } })` after `prepare()`, which scans once and keeps key, revision and `value.score` of that revision. No write happens during the timed rounds, so every query runs over the copies and reads only the 50 stored rows it returns.
  - **MongoDB:** `countDocuments` and `find().sort().limit(50)`, issued together as an application would.
  - **MongoDB + index:** the same, with an index on `{ score: -1, key: 1 }`.
- **Method:** one warmup run per engine that also checks that every engine returns the same 50 keys and the same count; then 7 rounds alternating the engines, with a garbage collection before each timed call. The tables show medians.
- **Website:** the comparison on the project website pairs only repeated, warm queries: the array source, the fixed-query index and, for storage on disk, DBSONL at an unchanged revision, against MongoDB after its warm-up. The full DBSONL scans below are the first query after a write; the website lists that cost with the preparation steps and states the 8-worker time beside MongoDB's.

## Results

Top query (filter, sort, first 50, exact count):

| Engine | 100,000 documents | 1,000,000 documents |
| --- | ---: | ---: |
| dataview + immutable array | 9.2 ms | 63 ms |
| dataview fixed-query index | 0.14 ms | 0.16 ms |
| dataview + DBSONL memory | 197 ms | 2968 ms |
| dataview + DBSONL file | 151 ms | 1395 ms |
| dataview + DBSONL file, same revision | 11 ms | 82 ms |
| dataview + DBSONL file, 8 workers | 32 ms | 291 ms |
| MongoDB | 33 ms | 169 ms |
| MongoDB + index | 5.3 ms | 33 ms |

Page query (first 50 by key):

| Engine | 100,000 documents | 1,000,000 documents |
| --- | ---: | ---: |
| dataview + immutable array | 0.12 ms | 0.13 ms |
| dataview fixed-query index | 0.13 ms | 0.12 ms |
| dataview + DBSONL memory | 2.0 ms | 1.9 ms |
| dataview + DBSONL file | 1.9 ms | 2.0 ms |
| dataview + DBSONL file, same revision | 0.80 ms | 0.83 ms |
| dataview + DBSONL file, 8 workers | 1.9 ms | 2.0 ms |
| MongoDB | 1.3 ms | 1.2 ms |
| MongoDB + index | 1.4 ms | 1.3 ms |

Preparing the data, once before any query: loading in batches of 5,000 (including index creation for the indexed collection), building each fixed-query index with `prepare()`, and opening the workers' handles:

| Step | 100,000 documents | 1,000,000 documents |
| --- | ---: | ---: |
| Load DBSONL memory | 342 ms | 3550 ms |
| Load DBSONL file | 391 ms | 4260 ms |
| Load MongoDB | 269 ms | 1932 ms |
| Load MongoDB + index | 299 ms | 2466 ms |
| Keep the DBSONL file projection of `value.score` | 221 ms | 2004 ms |
| Open 8 worker threads with a handle on the DBSONL file | 72 ms | 78 ms |
| Build dataview index for the top query | 60 ms | 674 ms |
| Build dataview index for the page query | 44 ms | 440 ms |

The tables show one run per size. VERIFIED: across three runs with defuss-dbsonl 0.5.0 on 2026-11-16, top-query times varied by up to 32% and load times by up to 1.5×. Page-query times, all under 5 ms, varied by up to 1.8×, so compare them only by order of magnitude. In the first run the array source did not declare key order; it then sorted the whole array for the page query, taking 10 ms at 100,000 documents and 58 ms at 1,000,000.

## What the numbers show

**Rows in memory, no index.** dataview over an immutable array answered the top query in 0.28× (100,000 documents) and 0.37× (1,000,000) of MongoDB's time without an index. Both scan every document; dataview does it in process on JavaScript objects, while MongoDB reads its storage and answers over a socket.

**MongoDB with an index.** The index made MongoDB 1.7× (100,000) and 1.9× (1,000,000) faster than dataview's in-memory scan. VERIFIED: `explain` on a throwaway collection shows why: with the index, `find` is `IXSCAN` then `FETCH` of only 50 documents, and the count is a `COUNT_SCAN` on the index. Without it, both are a `COLLSCAN`, and the find adds a `SORT`. A scan costs time in proportion to every document; the index costs time in proportion to the 50 returned documents and the counted index entries.

**dataview's fixed-query index.** It answered the top query 37 times (100,000) and 210 times (1,000,000) faster than MongoDB with its index, because it stores that query's matches already filtered and sorted in process: the count is its length and a page is a slice. The cost is that it serves only the query it was built for. `score >= 600`, another sort or changed rows need a new build, which took 60 ms at 100,000 documents and 674 ms at 1,000,000. MongoDB's index on `score` serves every range on `score` and stays current as documents change.

**dataview over DBSONL.** A full DBSONL query in one thread took 4.5 (100,000) and 8.2 (1,000,000) times as long as MongoDB without an index on file storage, about 1.4 to 1.5 µs per document, and 6.0 and 18 times on memory storage, about 2 to 3 µs. defuss-dbsonl 0.7.0 decodes file storage in its own worker threads; on 0.6.0 the file query took 3.2 µs per document. VERIFIED: in the paired run in [PERFORMANCE.md](PERFORMANCE.md), reading 100,000 documents with `scanBatches` alone took 213 ms (memory) and 110 ms (file), against 295 and 148 ms for the whole query. Most of the time is DBSONL decoding; dataview's filter, top-k and row accounting add 0.4 to 0.8 µs per row, most of it the default row-size estimate: on memory storage a constant `sizeOf` took 236 ms instead of 306 ms (one-off probe, 2026-11-20). DBSONL keeps no secondary index either, so every filter on a value field reads every document.

**DBSONL in 8 workers.** Without a projection, as after any write, 8 worker threads answered the top query in 32 ms (100,000) and 291 ms (1,000,000), 4.7 and 4.8 times less than the file query in one thread. That is about MongoDB's time without an index at 100,000 documents (33 ms) and 1.7 times as long at 1,000,000 (169 ms). At 1,000,000 each worker decoded 125,000 documents, about 2.3 µs each. The page query gains nothing, because every engine stops after 50 rows.

**DBSONL at the same revision.** With a projection of `value.score`, the top query took 11 ms (100,000) and 82 ms (1,000,000): 13 and 17 times less than the full scan of the same file storage in one thread, and 2.9 and 2.1 times less than MongoDB without an index. It runs the same predicates and comparator over copies of key, revision and `value.score`, then reads the 50 returned documents by key from the query's snapshot. Keeping the copies took 1.5 (100,000) and 1.4 (1,000,000) times a full query in one thread, and it lasts only until the next write: any commit changes the revision, and the next query scans again. On the page query the projection was 1.6 and 1.5 times faster than MongoDB, a margin the run-to-run variation above can reverse. [SOURCES.md](SOURCES.md#projection-of-one-revision) lists when a query uses the copies.

**Pages in key order.** Every engine answers the page query in a few milliseconds at both sizes, because it stops after 50 rows: DBSONL and MongoDB walk their key index, and the array source stops once the declared order guarantees the first 50.

**Loading.** DBSONL took 1.3 to 2.2 times as long as MongoDB without an index to load. DBSONL file storage flushes every batch to disk before acknowledging it. The script leaves MongoDB's default write concern unchanged, and this page does not claim how durable MongoDB's acknowledgement was.

## Choosing

| Situation | Use | Why |
| --- | --- | --- |
| A query that repeats unchanged over rows that rarely change: a default grid view, a dashboard tile, a saved filter | dataview fixed-query index | Sub-millisecond pages with an exact count, after one build per query and per data change |
| Ad-hoc filters and sorts over rows already in memory: a grid's data, a cache, a worker's dataset | dataview over an immutable array | 9 ms at 100,000 rows and 63 ms at 1,000,000 for any filter and sort, faster than MongoDB without an index, and no server |
| Ad-hoc range queries over a large collection that is stored, shared or changing | MongoDB with an index on the filtered and sorted fields | One index serves every range on its fields and stays current; give dataview the resulting page |
| DBSONL as the store, queries changing more often than the data | A projection of the fields the queries read | Small pages at an unchanged revision run over the copies (82 ms at 1,000,000 documents); the first query after each write still scans every document |
| DBSONL as the store, writes between most queries | Key ranges (`gte`/`lt`) and key order, which stop early; for full filters, one worker thread per `split()` range | A full filter costs 1.4 to 3 µs per document in one thread; 8 workers answered 1,000,000 file documents in 291 ms |

dataview deliberately has no general secondary index: database planners own index choice, and dataview runs the exact predicates ([README](../README.md#execution-counts-and-limits)).

## Projection and aggregation

`bun run benchmark:mongodb-compute` compares the five `defuss-dataview/compute` plans of the website's compute panel with the same work written as MongoDB aggregation pipelines (`$group`, `$match`, `$sort`, `$limit`, `$facet`). Both read the seeded orders of the website demo: id, customer, region, product, amount, date and status. Before timing, the script checks every engine's answer against the others; floating-point sums and averages must agree to a relative 1e-9, because the two engines add in different orders. MongoDB runs with and without indexes on `status` and on `region, date`. dataview reads fields from the row objects, or from columns that `prepareKeys()` built once beforehand.

VERIFIED: medians of 7 alternating runs over 1,000,000 orders, Apple M5 Max, Node.js 26.13.1, MongoDB 9.0.8 (WiredTiger), 2026-11-17. All are repeated queries: MongoDB answered from its cache over loopback, dataview from an immutable array in the same process. Preparing columns for all seven fields took 150 ms once.

| Query | dataview, row reads | dataview, prepared columns | MongoDB | MongoDB + indexes |
| --- | --- | --- | --- | --- |
| Group by region: count, paid revenue, average, max | 114 ms | 94 ms | 240 ms | 231 ms |
| Group by region × product, HAVING, top 10 groups | 107 ms | 81 ms | 228 ms | 270 ms |
| Paid orders, computed gross, top 10 by gross | 75 ms | 62 ms | 344 ms | 332 ms |
| EU orders: newest 10 plus totals, one query | 70 ms | 64 ms | 218 ms | 309 ms |
| All orders: count, revenue, average, max | 77 ms | 65 ms | 136 ms | 126 ms |

With row reads, dataview took 1.6× (the global aggregate) to 4.4× (the computed top 10) less time than the faster MongoDB variant; over 100,000 orders the range was 1.3× to 3.8×. The indexes did not help: grouping and the global aggregate read every document either way, the indexed collection was at most 8% faster on three queries, and it was slower on the two whose `$match` the indexes could serve (region × product, 270 against 228 ms; the EU page plus totals, 309 against 218 ms). UNKNOWN: which plans MongoDB chose; the script does not record `explain()` output.

Two differences favour dataview and are part of what it offers rather than an artefact. It runs in the application's process, so results never cross a socket or get decoded from BSON. And it keeps no database: the orders must already sit in memory, which MongoDB does not require, and MongoDB persists and indexes data that dataview never stores.

## Reproduce

```sh
bun run build
MONGODB_URL=mongodb://127.0.0.1:27017 bun run benchmark:mongodb -- 100000
bun run benchmark:mongodb -- 1000000   # the npm script allows Node an 8 GB heap
bun run benchmark:mongodb-compute -- 1000000
```

The script creates the database `defuss_dataview_bench_<pid>`, drops it when it finishes or fails, and touches no other database. The compute comparison uses `defuss_dataview_compute_<pid>` the same way. Results go to `artifacts/benchmark-mongodb.json` and `artifacts/benchmark-mongodb-compute.json`; runs at 100,000 or 1,000,000 rows also update the website's `docs/assets/mongodb.json` and `docs/assets/mongodb-compute.json`. Run it on an idle machine; another process using the CPU or the MongoDB server changes the numbers.
