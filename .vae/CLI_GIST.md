# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd` — only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->

- VERIFIED[release-gate] `bun run check` — lint, types, build, coverage, Playwright, site metrics, tarball consumer + examples, provenance (exit 0, 2026-11-15, Node 26, macOS)
- VERIFIED[release-compare] the registry tarball of defuss-dataview 0.4.0 unpacked outside the repo, then `bun run benchmark:paired -- <dir>/package/dist/index.mjs` (2026-11-15)
- VERIFIED[publish] 0.4.0 was published with `npm publish --access public` (registry 2026-10-04T10:25Z, gitHead 669ab2c); needs npm auth/OTP, so the maintainer runs it
- VERIFIED[dev-site] `make dev` — build, then `bunx serve@14.2.8 ./docs`; port 3000 or the free port it prints (/, /demo/, /stream, bundle 200; 2026-11-15)
- VERIFIED[dbsonl-bench] `bun run benchmark:dbsonl -- 100000 <dir>/node_modules/defuss-dbsonl` (after `bun add defuss-dbsonl@<old>` in an empty dir) — cross-checks results, then alternates packages on memory + file storage, plus `scanBatches` where present (2026-11-17, 0.6.0 vs 0.5.0)
- VERIFIED[mongo-bench] `bun run benchmark:mongodb -- 100000` — needs a running MongoDB at MONGODB_URL (default 127.0.0.1:27017); creates and drops defuss_dataview_bench_<pid>, also on SIGINT/SIGTERM (2026-11-17, MongoDB 9.0.8)
