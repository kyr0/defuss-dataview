# Release 0.10.0

0.10.0 follows 0.9.0, published on npm on 2026-11-21. Releases are published from a tagged commit of this repository; no credentials are stored here.

bun 1.4.3 is the package manager (`packageManager` in package.json, `bun.lock`); Node 22 or newer runs the tests and scripts:

```sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium
bun run check
bun publish --access public
```

`bun publish` takes the registry and its credentials from `.npmrc`, `bunfig.toml` or the environment (`bun publish --help`); a one-time password goes through the browser by default or `--otp`. `prepublishOnly` repeats the full check. VERIFIED: `bun publish --dry-run --ignore-scripts` listed the same 84 files as the tarball check (85 since `examples/dbsonl-projection.mjs`; not rerun), for defuss-dataview@0.5.0 on the public npm registry. UNKNOWN: which command published 0.5.0 and 0.6.0; 0.4.0 was published with `npm publish`.

## What `bun run check` does

1. Lint, type checks and the build, including the website bundle in `docs/assets/defuss-dataview@<version>/`.
2. Coverage without the website unit test, which depends on fresh metrics; then the Chromium suite; then `scripts/site-metrics.mjs`, which times the build for the website.
3. The complete coverage suite, `site-metrics.mjs --reports-only` to record its counts, the tarball consumer (`artifacts/defuss-dataview-<version>.tgz` plus `artifacts/package-verification.json`) and `bun run verify`.

This order resolves the dependency between coverage and website metrics in a clean checkout without stale reports. Documentation browser checks allow 60 seconds for integrity-pinned CDN assets.

## Before tagging

- Compare with the previous release on one idle machine: download `https://registry.npmjs.org/defuss-dataview/-/defuss-dataview-0.4.0.tgz`, unpack it outside the repository, then `bun run benchmark:paired -- <unpacked>/package/dist/index.mjs`. Update the README's speed section from `docs/assets/metrics.json` and that report.
- Commit the refreshed `docs/`. The registry records the tarball's sha512 integrity, which `bun run test:package` also computes into `artifacts/package-verification.json`.
- For a later version, set `version` in package.json, update the changelog and rerun the check. The packing, website and metrics scripts read the version from `package.json`.

## Browsers

The browser gate uses Playwright's Chromium. On provisioned systems `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selects a binary, and optional `PLAYWRIGHT_CHROMIUM_ARGS` is a JSON flag array.

