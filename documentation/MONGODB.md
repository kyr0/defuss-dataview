# Comparison with MongoDB

This page compares defuss-dataview with MongoDB on the same documents and queries: dataview over rows already in memory, with and without a fixed-query index, dataview over defuss-dbsonl storage, and MongoDB with and without a secondary index. These numbers come from one machine and one MongoDB setup. They show where each design spends its time, not which product is faster in general.

## Setup

VERIFIED: `bun run benchmark:mongodb -- <rows>` on 2026-11-17: Apple M5 Max, macOS (Darwin 25.6.0), Node.js v26.13.1, MongoDB 9.0.8 standalone with WiredTiger over loopback, Node driver 7.8.0, defuss-dbsonl 0.6.0, whose `scanBatches` the adapter uses.

- **Documents:** `{ key, title, score, tags, at }`, where `key` is `doc:00000000` onward, `score` is `(i * 7919) % 1000`, `tags` is a two-string array and `at` a Date. MongoDB stores `key` as `_id` as well; DBSONL stores each document under its key.
- **Top query:** `score >= 500`, sorted by `score` descending then `key`, the first 50 rows, plus the exact number of matches (half of all documents).
- **Page query:** the first 50 documents in key order.
- **Engines:**
  - **dataview + immutable array:** `evaluateStream` over `createImmutableArraySource(docs)` after `prepare()`. The source declares key order, because the rows are generated in it.
  - **dataview fixed-query index:** `createIndexedArraySource(docs, descriptor)` built once per query, before timing; a page is `readPage({ limit: 50 })` and the exact count is the index's `count`.
  - **dataview + DBSONL:** `evaluateStream` over `createDbsonlSource(db)` on memory and on file storage.
  - **dataview + DBSONL file, same revision:** the same file storage through `createDbsonlSource(db, { projection: { fields: ['value.score'] } })` after `prepare()`, which scans once and keeps key, revision and `value.score` of that revision. No write happens during the timed rounds, so every query runs over the copies and reads only the 50 stored rows it returns.
  - **MongoDB:** `countDocuments` and `find().sort().limit(50)`, issued together as an application would.
  - **MongoDB + index:** the same, with an index on `{ score: -1, key: 1 }`.
- **Method:** one warmup run per engine that also checks that every engine returns the same 50 keys and the same count; then 7 rounds alternating the engines, with a garbage collection before each timed call. The tables show medians.
- **Website:** the comparison on the project website pairs only repeated, warm queries: the array source, the fixed-query index and, for storage on disk, DBSONL at an unchanged revision, against MongoDB after its warm-up. The full DBSONL scans below are the first query after a write; the website lists that cost with the preparation steps.

## Results

Top query (filter, sort, first 50, exact count):

| Engine | 100,000 documents | 1,000,000 documents |
| --- | ---: | ---: |
| dataview + immutable array | 7.5 ms | 76 ms |
| dataview fixed-query index | 0.12 ms | 0.13 ms |
| dataview + DBSONL memory | 260 ms | 2547 ms |
| dataview + DBSONL file | 318 ms | 3191 ms |
| dataview + DBSONL file, same revision | 17 ms | 80 ms |
| MongoDB | 30 ms | 166 ms |
| MongoDB + index | 7.0 ms | 32 ms |

Page query (first 50 by key):

| Engine | 100,000 documents | 1,000,000 documents |
| --- | ---: | ---: |
| dataview + immutable array | 0.10 ms | 0.13 ms |
| dataview fixed-query index | 0.10 ms | 0.12 ms |
| dataview + DBSONL memory | 1.8 ms | 2.0 ms |
| dataview + DBSONL file | 1.7 ms | 1.9 ms |
| dataview + DBSONL file, same revision | 0.77 ms | 1.1 ms |
| MongoDB | 0.95 ms | 1.2 ms |
| MongoDB + index | 0.95 ms | 1.1 ms |

Preparing the data, once before any query: loading in batches of 5,000 (including index creation for the indexed collection), and building each fixed-query index with `prepare()`:

| Step | 100,000 documents | 1,000,000 documents |
| --- | ---: | ---: |
| Load DBSONL memory | 315 ms | 3098 ms |
| Load DBSONL file | 439 ms | 4414 ms |
| Load MongoDB | 242 ms | 1873 ms |
| Load MongoDB + index | 295 ms | 2368 ms |
| Keep the DBSONL file projection of `value.score` | 343 ms | 4478 ms |
| Build dataview index for the top query | 52 ms | 613 ms |
| Build dataview index for the page query | 41 ms | 423 ms |

The tables show one run per size. VERIFIED: across three runs with defuss-dbsonl 0.5.0 on 2026-11-16, top-query times varied by up to 32% and load times by up to 1.5×. Page-query times, all under 5 ms, varied by up to 1.8×, so compare them only by order of magnitude. In the first run the array source did not declare key order; it then sorted the whole array for the page query, taking 10 ms at 100,000 documents and 58 ms at 1,000,000.

## What the numbers show

**Rows in memory, no index.** dataview over an immutable array answered the top query in 0.25× (100,000 documents) and 0.46× (1,000,000) of MongoDB's time without an index. Both scan every document; dataview does it in process on JavaScript objects, while MongoDB reads its storage and answers over a socket.

**MongoDB with an index.** The index made MongoDB 1.1× (100,000) and 2.4× (1,000,000) faster than dataview's in-memory scan. VERIFIED: `explain` on a throwaway collection shows why: with the index, `find` is `IXSCAN` then `FETCH` of only 50 documents, and the count is a `COUNT_SCAN` on the index. Without it, both are a `COLLSCAN`, and the find adds a `SORT`. A scan costs time in proportion to every document; the index costs time in proportion to the 50 returned documents and the counted index entries.

**dataview's fixed-query index.** It answered the top query 58 times (100,000) and 237 times (1,000,000) faster than MongoDB with its index, because it stores that query's matches already filtered and sorted in process: the count is its length and a page is a slice. The cost is that it serves only the query it was built for. `score >= 600`, another sort or changed rows need a new build, which took 52 ms at 100,000 documents and 613 ms at 1,000,000. MongoDB's index on `score` serves every range on `score` and stays current as documents change.

**dataview over DBSONL.** A full DBSONL query took 8.5 to 19 times as long as MongoDB without an index, about 2.6 to 3.2 µs per document; with defuss-dbsonl 0.5.0 it was 20 to 34 times and about 6 µs. VERIFIED: in the paired run in [PERFORMANCE.md](PERFORMANCE.md), reading 100,000 documents with `scanBatches` alone took 179 ms (memory) and 241 ms (file), against 246 and 310 ms for the whole query, so most of the time is DBSONL decoding, checking and reading each DSON frame, and dataview's filter, top-k and accounting add about 0.7 µs per row. DBSONL keeps no secondary index either, so every filter on a value field reads every document.

**DBSONL at the same revision.** With a projection of `value.score`, the top query took 17 ms (100,000) and 80 ms (1,000,000): 19 and 40 times less than the full scan of the same file storage, and 1.8 and 2.1 times less than MongoDB without an index. It runs the same predicates and comparator over copies of key, revision and `value.score`, then reads the 50 returned documents by key from the query's snapshot. Keeping the copies took 1.1 (100,000) and 1.4 (1,000,000) times a full query, and it lasts only until the next write: any commit changes the revision, and the next query scans again. On the page query the projection was 1.1 to 1.2 times faster than MongoDB, a margin the run-to-run variation above can reverse. [SOURCES.md](SOURCES.md#projection-of-one-revision) lists when a query uses the copies.

**Pages in key order.** Every engine answers the page query in a few milliseconds at both sizes, because it stops after 50 rows: DBSONL and MongoDB walk their key index, and the array source stops once the declared order guarantees the first 50.

**Loading.** DBSONL took 1.3 to 2.4 times as long as MongoDB without an index to load. DBSONL file storage flushes every batch to disk before acknowledging it. The script leaves MongoDB's default write concern unchanged, and this page does not claim how durable MongoDB's acknowledgement was.

## Choosing

| Situation | Use | Why |
| --- | --- | --- |
| A query that repeats unchanged over rows that rarely change: a default grid view, a dashboard tile, a saved filter | dataview fixed-query index | Sub-millisecond pages with an exact count, after one build per query and per data change |
| Ad-hoc filters and sorts over rows already in memory: a grid's data, a cache, a worker's dataset | dataview over an immutable array | 8 ms at 100,000 rows and 76 ms at 1,000,000 for any filter and sort, faster than MongoDB without an index, and no server |
| Ad-hoc range queries over a large collection that is stored, shared or changing | MongoDB with an index on the filtered and sorted fields | One index serves every range on its fields and stays current; give dataview the resulting page |
| DBSONL as the store, queries changing more often than the data | A projection of the fields the queries read | Small pages at an unchanged revision run over the copies (80 ms at 1,000,000 documents); the first query after each write still scans every document |
| DBSONL as the store, writes between most queries | Key ranges (`gte`/`lt`) and key order, which stop early | Full filters over value fields cost about 3 µs per document |

dataview deliberately has no general secondary index: database planners own index choice, and dataview runs the exact predicates ([README](../README.md#execution-counts-and-limits)).

## Reproduce

```sh
bun run build
MONGODB_URL=mongodb://127.0.0.1:27017 bun run benchmark:mongodb -- 100000
bun run benchmark:mongodb -- 1000000   # the npm script allows Node an 8 GB heap
```

The script creates the database `defuss_dataview_bench_<pid>`, drops it when it finishes or fails, and touches no other database. Results go to `artifacts/benchmark-mongodb.json`. Run it on an idle machine; another process using the CPU or the MongoDB server changes the numbers.
