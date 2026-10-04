# Release 0.4.0

The ZIP contains full source, exact development lockfile, tests, example, provenance/audit evidence, built modules/types/maps and a verified npm tarball. No repository push, npm publication or tag is part of preparation.

Use Node 22 or 24 for release tooling:

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
npm publish --access public
```

Run from the extracted `defuss-dataview` directory. npm authentication, authorization for the existing package name and any required OTP are handled by npm. `prepublishOnly` repeats the full check. Package 0.3.1 was the registry latest during preparation; 0.4.0 must still be unused when publishing. No credentials are included.

`npm run check` creates `artifacts/defuss-dataview-0.4.0.tgz` and a report with its integrity hash after installation into a separate temporary consumer. It verifies both JS formats, both NodeNext declaration formats, Bundler resolution without DOM types, SSR imports and browser bundling. The full ZIP additionally carries source/tests/scripts; the npm tarball contains only built distribution, package metadata and documentation/licenses.

The browser gate normally uses Playwright's installed Chromium. On provisioned systems, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select a binary; optional `PLAYWRIGHT_CHROMIUM_ARGS` is a JSON flag array. The delivered run used Node 24 and Chromium 153 from an external `@sparticuz/chromium@153.0.0` installation because the standard browser CDN was unavailable. Origin protections remained enabled. That alternate browser installation is not a package dependency. CI uses the standard Playwright browser.

Use `npm run audit:upstream`, `npm run benchmark:compare`, and `npm run benchmark` for optional reproducible audit/performance evidence. These are not publish gates; benchmark latency is environment-sensitive. For a subsequent version, update with `npm version <version> --no-git-tag-version`, update the changelog and rerun the gate. The packing scripts read the version from package metadata.

Before deploying the update into existing apps, apply the README's 0.3.1 migration notes, especially old stored empty expansion lists. No GitHub repository was modified by preparing this standalone distribution.
