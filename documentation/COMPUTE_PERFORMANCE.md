# Compute performance

`bun run benchmark:compute` runs the built package through the core scenarios of the plan's benchmark matrix and writes raw samples to `artifacts/compute-benchmark.json`. Before timing, it checks every variant's result against a handwritten loop. Each round runs every variant once in rotated order, so machine drift affects all of them alike. Input construction and `prepareKeys` stay outside the timed section; opening the source, validating its rows, computing and collecting output stay inside.

VERIFIED: the figures below are medians of 9 rounds after 2 warmups over 200,000 rows on an Apple M5 Max with Node.js 26.13.1, measured 2026-11-17. Unless noted, rows have 64 fields and the runs pass a fixed `sizeOf`. Compare figures only within one run on one machine.

## Results

| Scenario | Handwritten loop | Compute, row reads | Compute, prepared columns | Other |
| --- | --- | --- | --- | --- |
| B03 top 50 by `amount`, select 4 | 164.1 ms (full sort) | 58.5 ms | 55.4 ms | stream query + map 54.8 ms |
| B07 scalar `sum` | 18.9 ms | 32.2 ms | 6.2 ms | |
| B07 scalar, 16 measures | 18.8 ms | 66.4 ms | 12.7 ms | |
| B10 sum of cancelling magnitudes | | | | sequential 7.3 ms, compensated 7.9 ms |
| B11 group `sum`/`count`, G=16 | Map 26.5 ms | 57.4 ms | 11.8 ms | compact-table probe 26.1 ms |
| B11 group `sum`/`count`, G=1,000 | Map 28.3 ms | 59.4 ms | 14.0 ms | compact-table probe 25.5 ms |
| B11 group `sum`/`count`, G=100,000 | Map 55.5 ms | 150.1 ms | 86.9 ms | compact-table probe 42.9 ms |
| B14 group by 3 fields | joined-string Map 59.7 ms | 67.5 ms | | |
| B16 groups over a key-sorted source, limit 20 | | hash 13.3 ms | ordered groups 10.8 ms | |
| B19 G=100,000, ORDER BY sum, limit 20 | full sort 69.4 ms | 110.8 ms | | |
| B22 filtered top 50 plus 5 totals | 74.6 ms | view 54.4 ms | | two compute scans 93.4 ms |
| B26 group G=16 by source | | copied 64.9 ms, immutable 72.8 ms | 12.4 ms | |

## What the numbers say

Reading fields from row objects is the main cost. A compute plan reads a field as `row[key]`, with `key` fixed when the plan is prepared, behind an own-property check. VERIFIED: on these 64-field rows, two keyed reads per row took 25.0 ms against 14.9 ms for the same two reads written as `row.amount` and `row.qty`, and the own-property check added 2 ms more (2026-11-17, same machine). A handwritten loop gets the named access for free. Compute could only match it by generating code, and `new Function` fails under a Content-Security-Policy without `unsafe-eval`, which the browser test enforces. Prepared columns avoid row reads entirely: with `prepareKeys` on the fields a plan reads, scalar and grouped plans ran 2 to 5 times faster than the row path and faster than the handwritten loops.

A view computes the page and its totals in one scan: 54.4 ms against 93.4 ms for two compute plans and 74.6 ms for the handwritten pair of loops.

Compensated summation cost 0.6 ms over 200,000 rows (7.9 against 7.3 ms), so it stays the default.

## Strategy decisions

The plan ships an optional strategy only when it saves at least 10% latency on its workload family.

- Ordered groups ship. VERIFIED: B16 took 10.8 ms against 13.3 ms with hashing (19% less), and they hold one group at a time instead of all of them. They run only with the certificate described in COMPUTE_ARCHITECTURE.md.
- A compact open-addressed table does not ship. VERIFIED: as a standalone loop it matched Map at 16 and 1,000 groups and was 23% faster at 100,000 groups with single finite-number keys. HYPOTHESIS: inside a plan, Map lookups are a minority of the 150 ms for that case, so the table would save less than the 10% gate, and only for one key type and cardinality. Falsifier: an implementation behind `GroupTable` that cuts B11 at G=100,000 by 10% or more without slowing G=16.
- Dense-domain grouping is not implemented; no measurement supports it yet.
- Compute spawns no workers. `partial()` and `merge()` let an application split a scan; the measurements below show where that pays.

## Exact sums and partial aggregation

VERIFIED: from one run of `bun run benchmark:compute` on 2026-11-20 (Apple M5 Max, Node.js 26.13.1, 200,000 rows of 64 fields, or 100,000 DBSONL documents of 6 fields for B33, medians of 9 rounds, defuss-dbsonl 0.7.0). Compare these figures with each other, not with the table above, which comes from an earlier run.

| Scenario | Variants |
| --- | --- |
| B10 sum of cancelling magnitudes | sequential 8.1 ms, compensated 8.4 ms, exact 15.4 ms |
| B30 group `sum`/`count`, G=1,000 | compensated 82.1 ms, exact 88.9 ms; with prepared columns 15.2 and 20.6 ms |
| B31 G=1,000, one pass against 4 parts plus merge | one pass 89.0 ms; parts in one thread 89.5 ms, also cloned 91.1 ms; 4 worker threads 24.3 ms |
| B32 G=100,000, the same | one pass 179.4 ms; parts in one thread 216.3 ms, also cloned 229.8 ms; 4 worker threads 115.9 ms |
| B33 DBSONL file, G=1,000, one pass against partials over `split()` ranges | one pass without the scan pool 261.6 ms, with defuss-dbsonl's pool 118.9 ms; 4 worker threads 86.9 ms; 8 worker threads 26.7 ms |

`'exact'` costs 8% on B30 when reading rows dominates, and 36% with prepared columns, where the kernel dominates. In a sum-only kernel it costs about 1.8× as much as compensation, because every addition walks a short list of terms. With few groups, the partial stage and the merge cost less than 1% over one pass, and a structured clone of the partials added about 2% more. Four worker threads then took about a quarter of the one-pass time. With 100,000 groups, each part holds 50,000, and the merge folds all 200,000 partial groups in one thread. That costs 21% over one pass and limits four workers to 1.55×.

B31 and B32 exclude worker startup (210 to 230 ms here) and the rows: each worker generated its own slice before timing. In B33 each worker opened its own file backend with `io: 'sync'` and its database handle before timing (40 to 65 ms), as a long-lived worker would. A timed round pins one snapshot, splits it, has every worker compute the partial of its range at that head, and merges. With storage, decoding runs in the workers too: eight workers took a tenth of the one-pass time without the pool and 0.22 of it with the pool, which decodes in its workers but returns every row to the calling thread.

VERIFIED: a one-off probe that timed each worker's partial over the same database measured 2.6 to 3.0 µs per row with 2 to 6 workers and 2.0 µs with 8. UNKNOWN: why the time per row drops at 8 workers. In B33, four workers took 0.73 of the pool's time and eight took 0.22.

## Against MongoDB

VERIFIED: over 1,000,000 of the website's seeded orders, the five compute panel plans took 1.6× to 4.4× less time with row reads than the faster of MongoDB 9.0.8's aggregation pipelines with and without indexes; with prepared columns they took 62 to 94 ms against 126 to 309 ms (2026-11-17, `bun run benchmark:mongodb-compute`). MONGODB.md has the table and what the comparison does and does not measure.

## Row queries

VERIFIED: paired runs of the v0.5.0 build against this build, alternating in three fresh processes over 200,000 rows, put every stream query (top-k with exact count, early page, full scan; copied, immutable and key-cached sources) within 0.98 to 1.01 of v0.5.0, apart from cases under 0.2 ms. `prepareKeys` first measured 1.10 because the key cache recorded column domains during each build; domains are now derived on first use, and the rerun measured 0.77 to 0.90.
