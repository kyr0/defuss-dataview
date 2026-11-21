# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING and keeps the last 100 entries (git keeps older ones).
Agents append `<UTC ISO> s=<session> LESSON <Signan>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
A lesson recurring ≥2 → test | .agents/VERIFY.py rule | MEMORY line, then delete its lines. -->

2026-10-04T10:16:17Z s=cd9fdf13 FINDING .github/workflows/verify.yml|steps learn=none: workflow not executed locally; first CI run on origin is the evidence
2026-10-04T10:19:56Z s=cd9fdf13 LESSON commit hook checks the whole Bash command before it runs → `vae.py gate` AND `git commit` REQUIRE separate tool calls; fingerprint is relative to HEAD → gate again after EVERY commit
2026-10-10T12:54:27Z s=4c6f18dd FINDING CHANGELOG.md:5 P07/B02 learn=none: One-off wording in a release note; nothing recurring to check mechanically.
2026-10-10T12:54:27Z s=4c6f18dd FINDING CHANGELOG.md:10 P09/L09 learn=none: Wording; the behavior itself is covered by src/regressions.test.ts.
2026-10-10T13:27:17Z s=4c6f18dd FINDING scripts/serve.mjs:16 learn=none: Dev-server edge case; no non-ASCII paths exist under docs/.
2026-10-10T13:27:17Z s=4c6f18dd FINDING README.md:7 B09; AGENTS.md:5 B09 learn=none: Becomes true once the maintainer enables Pages; not mechanically checkable offline.
2026-10-10T13:52:21Z s=4c6f18dd FINDING docs/index.html:How it works step 01 P08 learn=none: Wording.
2026-10-10T14:08:09Z s=4c6f18dd FINDING docs/index.html:#dv-flow edges learn=none: Visual layout; the e2e checks the diagram's nodes, tones and detail output, not pixel routing.
2026-10-10T15:08:39Z s=4c6f18dd FINDING playwright.config.ts:PORT learn=none: The fallback itself removes the failure class; a test that occupies 4179 would collide with the same dev server it guards against.
2026-10-10T15:08:39Z s=4c6f18dd FINDING docs/assets/site.js:lineChart legend learn=none: Visual; the identity channel is also carried by direct labels and the table.
2026-10-10T15:08:39Z s=4c6f18dd FINDING docs/index.html:#perf lead L09 learn=none: Wording.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:55 L03 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:56 L03 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:363 L09 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:271 L09 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:289 T07 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:28 P08 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:32 A01 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:122 A01 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:199 P01 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:201 P09 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:96 P09 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:257 L01 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:377 B09 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:12:11Z s=792882e7 FINDING README.md:335 B02 learn=none: Wording defect found and fixed in this page; not mechanically checkable beyond vae.py prose.
2026-10-10T16:16:08Z s=792882e7 FINDING README.md:13 A04 learn=none: Human editorial choice, not a defect.
2026-11-15T20:34:44Z s=9ef67782 FINDING .oxlintrc.json learn=none: the lint verb in the gate already detects it
2026-11-15T20:34:44Z s=9ef67782 FINDING README.md:Behavior changes in 0.5.0 learn=none: documentation completeness is not mechanically checkable
2026-11-15T20:34:44Z s=9ef67782 FINDING CHANGELOG.md learn=none: one-off editing loss
2026-11-15T20:34:44Z s=9ef67782 FINDING NOTICE:16 learn=none: factual correction
2026-11-15T20:34:44Z s=9ef67782 FINDING documentation/PERFORMANCE.md:binary kernels B01 learn=none: measurement-dependent
2026-11-15T20:34:44Z s=9ef67782 FINDING README.md:Speed P09 learn=none: wording
2026-11-16T10:51:25Z s=9ef67782 FINDING docs/index.html explorer 'unsafe path' preset learn=none: maintainer UX decision, no code defect; the __proto__ rejection stays covered by unit tests
2026-11-16T19:58:04Z s=9ef67782 FINDING package.json devDependencies defuss-dbsonl learn=none: measurement-dependent documentation; the adapter suite runs against 0.5.0 and the companion
2026-11-16T20:56:15Z s=9ef67782 FINDING scripts/benchmark-mongodb.mjs fixedIndex + documentation/MONGODB.md learn=none: measurement-dependent documentation
2026-11-16T21:55:47Z s=9ef67782 FINDING DBSJONL_HANDOFF.md learn=none: documentation for another repository's agent
2026-11-16T21:58:18Z s=9ef67782 FINDING docs/index.html hero + nav learn=none: copy and navigation change
2026-11-17T01:32:09Z s=9ef67782 FINDING branch release/0.5.0 diff against origin/main; SHA256SUMS learn=none: review of already tested code plus a file deletion; no new defect found
2026-11-17T03:00:56Z s=9ef67782 FINDING src/stream/key-cache.ts:build learn=none: a timing ratio is machine-dependent and not a reliable test or verifier rule; documentation/COMPUTE_PERFORMANCE.md records the measurement and key-cache.ts carr
2026-11-17T03:00:56Z s=9ef67782 FINDING src/compute/execute.ts:run learn=none: performance structure, measured once on one machine; recorded in documentation/COMPUTE_ARCHITECTURE.md and src/compute/ARCH.md
2026-11-17T03:00:56Z s=9ef67782 FINDING src/compute/group-table.ts:has learn=none: dead code is caught by coverage review, not a rule
2026-11-17T03:00:56Z s=9ef67782 FINDING .gitignore learn=none: a one-off local layout choice
2026-11-17T03:00:56Z s=9ef67782 FINDING documentation/COMPUTE_ARCHITECTURE.md:30 B (evidence), CHANGELOG.md:20, src/compute/ARCH.md:5 learn=none: a claim about which module imports what is checked by review, not by a mechanical rule
2026-11-17T03:19:14Z s=9ef67782 FINDING docs/index.html:653 'Late projection' card; documentation/COMPUTE_SEMANTICS.md:13 B (evidence) learn=none: prose accuracy is a review check, not a mechanical rule
2026-11-17T03:19:14Z s=9ef67782 FINDING documentation/MONGODB.md 'Projection and aggregation' B (evidence) learn=none: prose accuracy is a review check
2026-11-17T03:19:14Z s=9ef67782 FINDING docs/assets/site.css header container query; docs/index.html nav learn=none: a layout measurement on one browser; the header test now clicks every section link including Compute
2026-11-17T03:19:14Z s=9ef67782 FINDING docs/assets/compute.js showVersus / docs/index.html comparison table learn=none: visual layout, checked by screenshot
2026-11-17T12:10:44Z s=9ef67782 DONE fp=decccda24c43 cov=98.9% paths=.github/workflows/ci.yml,.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md(+154)
2026-11-17T12:12:00Z s=9ef67782 DONE fp=6dcf9644f72c cov=98.9% paths=.github/workflows/ci.yml,.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md(+149)
2026-11-17T16:25:07Z s=9ef67782 DONE fp=c8c9aabdcabb cov=98.9% paths=.github/workflows/ci.yml,.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md(+149)
2026-11-17T16:29:17Z s=9ef67782 DONE fp=3d265a6f7240 cov=98.9% paths=.github/workflows/ci.yml,.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md(+149)
2026-11-17T16:34:10Z s=9ef67782 DONE fp=0731552066a2 cov=98.9% paths=.github/workflows/ci.yml,.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md(+149)
2026-11-17T16:45:11Z s=9ef67782 DONE fp=a5c1bcd249b8 cov=98.9% paths=.github/workflows/ci.yml,.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md(+149)
2026-11-17T17:13:46Z s=9ef67782 DONE fp=948783512ae1 cov=98.9% paths=.github/workflows/ci.yml,.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md(+149)
2026-11-20T00:48:06Z s=8029794f FAIL lint
2026-11-20T00:53:51Z s=8029794f DONE fp=cb525a469c9f cov=99.0% paths=CHANGELOG.md,README.md,docs/assets/defuss-dataview@0.6.0/browser-compute.mjs,docs/index.html(+23)
2026-11-20T00:53:51Z s=8029794f FINDING src/compute/group-table.ts:own (now src/compute/aggregate.ts:ownBytes) learn=test: src/compute/grouping.test.ts 'copies a Node Buffer key instead of sharing its pooled memory' failed before the fix and passes after.
2026-11-20T00:53:51Z s=8029794f FINDING documentation/COMPUTE_PERFORMANCE.md:55 B05 learn=none: prose accuracy against a benchmark run is a review check, not a mechanical rule
2026-11-20T00:53:51Z s=8029794f FINDING documentation/COMPUTE_PERFORMANCE.md:57 B01 learn=none: epistemic labeling is a review check
2026-11-20T00:53:51Z s=8029794f FINDING documentation/COMPUTE_SEMANTICS.md 'Partials and merge' P07; README.md compute bullets P07 learn=none: modality of prose claims is a review check
2026-11-20T00:53:51Z s=8029794f FINDING documentation/COMPUTE_SEMANTICS.md Numbers B01 learn=none: source attribution is a review check
2026-11-20T00:53:51Z s=8029794f FINDING documentation/COMPUTE_ARCHITECTURE.md 'Partial and final stages', src/compute/ARCH.md L01 learn=none: prose review
2026-11-20T00:53:51Z s=8029794f FINDING src/compute/aggregate.ts:addNumber (default compensated path) learn=none: timing ratios are machine-dependent; not a reliable test or rule (same as the key-cache.ts finding of 2026-11-17)
2026-11-20T14:33:52Z s=8029794f FAIL tests.e2e.1
2026-11-20T14:36:17Z s=8029794f DONE fp=85552d339871 cov=99.0% paths=CHANGELOG.md,README.md,bun.lock,docs/assets/defuss-dataview@0.6.0/browser-compute.mjs(+33)
2026-11-20T14:36:17Z s=8029794f FINDING src/adapters/dbsonl.ts:116|open.registerMeasuredScan learn=test: src/adapters/dbsonl.test.ts:176 asserts backend.parallel.scans grows by one per large scan and that rows equal the row-only path.
2026-11-20T14:36:17Z s=8029794f FINDING src/adapters/dbsonl.ts:116|maxBatchBytes learn=test: src/adapters/dbsonl.test.ts:156 asserts every measured span stays within maxBatchBytes, sizeOf runs once per row and the rows come in order.
2026-11-20T14:36:17Z s=8029794f FINDING src/adapters/dbsonl.ts:205|PREFIX_ROWS learn=test: src/adapters/dbsonl.test.ts:197 asserts a 50-row page leaves parallel.scans unchanged and a full scan starts the pool once; a mutation with PREFIX_ROWS = 0 fail
2026-11-20T14:36:17Z s=8029794f FINDING src/adapters/dbsonl.ts:237|nativeBatches skip learn=test: src/adapters/dbsonl.test.ts:197 puts a 4,096-unit key at the end of the prefix and checks each row once, also for a provider that ignores limit; removing the sk
2026-11-20T14:36:17Z s=8029794f FINDING examples/compute-partials.mjs:43|Worker learn=none: Not reproduced: no worker exited early in any run; the handler only turns a possible hang into an error.
2026-11-20T14:36:17Z s=8029794f FINDING tests/e2e/dataview.spec.ts:2|beforeEach learn=none: Flake without a reproduced cause; a test or rule would pin one unexplained failure.
2026-11-20T14:36:17Z s=8029794f FINDING documentation/STREAMING.md:48 P07; README.md:335 P07; documentation/SOURCES.md:92 P07; documentation/PERFORMANCE.md:65 P07; src/adapters/ARCH.md:13 P07 learn=none: Prose precision fixed on the pages; no mechanical check fits.
2026-11-20T14:36:17Z s=8029794f FINDING documentation/COMPUTE_PERFORMANCE.md:57 P05 L01 B01 learn=none: Prose fixed against the measured figures.
2026-11-20T14:36:17Z s=8029794f FINDING README.md:455 R05 learn=none: Prose fixed against the measured figures.
2026-11-20T16:16:06Z s=8029794f FAIL tests.e2e.1
2026-11-20T16:45:18Z s=8029794f DONE fp=a9248642c4d2 cov=99.0% paths=CHANGELOG.md,README.md,bun.lock,docs/assets/defuss-dataview@0.6.0/browser-compute.mjs(+38)
2026-11-20T16:45:18Z s=8029794f FINDING docs/assets/site.js:569|ui.tacho.format('vs-mongodb') learn=test: tests/e2e/docs.spec.ts expects the clamped needle and an 'over' readout beyond the scale; with the old format it failed on '256× faster'.
2026-11-20T16:45:18Z s=8029794f FINDING scripts/benchmark-mongodb.mjs:CACHE learn=none: The mechanism inside defuss-dbsonl's cache is not established; documented as UNKNOWN in SOURCES.md and reported to the storage side.
2026-11-20T16:45:18Z s=8029794f FINDING scripts/benchmark-mongodb.mjs|first 1,000,000 run learn=none: Host load is environmental; the alternating method already exposes it through the reference engines, so no rule pins it.
2026-11-20T16:45:18Z s=8029794f FINDING src/adapters/dbsonl.test.ts|merged in key order learn=test: The recipe documented in SOURCES.md is covered by this test.
2026-11-20T16:45:18Z s=8029794f FINDING README.md:492 S06; documentation/MONGODB.md:76 L01 learn=none: Prose fixed on the pages.
2026-11-20T19:06:50Z s=8029794f DONE fp=5e3168637279 cov=99.0% paths=CHANGELOG.md,README.md,RELEASE.md,bun.lock(+55)
2026-11-20T19:06:50Z s=8029794f FINDING tests/unit/docs.test.ts|ships measurements for the package version learn=test: The existing docs test already ties metrics.json to package.json's version.
2026-11-20T19:06:50Z s=8029794f FINDING CHANGELOG.md:32 B09; RELEASE.md:3 B09; .vae/MEMORY.md:10 learn=memory: MEMORY.md versions line updated from the registry.
2026-11-20T19:06:50Z s=8029794f FINDING RELEASE.md:3 T03 learn=none: Prose fixed on the page.
2026-11-20T19:06:50Z s=8029794f FINDING README.md:77,565|CDN URL learn=none: Release timing, not a defect: the README documents the version it ships with, as it did for 0.6.0.
2026-11-20T19:07:58Z s=8029794f DONE fp=9519d9d1f604 cov=99.0% paths=CHANGELOG.md,README.md,RELEASE.md,bun.lock(+51)
2026-11-20T19:17:57Z s=8029794f DONE fp=25ca518079bd cov=99.0% paths=CHANGELOG.md,README.md,RELEASE.md,bun.lock(+51)
2026-11-20T19:17:57Z s=8029794f FINDING docs/assets/metrics.json|re-measured outside this session learn=none: Which process re-ran the metrics is not established; the user decides whether to commit the new measurement.
2026-11-21T14:33:43Z s=19560c1d DONE fp=73622d12094b cov=99.1% paths=CHANGELOG.md,README.md,RELEASE.md,docs/assets/defuss-dataview@0.7.0/browser-compute.mjs(+35)
2026-11-21T14:33:43Z s=19560c1d FINDING src/compute/dates.ts:NamedZone.exact learn=test: src/compute/dates.test.ts 'read Dates and epoch milliseconds...' evaluates both ends of the Date range in Asia/Tokyo
2026-11-21T14:33:43Z s=19560c1d FINDING src/compute/dates.ts:truncate|part; src/compute/aggregate.ts:final learn=none: A measured optimization, not a defect; timing ratios are machine-dependent and not a test or verifier rule (EPISODES precedent for key-cache.ts).
2026-11-21T14:33:43Z s=19560c1d FINDING CHANGELOG.md:13 B09; src/compute/ARCH.md:11 B03 learn=none: Prose fixed on the page.
2026-11-21T14:33:43Z s=19560c1d FINDING documentation/COMPUTE_SEMANTICS.md:41 P08 learn=none: Prose fixed on the page.
2026-11-21T14:33:43Z s=19560c1d FINDING docs/assets/defuss-dataview@0.8.0/*, docs/assets/metrics.json, docs/index.html, docs/demo/*.js, docs/stream.html learn=none: Release build outputs, checked by the e2e suite.
2026-11-21T14:33:43Z s=19560c1d FINDING src/compute/aggregate.ts:final (percentile) learn=none: Comment corrected to the measurement.
2026-11-21T15:29:20Z s=19560c1d DONE fp=172cf33b1299 cov=99.1% paths=CHANGELOG.md,README.md,RELEASE.md,docs/assets/defuss-dataview@0.7.0/browser-compute.mjs(+35)
2026-11-21T15:29:20Z s=19560c1d FINDING src/compute/compile.ts:compilePlan (groupBy each) learn=test: src/compute/operators.test.ts 'are whole group keys only' (node without v), 'each() group keys' and the oracle's unwind plan merged from 1, 2 and 5 parts
2026-11-21T18:58:53Z s=19560c1d DONE fp=5e35c925818a cov=99.1% paths=CHANGELOG.md,README.md,RELEASE.md,docs/assets/defuss-dataview@0.7.0/browser-compute.mjs(+37)
2026-11-21T18:58:53Z s=19560c1d FINDING documentation/COMPUTE_SEMANTICS.md:31 P (precision); CHANGELOG.md:7 learn=test: dates.test.ts 'take Date arithmetic through epochMs' pins both policies of sub() on Dates.
