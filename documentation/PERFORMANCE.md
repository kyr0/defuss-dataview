# Performance design

The full table/tree, typed comparison, selection, snapshot, pagination, counting,
cancellation and resource-limit features remain available. Runtime exports have
zero package dependencies. Version 0.5.0 targets sorted pages, repeated immutable
queries and index construction; it does not claim universal optimality.

| Mechanism | Selection and invariant |
| --- | --- |
| Shallow flat top-k | At least 1024 rows and offset + pageSize at most n/16; stable ordinals, exact counts and native reverse-run fallback. A heuristic for selective inputs was measured and rejected. |
| Compiler/scratch cleanup | Comparator closures are created only for arities that use them. Warm numeric cache spans no longer allocate an unused scanner scratch array. |
| Columnar index projection | Explicit cacheSortKeys:true extracts one array per sort field, sorts a Uint32 row permutation and materializes reordered references. Removes per-row decorated objects and per-row key arrays. |
| Persistent key cache | Optional source-owned columns, exact revision/field identity, pinned leases, shared cancellable builds and admission before allocation. Generic comparison handles missing capacity. |
| Segmented LRU | Default cache policy; bounded first-touch history and second-touch promotion avoid one-off pollution and new-hot-set thrashing. |
| TinyLFU-style admission | Optional Bloom doorkeeper and aging frequency sketch can avoid many rebuilds; slower adaptation/uncached work can offset those savings. |
| Block summaries | Optional min/max and scalar Bloom metadata prove only nonmatches. Current whole-batch validation, row/byte/scan limits and exact counts still run. No storage-read skipping. |

For API, accounting, lifetime and semantic details see KEY-CACHE.md. Cache policies
are explicit workload choices rather than an automatic promise of higher speed.
Exact equality uses the real predicate after Bloom positives. Hash collisions can
change cache admission efficiency, never payload identity or query results.

## Existing memory scopes

Immutable membership copies at create/replace and pins on open. The separate default
byte-accounting cache holds at most maxCachedBytes (64 MiB), charging 8 bytes per row.
It allocates lazy 4096-row pages; custom estimators bypass it. prepare() yields every
16384 rows. Warm scans can lend numeric spans privately; public arrays remain fresh.
Old revisions live while pinned. Map/VM overhead and caller-owned values are separate.

An index build is synchronous O(n + m log m), with defaults maxIndexRows=1,000,000 and
maxIndexBytes=64 MiB at 8 bytes per retained row reference. Optional transient key
projection defaults to maxSortKeyBytes=16 MiB and charges, for nonempty m matches and
s sorters, `m * (12 + 8*s) + 64 + 32*s` bytes. This includes key slots, Uint32 indices,
reordered row references and fixed headers. Row values are referenced, not cloned;
native sorting and VM scratch are separate. Projection falls back if the cap is too
small. sortKeyBytes reports the transient accounted build allocation, released before
return. Failed replacement leaves the published revision intact.

Persistent keyCache is independent of transient index projection. Its default column
cap is 32 MiB, shared across live old/new revisions and concurrent reservations.
Popularity metadata is bounded separately. See KEY-CACHE.md for exact formulas,
block-summary payload and pin/eviction rules. Retained memory and cumulative allocation
are different measurements; fewer builds do not necessarily mean lower query latency.

Stream candidates still charge row size + 32 bytes; admitted replacements reuse the
root only after safely subtracting old bytes and checking the new total. Source,
input/output, collection and sorted retention are separate scopes. These accounting
limits do not bound physical JavaScript heap usage.

DBSONL (`benchmark:dbsonl`, 100,000 documents, median of 7 runs alternating both packages,
2026-11-20, M5 Max, Node.js 26, both packages through the current adapter):

| Storage | Workload | defuss-dbsonl 0.6.0 | defuss-dbsonl 0.7.0 |
| --- | --- | ---: | ---: |
| memory | `snapshot.scan()` | 286 ms | 291 ms |
| memory | `snapshot.scanBatches()` | 221 ms | 213 ms |
| file | `snapshot.scan()` | 376 ms | 303 ms |
| file | `snapshot.scanBatches()` | 344 ms | 110 ms |
| memory | filter + top-50, exact count | 291 ms | 295 ms |
| file | filter + top-50, exact count | 378 ms | 148 ms |
| memory | first page of 50 | 1.9 ms | 1.6 ms |
| file | first page of 50 | 1.9 ms | 1.8 ms |

On file storage, 0.7.0 runs a `scanBatches()` call without `sizeOf` over at least 5,000 rows in
a pool of worker threads, which decode their key ranges in parallel; the calling thread still receives every row. The
adapter passes no `sizeOf` for that reason, measures each row itself, and reads the first 4,096
rows in the calling thread, so a first page never starts the pool. VERIFIED: paired against the
previous adapter, which passed its `sizeOf`, on 0.7.0 file storage, filter + top-50 took 0.53× of
the time, and first pages and memory storage did not change (ratios 0.89 to 1.02). The
adapter keeps per-row validation, and no storage format, I/O pruning or unbounded decoded-value
cache is added.

## Reproduction and interpretation

```sh
bun install --frozen-lockfile
bun run check                 # includes the website timings (scripts/site-metrics.mjs)
bun run benchmark:paired -- <previous release>/package/dist/index.mjs
bun run benchmark:stream
bun run benchmark:cache       # also under Bun: bun scripts/benchmark-cache-policies.mjs
bun run benchmark:compare     # table/tree API against upstream 0.3.1
node examples/cached-queries.mjs
```

Run benchmarks without concurrent builds or tests. Host load outside these processes
is not controlled, and raw variance limits precision. Every benchmark checks complete
results outside its timed region; input construction is excluded.

## Measurements for 0.5.0

VERIFIED: measured on 2026-11-15 on an Apple M5 Max (18 cores) with Node.js v26.13.0
on macOS, with no other build or test running. These are observations on one machine,
not guarantees.

Paired against the published 0.4.0 (`benchmark:paired`, two runs, alternating calls,
3 warmups, median of 11; 5 at 1,000,000 rows):

| Scenario | 0.5.0 time / 0.4.0 time |
| --- | ---: |
| List filter + sort + page, 100,000 rows | 0.07–0.09 |
| Balanced tree, all open + page, 100,000 rows | 0.28–0.30 |
| Balanced tree, filter + sort siblings + page, 100,000 rows | 0.38–0.45 |
| Chain, all open + page, depth 100,000 | 0.34–0.40 |
| Balanced tree, all open + page, 1,000,000 rows | 0.31–0.33 |

Sorted flat pages gain from stable top-k. Trees gain from three changes in `src/tree.ts`,
which a paired run against the build before them put at 0.26–0.41 of its time:

- Finite numeric IDs index a `Map<number, number>` by value. `JSON.stringify` is
  injective on finite numbers except `-0`/`0`, which a Map's SameValueZero also joins,
  so this is the same identity as the canonical string key without hashing one fresh
  string per row. Their strings are built only when expansion state needs them.
- The ID index is filled backwards, so the first duplicate wins with one Map write per
  row instead of `has()` plus `set()`.
- The traversal pushes onto two `Int32Array` stacks instead of one object per visited
  node. After cycle cutting each row is pushed at most once, so `rows.length` bounds the
  stacks. The profile before this change spent 13% in garbage collection.

String and object IDs keep the canonical string index, and the documented identity
rules are tested in `src/regressions.test.ts`.

Stream executor (`benchmark:stream`, two warmups, median of seven):

| Scenario | 100,000 rows | 1,000,000 rows |
| --- | ---: | ---: |
| Array full sort (reference) | 3.3 ms | 32 ms |
| Stream top-50, generic accounting | 19 ms | 161 ms |
| Stream top-50, fixed-schema `sizeOf` | 6.7 ms | 49 ms |
| Stream early page (first 50 of 100 scanned) | 0.15 ms | 0.71 ms |

Generic accounting walks every row value to charge bytes; a pure fixed-schema `sizeOf`
removes most of that cost, which is why the executor accepts one.

Key cache policies (`benchmark:cache`, one warmup, median of five, same column cap):

| Trace | Off | SLRU | TinyLFU |
| --- | ---: | ---: | ---: |
| Hot reuse | 159 ms | 37 ms | 38 ms |
| Changing hot set | 169 ms | 42 ms | 55 ms |
| Full hot-set scan | 334 ms | 150 ms (48 builds) | 197 ms (3 builds) |
| Scan pollution | 247 ms | 140 ms (48 builds) | 185 ms (3 builds) |

SLRU is the default because it had the lower latency in every trace. TinyLFU rebuilt
columns 3 times instead of 48 in the scan-heavy traces, so it stays available where
rebuild and allocation churn matter more than latency.

Binary values compare with a scalar byte loop. VERIFIED: in `bun run benchmark:binary`
on the same machine the word-sized variant took 0.11× of the scalar time for early
mismatches but 1.81× for 4 KiB values that differ at the end, and the unrolled variants
ranged from 0.88× to 1.28×. No variant wins every case, so the runtime keeps the scalar
loop; no SIMD, WASM or runtime code generation is used. Browser gates use a real
Chromium engine. Speed on Safari, Firefox, Linux and Windows is unverified. Browser
scripts honor `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and `PLAYWRIGHT_CHROMIUM_ARGS`.
