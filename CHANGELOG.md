# Changelog

## 0.5.0

Unreleased successor of 0.4.0. Internal development stages before this release were never published.

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
