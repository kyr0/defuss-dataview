# Examples

Runnable consumers of the built package. `index.html` uses the table/tree browser bundle and backs the e2e UI tests. The `.mjs` files import `../dist/`, so run `bun run build` first, then for example `node examples/stream.mjs`:

- `stream.mjs`: `evaluateStream` and `streamQuery` over an array source.
- `immutable.mjs`: revisioned immutable membership and snapshot pins.
- `prepared-index.mjs`: prepared queries and cursor pages of an explicit index.
- `optimized-index.mjs`: opt-in sort-key projection for an index build.
- `cached-queries.mjs`: the revision key cache with block summaries.
- `dbsonl.mjs`: the DBSONL adapter over a memory backend; it needs `defuss-dbsonl`, which applications install themselves and this checkout pins as a development dependency.
- `dbsonl-projection.mjs`: a projection of one revision, then a write that sends the next query back to a full scan.
- `compute-projection.mjs`: `defuss-dataview/compute` rows with a computed column and a hidden sort key.
- `compute-groups.mjs`: grouped measures with `where`, HAVING, ordering, paging and an exact BigInt sum.
- `compute-view.mjs`: one page plus totals over every match, from one snapshot.
- `compute-cancel.mjs`: early return from a compute stream, then cancellation with an `AbortSignal`.
- `compute-partials.mjs`: partial aggregates in four worker threads over `split()` key ranges of one pinned DBSONL file snapshot, merged into the one-pass result.

The examples ship in the npm package. `scripts/package-tests.mjs` runs each one from the installed tarball, where `../dist/` is the packed build, so an example that drifts from the API fails the e2e gate.
