# Tests

Current unit and integration contracts live next to the code in `src/`. This directory holds what those tests consume but do not own:

- `e2e/`: Playwright suites that drive the built browser modules, the example UI, the stream demo and every website page in Chromium.
- `browser/`: the DBSONL worker that the e2e suite runs against real OPFS and Web Locks.
- `types/`: compile-only checks of the published declarations; `scripts/package-tests.mjs` also runs them inside the installed tarball.
- `fixtures/`: the upstream 0.3.1 source and original tests, byte-for-byte. They are immutable provenance, not a behavior contract; `bun run verify` checks their hashes in `fixtures/provenance.json`.
- `reference/`: the differential oracle, a self-contained pre-optimization build of the query compiler and byte accounting. `src/stream/optimization.test.ts` compares the optimized code with it over seeded inputs.

## Why a committed reference build

The optimized compiler specializes paths by arity, operator and value type, and the byte accounting fuses traversal with validation. A hand-written expected table cannot cover the operator × value × semantics matrix, while an older build answers every case. It is committed rather than fetched so the tests run offline and in CI, and `bun run verify` pins its hashes so a rebuild cannot silently move the oracle along with the code under test. The upstream 0.3.1 fixtures cannot serve this role: they predate the shared value semantics.
