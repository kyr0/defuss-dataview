# Release 0.5.0

0.5.0 is the next npm release after 0.4.0 and has not been published yet. Releases are published from a tagged commit of this repository; no credentials are stored here.

bun 1.4.3 is the package manager (`packageManager` in package.json, `bun.lock`); Node 22 or newer runs the tests and scripts:

```sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium
bun run check
bun publish --access public
```

`bun publish` takes the registry and its credentials from `.npmrc`, `bunfig.toml` or the environment (`bun publish --help`); a one-time password goes through the browser by default or `--otp`. `prepublishOnly` repeats the full check. VERIFIED: `bun publish --dry-run --ignore-scripts` listed the same 84 files as the tarball check (85 since `examples/dbsonl-projection.mjs`; not rerun), for defuss-dataview@0.5.0 on the public npm registry. UNKNOWN: a real `bun publish` from this machine has not run yet; 0.4.0 was published with `npm publish`.

## What `bun run check` does

1. Lint, type checks and the build, including the website bundle in `docs/assets/defuss-dataview@<version>/`.
2. Coverage without the website unit test, which depends on fresh metrics; then the Chromium suite; then `scripts/site-metrics.mjs`, which times the build for the website.
3. The complete coverage suite, `site-metrics.mjs --reports-only` to record its counts, the tarball consumer (`artifacts/defuss-dataview-<version>.tgz` plus `artifacts/package-verification.json`) and `npm run verify`.

This order resolves the dependency between coverage and website metrics in a clean checkout without stale reports. Documentation browser checks allow 60 seconds for integrity-pinned CDN assets.

## Before tagging

- Compare with the previous release on one idle machine: download `https://registry.npmjs.org/defuss-dataview/-/defuss-dataview-0.4.0.tgz`, unpack it outside the repository, then `bun run benchmark:paired -- <unpacked>/package/dist/index.mjs`. Update the README's speed section from `docs/assets/metrics.json` and that report.
- Commit the refreshed `docs/` and `SHA256SUMS`. `SHA256SUMS` also hashes the gitignored `dist/` and `artifacts/`, which every build rewrites, so regenerate it right before tagging.
- For a later version, set `version` in package.json, update the changelog and rerun the check. The packing, website and metrics scripts read the version from `package.json`.

## Browsers

The browser gate uses Playwright's Chromium. On provisioned systems `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selects a binary, and optional `PLAYWRIGHT_CHROMIUM_ARGS` is a JSON flag array.

