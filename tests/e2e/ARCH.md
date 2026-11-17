# Architecture

Playwright consumes built browser modules, the table/tree UI, streaming demo and documentation site. The DBSONL worker uses real OPFS. The compute test serves a page with `script-src 'self'` and no `unsafe-eval`, checks that `new Function` is blocked there, and runs the built compute module under that policy. The documentation site also loads pinned external shadcn/chart assets, so its tests require network access. All tests are configured in playwright.config.ts.
