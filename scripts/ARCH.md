# Scripts

Build, package, provenance and measurement tools. Every script runs from a clean checkout after `bun install --frozen-lockfile`; none reads a local-only baseline, so CI and a fresh clone run the same commands.

## Build and release gates

- `browser.mjs` bundles the dependency-free browser entries and a separate real-storage test worker, and writes `dist/stats.json`.
- `site-build.mjs` copies the built browser bundles into `docs/assets/defuss-dataview@<version>/`, removes older versioned folders and pins the bundle's sha384 in the pages. The website therefore always runs the build under review, never a published release.
- `package-tests.mjs` packs the tarball with `bun pm pack`, installs it with `bun add` in a temporary consumer outside the workspace, runs it under Node.js and checks ESM, CommonJS, declaration modes, SSR, browser bundling and every shipped example; for the DBSONL examples it also installs the defuss-dbsonl version this checkout pins.
- `verify.mjs` checks exports, package metadata, the upstream fixture and test hashes, and the hashes of the differential reference oracle in `tests/reference/`.
- `site-metrics.mjs` writes `docs/assets/metrics.json`; `--reports-only` refreshes test and coverage counts without timing again.

## Measurements

Timings are observations on one machine, never correctness gates. Each benchmark checks its results outside the timed region.

- `benchmark-paired.mjs <old index.mjs> [new index.mjs]` alternates calls into two builds of the table/tree API. Pairing cancels most drift between runs, which absolute tables from different machines cannot; use it with the previous npm release before a version bump.
- `benchmark-compare.mjs` pairs the table/tree API with upstream 0.3.1 from `tests/fixtures/upstream-src/` after checking output equivalence.
- `benchmark-dbsonl.mjs [rows] [package dir ...]` times DBSONL snapshot scans and stream queries on memory and file storage with the installed defuss-dbsonl and any other installed package directory, and on `scanBatches` where a package has it, after checking that they return the same results.
- `benchmark-mongodb.mjs [rows]` loads the same documents into DBSONL and a running MongoDB (`MONGODB_URL`), answers the same queries with dataview over an immutable array, a dataview fixed-query index (`createIndexedArraySource`, built once per query), dataview over DBSONL and MongoDB with and without an index, checks that every engine returns the same rows and count, and drops its throwaway database `defuss_dataview_bench_<pid>`.
- `benchmark-mongodb-compute.mjs [rows]` runs the website compute panel's five plans on the same seeded orders (`docs/demo/data.js`) against equivalent MongoDB aggregation pipelines, with and without indexes. It checks every answer against the others before timing (floating-point sums to a relative 1e-9), writes `artifacts/benchmark-mongodb-compute.json` and, at 100,000 or 1,000,000 rows, `docs/assets/mongodb-compute.json`, and drops its throwaway database `defuss_dataview_compute_<pid>`.
- `benchmark-stream.mjs` times array sorting, stream top-k with generic and fixed-schema accounting, early pages and a generated full scan.
- `benchmark-compute.mjs [--samples N] [--rows N]` runs the core compute scenarios against handwritten loops and an unshipped compact-table probe, checks every result first, and writes `artifacts/compute-benchmark.json`; documentation/COMPUTE_PERFORMANCE.md records the results.
- `benchmark-cache-policies.mjs [dist]` replays fixed immutable query traces with the key cache off, SLRU and TinyLFU under one column cap and proves every result against native stable sorting.
- `benchmark-binary.mjs` and `benchmark-binary-browser.mjs` run the scalar, unrolled and word-sized binary comparison kernels in `binary-kernels.mjs` under Node, Bun and Chromium with exact-result checks. They document why the runtime keeps the scalar kernel.
- `audit-upstream.mjs` reproduces the upstream defects against the pinned original source.
