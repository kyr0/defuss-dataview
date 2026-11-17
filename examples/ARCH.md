# Examples

Runnable consumers of the built package. `index.html` uses the table/tree browser bundle and backs the e2e UI tests. The `.mjs` files import `../dist/`, so run `bun run build` first, then for example `node examples/stream.mjs`:

- `stream.mjs`: `evaluateStream` and `streamQuery` over an array source.
- `immutable.mjs`: revisioned immutable membership and snapshot pins.
- `prepared-index.mjs`: prepared queries and cursor pages of an explicit index.
- `optimized-index.mjs`: opt-in sort-key projection for an index build.
- `cached-queries.mjs`: the revision key cache with block summaries.
- `dbsonl.mjs`: the DBSONL adapter over a memory backend; it needs `defuss-dbsonl`, which applications install themselves and this checkout pins as a development dependency.
- `dbsonl-projection.mjs`: a projection of one revision, then a write that sends the next query back to a full scan.

The examples ship in the npm package. `scripts/package-tests.mjs` runs each one from the installed tarball, where `../dist/` is the packed build, so an example that drifts from the API fails the e2e gate.
