# Changelog

## 0.10.0

Published on npm on 2026-11-22. It follows 0.9.0, published on npm on 2026-11-21.

### Lists are values

- Under the default `equality: 'value'`, arrays are equal when their elements are pairwise equal, and sort element by element with a proper prefix first, after binary values and before other objects. Filters, sorters, `eq`, `in`, grouping, `distinct`, `countDistinct`, `min`, `max` and `each` all follow; group keys and distinct values that are arrays of primitives, Dates and binary values merge from partials. Before, every array was equal only to itself and tied with every other array, so a stored array never matched a literal one. `equality: 'identity'` keeps that behavior. Array operands of filters and literals are copied, as Dates already were. The ordering id is now `dataview-order-v2`.

### Predicates over arrays

- `some(list, predicateFn)` and `every(list, predicateFn)`. `predicateFn` runs once when the expression is built and receives the element as an expression, so descriptors stay plain data; quantifiers nest, and each level has its own element. A value that is no array gives `false`; an empty array gives `false` and `true`.
- `get(expr, path)` reads a dot path from any value, such as an object element.
- `in`, `contains`, `startsWith` and `endsWith` as expressions, with exactly the results of the filter operators; `typeOf(expr)` names a value's type.

### Calendar

- `dateAdd(date, unit, amount)` and `dateDiff(start, end, unit)` as MongoDB's `$dateAdd` and `$dateDiff`: days and longer keep the local wall clock, months clamp to the month's end, and differences count unit boundaries crossed.
- `dateTrunc` takes `binSize` and `startOfWeek` with MongoDB's alignment from 2000-01-01, and the units `second` and `millisecond`. `datePart` adds `second`, `millisecond`, `dayOfYear`, `isoWeek` and `isoWeekYear`. `toDate(ms)` turns epoch milliseconds back into a Date.
- VERIFIED: `src/compute/calendar.test.ts` replays 3,600 answers of MongoDB 9.0.8 in 11 time zones, recorded by `scripts/mongodb-calendar-fixture.mjs`; `src/compute/dates.test.ts` compares the new units, parts and calendar arithmetic with Temporal. Two documented single-unit `dateTrunc` cases keep the Temporal rule of 0.8.0 where MongoDB differs.

### Numbers, bits and text

- `mod`, `pow`, `sqrt`, `ln`, `exp`, `least` and `greatest`; `bitAnd`, `bitOr`, `bitXor` and `bitNot` on safe integers as 64-bit two's complement or on BigInts.
- `varPop`, `varSamp`, `stdDevPop` and `stdDevSamp` from exact sums of the values and their squares: independent of order and partitioning in every number mode, so they merge from partials.
- `split`, `replaceAll`, `indexOf`, `toText` and `parseNumber`.

## 0.9.0

Published on npm on 2026-11-21. It follows 0.8.0, published on npm on 2026-11-21.

- `epochMs(expr)` gives the epoch milliseconds of a Date, so plans compute durations: `sub(epochMs(end), epochMs(start))`, and `avg`, `max` or `percentile` over it. It reads the operands `dateTrunc` reads: a number in the Date range passes through, nullish operands and invalid Dates give `null`, and other values follow `invalidNumbers`. `sub` and the other arithmetic operators still treat Dates as invalid numbers, so a forgotten `epochMs` throws, or gives `null` under `invalidNumbers: 'skip'`, never `NaN`.

## 0.8.0

Published on npm on 2026-11-21. It follows 0.7.0, published on npm on 2026-11-20.

### Calendar, text and conditional expressions

- `dateTrunc(expr, unit, { timeZone }?)` gives the first instant of a year, quarter, month, ISO week, day, hour or minute as a Date; `datePart(expr, part, { timeZone }?)` gives the year, quarter, month, day, ISO weekday, hour or minute. They read Dates and epoch milliseconds, in UTC by default or in an IANA time zone, and follow Temporal at DST gaps and repeated hours.
- Time zones go through `Intl.DateTimeFormat`, since Node.js 20 to 24 lack Temporal (20.20.2 and 24.22.3 checked). Offsets are cached per UTC day, which is exact because no zone has two transitions less than a day apart: over every zone from 1850 to 2100, the closest two were 167 hours apart. A row allocates no Date until its result.
- `each(expr)` as a whole `groupBy` key unwinds arrays, as MongoDB's `$unwind`: a row joins one group per distinct element and none for an empty array. Its groups hold the elements, so the plan still merges from partials.
- `lower`, `upper`, `trim`, `substring` and `length` (in code points), `concat`, `cond` (only the chosen branch is evaluated), and `floor`, `ceil`, `round` (halves away from zero) and `abs`.

### Measures

- `countDistinct(expr)` and `distinct(expr)` count or list distinct non-nullish values under the equality of group keys. `percentile(expr, p)` and `median(expr)` are exact, interpolated linearly between the closest ranks: the default method of R and NumPy, and Excel's `PERCENTILE.INC`.
- All four merge from partials in every number mode; their partial states carry the values, packed with offsets. Distinct values that compare by identity are rejected in `partial()`, as identity group keys are.
- `bun run benchmark:compute` adds B34 to B36. VERIFIED: medians of 9 rounds over 200,000 rows in memory, Apple M5 Max, Node.js 26.13.1, 2026-11-21, on a host with load 6 to 8. Counting by UTC day with `dateTrunc` took 61 ms, against 56 ms with a numeric day key (`floor(ms / day)`), and by Europe/Berlin day 68 ms. `countDistinct` plus `median` over 1,000 groups took 57 ms.

## 0.7.0

Published on npm on 2026-11-20. It follows 0.6.0, published on npm on 2026-11-17.

### Partial aggregation

- Aggregate plans gain `partial(source, options?)` and `merge(partials, page?, options?)`. A partial is the mergeable state of one part of a snapshot, such as a DBSONL key range. It is plain data that survives `structuredClone` and `postMessage`. Merged in source order, the parts give the single-pass result, including group order and ties.
- `numberMode: 'exact'` sums with Shewchuk's expansion and rounds once, so results do not depend on order, batch size or partitioning. `sum` and `avg` merge only in this mode; count, `min`, `max` and `sumBigInt` merge in every mode.
- `merge()` validates partials as untrusted input: format version, plan signature, one snapshot revision, column shapes and every value. Group keys that group by identity are rejected.
- `explain().strategies` lists `'merge'` for plans that accept both methods; merged summaries report `strategy: 'merge'`.
- `bun run benchmark:compute` adds exact sums and partial merges in one thread and in worker threads (B30 to B33). B33 runs partials in 4 and 8 worker threads over `split()` ranges of one DBSONL file snapshot.

### DBSONL adapter

- Development and tests use defuss-dbsonl 0.7.0.
- `createDbsonlSource(db, { at })` pins every execution to one snapshot head, such as `session.head`, so sources in several workers read the same snapshot and their partials merge.
- Native batch scans pass no `sizeOf` and no byte budget to the provider, so defuss-dbsonl 0.7.0 can run them in its worker pool. The adapter measures each row once and splits a batch over `maxBatchBytes` into spans. The first 4,096 rows are read in the calling thread, so short pages never start the pool. On file storage, filter + top-50 with an exact count over 100,000 rows took 0.53× of the previous time; first pages and memory storage did not change.
- `examples/compute-partials.mjs` runs its partials in four worker threads over `split()` ranges of one file database.
- SOURCES.md documents stream queries over `split()` ranges in worker threads, merged with `evaluateStream` over the parts' rows, and a larger page cache for worker handles: 387 instead of 843 ms for 8 workers over 1,000,000 file documents.

### MongoDB comparison and website

- `bun run benchmark:mongodb` adds an engine that answers each query in 8 worker threads over `split()` ranges of one pinned DBSONL file snapshot, and opens every DBSONL handle with a 64 MiB, 8,192-page cache. MONGODB.md and the website carry the 2026-11-20 run with defuss-dbsonl 0.7.0. The website states the 8-worker time after a write beside MongoDB's and lists that engine in its table.
- A website gauge whose ratio lies beyond its scale says so ("over 256× faster") instead of naming the end stop as the ratio.

### Fixes

- A value-mode Node `Buffer` group key is now copied. `Buffer.prototype.slice` returns a view, so the representative kept the pooled backing store and followed later writes to it.

## 0.6.0

Tagged `v0.6.0` and published on npm on 2026-11-17, after 0.5.0 on the same day.

### Projection and aggregation

- New entry point `defuss-dataview/compute` with `forRows<T>()`: typed expression builders and prepared `rows`, `aggregate` and `view` plans with `evaluate`, `stream` and `explain`.
- Measures `count`, `sum`, `avg`, `min`, `max` and `sumBigInt`, each with an optional `where`; HAVING, output ordering and paging; `totalResultRows` under `count: 'exact'`.
- Grouping by exact typed equality on a trie of native Maps; value-mode binary keys are copied.
- Compensated (default) or sequential sums in source order, identical for every batch size; overflow, division by zero and count overflow throw.
- `maxWorkingBytes`, `maxGroups`, `maxOutputRows`, `maxOutputBytes` and `sizeOfOutput`, enforced with reservations before allocation.
- Strategies: scan, ordered, top-k and sort for rows; scalar, hash, certified ordered groups and grouping-only first-seen pages for aggregates.
- Plans lease already-built key-cache columns for one execution and never build columns themselves.
- Standalone browser module `dist/browser-compute.mjs`, which also exports the stream API so sources and plans share one module instance; it runs under a CSP without `unsafe-eval`.
- `bun run benchmark:mongodb-compute` compares the plans with MongoDB aggregation pipelines: over 1,000,000 orders they took 1.6× to 4.4× less time than the faster MongoDB variant.

### Website

- A live compute panel runs five plans on up to 1,000,000 seeded orders, with or without prepared columns, and shows the MongoDB comparison.
- Code samples are syntax-highlighted, including the install commands and the stream page's summary.
- The header switches to the menu sheet below about 1,000 px instead of wrapping its links.
- The comparison card explains prepared columns and shows row reads and `prepareKeys()` as code in two tabs.
- The query explorer also runs compute plans written as JSON (`"aggregate"`, `"rows"` or `"view"`), with five examples.
- The Ledger demo has a Reports tab: four compute plans over the orders, each shown in a Data Grid.
- The flow diagram shows the Aggregate and Project steps, and the API section has a projection and aggregation tab.

### Internal

- `src/stream/driver.ts` holds session validation, shared by stream queries and compute plans, and the batch reader compute uses.
- The key cache can lend existing columns through a lease and derives a column's value domain on first request.

## 0.5.0

Successor of 0.4.0, published on npm on 2026-11-17. Internal development stages before this release were never published.

### Breaking

Table/tree queries use the shared compiler: strings sort by UTF-16 code units instead of `localeCompare` (opt into collation with `semantics.strings: 'locale'`), BigInts and binary values sort numerically and by bytes, Dates and binary values are equal by value, `NaN` equals `NaN` in `eq`/`neq`/`in`, and an unknown filter operator or invalid `semantics` throws a `TypeError`. Runtime support starts at Node.js 20.19.0. README "Behavior changes in 0.5.0" lists each change.

### Snapshot queries

- New entry points `defuss-dataview/query`, `defuss-dataview/stream` and `defuss-dataview/adapters/dbsonl`.
- Public query compiler with deterministic value semantics for Dates, numeric BigInts, binary contents, code-unit strings and explicit locale ordering.
- Batched snapshot source protocol, array source and structural DBSONL adapter with optional native batches.
- Pull-based streaming, global pagination, exact or unknown totals, stable bounded top-k and full sorting, comparator-aware ordered scans.
- Explicit row, byte and work limits, cooperative cancellation, owned snapshot cleanup and completion metadata.
- `createImmutableArraySource` with atomic membership replacement, bigint revisions and O(1) snapshot opens.
- Reusable prepared queries; explicit immutable filter/order indexes with atomic rebuilds and opaque revision-bound cursor pages.
- Optional immutable revision key cache (SLRU default, TinyLFU-style admission optional) with shared builds, per-caller cancellation and pinned-byte accounting.
- Optional conservative min/max and scalar Bloom block summaries; whole-batch validation and exact counts still run.
- Opt-in, capped columnar sort-key projection for index builds.

### Performance

- Built-in sources hand validated row measurements to the executor; external batches are validated independently.
- `createDbsonlSource(db, { projection: { fields } })` keeps the queried fields of one revision after a complete scan; later small pages at that revision filter, sort and count the copies and read only the rows they return. In the MongoDB benchmark over 100,000 documents on file storage, the top-50 query took 17 ms at the same revision against 318 ms for a full scan. `prepare()` and `projected` build and report it.
- DBSONL native batches reuse the size the adapter's own `sizeOf` recorded for each row, so the estimator runs once per row instead of twice: 0.85× of the previous time for filter + top-50 over 100,000 defuss-dbsonl 0.6.0 rows, on memory and file storage.
- Pinned arrays batch directly; sorted candidates allocate only after ordering and memory admission; admitted heap nodes are recycled.
- Adaptive stable top-k for shallow flat pages with exact counts and metadata.
- Compiled filter dispatch with small-arity filter/sort/accessor specialization and generic fallbacks.
- Trees index finite numeric IDs by value, fill the ID index with one Map write per row and walk with typed stacks: 0.28× to 0.45× of 0.4.0's time for balanced trees and chains in paired runs.

### Tooling and evidence

- Project website in `docs/` for GitHub Pages: a landing page with an animated flow diagram, a query explorer over 10,000 editable rows, a stream demo page, measured coverage, test counts and scaling benchmarks (`make site-metrics`), and a demo of defuss-shadcn 0.9.8's Big Data components on up to 1,000,000 generated rows. The site loads the locally built bundle from `docs/assets/defuss-dataview@<version>/`.
- `scripts/serve.mjs` answers a directory with its `index.html`; the Playwright suite uses `PORT` like the dev server, and a free port while 4179 is busy.
- Development and tests use defuss-dbsonl 0.6.0, whose `scanBatches` the adapter uses; a test hides it on real snapshots to keep the row-scan fallback covered. `bun run benchmark:dbsonl` compares the installed package with other unpacked versions. 0.6.0 adopted that batch API from a 0.4-based fork this repository carried during development.
- `bun run benchmark:mongodb` compares dataview over arrays and DBSONL with MongoDB on the same documents; `documentation/MONGODB.md` has the results.
- `SHA256SUMS` is gone: it hashed gitignored build output that every build rewrites. The registry's sha512 integrity identifies the published tarball.
- bun is the package manager: `bun.lock` replaces `package-lock.json`, and the tarball check packs with `bun pm pack` and installs with `bun add`. Node.js still runs the tests, scripts and the packed consumer.
- The website compares defuss-dataview with MongoDB below the hero, from `docs/assets/mongodb.json`, and uses defuss-shadcn 0.9.14. Every pairing is a repeated query after a warm-up; on DBSONL storage that is the projection of one revision, and its full scan is listed as preparation.
- Differential tests against a committed pre-optimization reference build in `tests/reference/`; real DBSONL memory/native/OPFS integration; adversarial query and lifecycle tests; browser, worker and clean-package checks.
- defuss-vae agent state moved to `.vae/`.

## 0.4.0

Published to npm on 2026-10-04 from commit `669ab2c`. That tarball's own CHANGELOG lists the `setParent`, non-JSON row ID, macOS tarball-check and `make verify` entries under "Unreleased"; they are part of 0.4.0.

- Fix nontermination on parent cycles, disconnected cycle loss, deep-tree stack overflow and wide-tree spread overflow.
- Make ancestor inclusion linear in hierarchy size; allocate paged tree metadata only for returned entries.
- Distinguish omitted expansion from an explicit empty list; preserve default-all toggles through `expandAll`/`collapsedIds`.
- Use consistent structural JSON identifiers across selection, expansion, parent linking and patches. Rows whose IDs are not JSON values (e.g. BigInt) are reported unselected.
- Honor dot-path ID/parent fields in data patches; reject unsafe/inherited traversal and cyclic moves. `setParent` still copies class-instance rows like 0.3.1 and `updateRows`; only nested dot-path containers must be plain objects or arrays.
- Preserve array/row/view identity on no-ops and retain view extension fields.
- Stabilize NaN/invalid-date ties, define consistent mixed-type ordering, exclude invalid relational cells and reject unsafe paging integers.
- Add `evaluateDataview` with exact match/visibility/page counts; retain `applyDataview`'s array contract.
- Retain all 67 original tests, original benchmarks, public functions, runtime engine range and dual ESM/CommonJS packaging.
- Add regression/differential tests, browser and module-worker tests, standalone configuration/lockfile, tarball consumer checks (also on macOS), audit evidence, release workflow and documentation.
- Add `make verify` (lint, test, coverage, e2e) and a matching CI workflow; lint denies warnings.

## 0.3.1

Upstream baseline from kyr0/defuss at the revision recorded in NOTICE. This file does not reconstruct an undocumented upstream changelog.
