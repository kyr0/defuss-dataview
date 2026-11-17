# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING and keeps the last 100 entries (git keeps older ones).
Agents append `<UTC ISO> s=<session> LESSON <Signan>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
A lesson recurring ≥2 → test | .agents/VERIFY.py rule | MEMORY line, then delete its lines. -->

2026-10-04T10:16:17Z s=cd9fdf13 FINDING src/fields.ts:31|setField learn=test: src/regressions.test.ts 'moves class-instance rows like updateRows and 0.3.1 do' failed before fix
2026-10-04T10:16:17Z s=cd9fdf13 FINDING src/dataview.ts:18|evaluateFlat; src/tree.ts:100|evaluateTree learn=test: src/regressions.test.ts 'treats non-JSON row IDs as unselected…' failed before fix (flat unsorted+sorted)
2026-10-04T10:16:17Z s=cd9fdf13 FINDING scripts/package-tests.mjs:18|consumer learn=test: make e2e runs test:package each gate; failed before fix, passes after
2026-10-04T10:16:17Z s=cd9fdf13 FINDING .github/workflows/verify.yml|steps learn=none: workflow not executed locally; first CI run on origin is the evidence
2026-10-04T10:19:56Z s=cd9fdf13 LESSON commit hook checks the whole Bash command before it runs → `vae.py gate` AND `git commit` REQUIRE separate tool calls; fingerprint is relative to HEAD → gate again after EVERY commit
2026-10-04T10:20:38Z s=cd9fdf13 FINDING tests/fixtures/provenance.json|originalTests learn=test: appending a line to src/index.test.ts makes npm run verify fail 'Upstream evidence changed'; reverting passes
2026-10-04T10:20:38Z s=cd9fdf13 DONE fp=c3bd0a800a4f cov=99.7% paths=tests/fixtures/provenance.json
2026-10-10T12:54:27Z s=4c6f18dd DONE fp=4844ea408464 cov=? paths=CHANGELOG.md,README.md,RELEASE.md
2026-10-10T12:54:27Z s=4c6f18dd FINDING CHANGELOG.md:5 P07/B02 learn=none: One-off wording in a release note; nothing recurring to check mechanically.
2026-10-10T12:54:27Z s=4c6f18dd FINDING CHANGELOG.md:10 P09/L09 learn=none: Wording; the behavior itself is covered by src/regressions.test.ts.
2026-10-10T13:21:42Z s=4c6f18dd FAIL prose
2026-10-10T13:27:17Z s=4c6f18dd DONE fp=30b0d0b4ffed cov=99.7% paths=AGENTS.md,CHANGELOG.md,README.md,RELEASE.md(+13)
2026-10-10T13:27:17Z s=4c6f18dd FINDING docs/demo/app.js:stats taxonomy learn=test: tests/e2e/docs.spec.ts Taxonomy test selects a node and fails on any pageerror.
2026-10-10T13:27:17Z s=4c6f18dd FINDING docs/demo/app.js:grid click listener learn=test: tests/e2e/docs.spec.ts Orders test shift-selects a range and asserts the inspected record.
2026-10-10T13:27:17Z s=4c6f18dd FINDING tests/unit/docs.test.ts:exports learn=test: The strengthened assertion is the encoded lesson.
2026-10-10T13:27:17Z s=4c6f18dd FINDING scripts/serve.mjs:16 learn=none: Dev-server edge case; no non-ASCII paths exist under docs/.
2026-10-10T13:27:17Z s=4c6f18dd FINDING README.md:7 B09; AGENTS.md:5 B09 learn=none: Becomes true once the maintainer enables Pages; not mechanically checkable offline.
2026-10-10T13:27:17Z s=4c6f18dd FINDING AGENTS.md:3 T02 learn=verifier: The vae prose check already enforces it.
2026-10-10T13:27:17Z s=4c6f18dd FINDING docs/index.html API lead + setParent row B02 learn=test: tests/unit/docs.test.ts checks the API reference against the source; wording is reviewed against README.
2026-10-10T13:52:21Z s=4c6f18dd DONE fp=76a067784ad0 cov=99.7% paths=AGENTS.md,CHANGELOG.md,README.md,RELEASE.md(+13)
2026-10-10T13:52:21Z s=4c6f18dd FINDING docs/assets/site.css:.dv-page learn=test: tests/e2e/docs.spec.ts phone test runs with reduced motion and asserts scrollWidth <= 390.
2026-10-10T13:52:21Z s=4c6f18dd FINDING docs/demo/app.css:.dv-inspector learn=test: tests/e2e/docs.spec.ts Orders test asserts the box is at least 192 px tall.
2026-10-10T13:52:21Z s=4c6f18dd FINDING docs/index.html:How it works step 01 P08 learn=none: Wording.
2026-10-10T14:08:09Z s=4c6f18dd DONE fp=8d5498f86599 cov=99.7% paths=AGENTS.md,CHANGELOG.md,README.md,RELEASE.md(+13)
2026-10-10T14:08:09Z s=4c6f18dd FINDING docs/index.html:#dv-flow edges learn=none: Visual layout; the e2e checks the diagram's nodes, tones and detail output, not pixel routing.
2026-10-10T14:20:11Z s=4c6f18dd FAIL tests.e2e.1
2026-10-10T15:08:39Z s=4c6f18dd DONE fp=ba8f78cefcd5 cov=99.7% paths=AGENTS.md,CHANGELOG.md,Makefile,README.md(+16)
2026-10-10T15:08:39Z s=4c6f18dd FINDING playwright.config.ts:PORT learn=none: The fallback itself removes the failure class; a test that occupies 4179 would collide with the same dev server it guards against.
2026-10-10T15:08:39Z s=4c6f18dd FINDING docs/assets/site.js:showMetrics learn=test: docs.spec.ts checks the charts and table against metrics.json; the caption text is built from the same lookups.
2026-10-10T15:08:39Z s=4c6f18dd FINDING docs/assets/site.js:lineChart legend learn=none: Visual; the identity channel is also carried by direct labels and the table.
2026-10-10T15:08:39Z s=4c6f18dd FINDING docs/index.html:#perf lead L09 learn=none: Wording.
2026-10-10T15:26:44Z s=4c6f18dd DONE fp=bd9832212de3 cov=99.7% paths=AGENTS.md,CHANGELOG.md,Makefile,README.md(+17)
2026-10-10T15:26:44Z s=4c6f18dd FINDING docs/assets/json.js learn=test: docs.spec.ts asserts highlighted keys in the editor and the inspector.
2026-10-10T15:44:32Z s=4c6f18dd DONE fp=4369bc56f4e8 cov=99.7% paths=AGENTS.md,CHANGELOG.md,Makefile,README.md(+17)
2026-10-10T15:45:49Z s=4c6f18dd DONE fp=b63d252446ee cov=99.7% paths=AGENTS.md,CHANGELOG.md,Makefile,README.md(+17)
2026-10-10T16:12:11Z s=792882e7 DONE fp=898e82788445 cov=? paths=README.md
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
2026-10-10T16:16:08Z s=792882e7 DONE fp=bfa5032bf83f cov=? paths=README.md
2026-10-10T16:16:08Z s=792882e7 FINDING README.md:13 A04 learn=none: Human editorial choice, not a defect.
2026-11-15T20:21:41Z s=9ef67782 FAIL prose
2026-11-15T20:34:44Z s=9ef67782 DONE fp=167886e5c96f cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+41)
2026-11-15T20:34:44Z s=9ef67782 FINDING src/stream/optimization.test.ts:2 learn=verifier: rule tests.no-gitignored-inputs rejects .ts imports from artifacts/
2026-11-15T20:34:44Z s=9ef67782 FINDING scripts/verify.mjs:15 learn=memory: AGENTS.md project line: gates read only committed inputs; not regex-checkable for .mjs that legitimately write artifacts/
2026-11-15T20:34:44Z s=9ef67782 FINDING .oxlintrc.json learn=none: the lint verb in the gate already detects it
2026-11-15T20:34:44Z s=9ef67782 FINDING src/normalize.ts:57 createDataview learn=test: src/regressions.test.ts 'table/tree semantics' fails without the fix (2 tests)
2026-11-15T20:34:44Z s=9ef67782 FINDING README.md:Behavior changes in 0.5.0 learn=none: documentation completeness is not mechanically checkable
2026-11-15T20:34:44Z s=9ef67782 FINDING docs/index.html:intro-5 learn=test: tests/e2e/docs.spec.ts asserts #intro-size against stats.json
2026-11-15T20:34:44Z s=9ef67782 FINDING CHANGELOG.md learn=none: one-off editing loss
2026-11-15T20:34:44Z s=9ef67782 FINDING NOTICE:16 learn=none: factual correction
2026-11-15T20:34:44Z s=9ef67782 FINDING README.md:19 T06 learn=verifier: vae.py prose enforces T06
2026-11-15T20:34:44Z s=9ef67782 FINDING documentation/PERFORMANCE.md:binary kernels B01 learn=none: measurement-dependent
2026-11-15T20:34:44Z s=9ef67782 FINDING README.md:Speed P09 learn=none: wording
2026-11-15T20:34:44Z s=9ef67782 FINDING src/stream/key-cache.ts:149,199 + accounting-cache.ts:55 learn=test: src/stream/key-cache.test.ts 'timerless runtimes' child-process test fails on the old code
2026-11-15T21:54:14Z s=9ef67782 DONE fp=884a07c3b09e cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+41)
2026-11-15T21:54:14Z s=9ef67782 FINDING Makefile:dev learn=memory: .vae/CLI_GIST.md dev-site line + Makefile VERIFIED comment; an interactive server target is not gate-checkable
2026-11-16T09:35:22Z s=9ef67782 DONE fp=d0d8d4d0b5b8 cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+42)
2026-11-16T09:35:22Z s=9ef67782 FINDING docs/assets/site.css:40 .dv-fly-word learn=test: tests/e2e/docs.spec.ts 'the flythrough phrases stay centered when they wrap' fails without the CSS, passes with it
2026-11-16T10:51:25Z s=9ef67782 DONE fp=8155fc6dfe64 cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+42)
2026-11-16T10:51:25Z s=9ef67782 FINDING docs/index.html explorer 'unsafe path' preset learn=none: maintainer UX decision, no code defect; the __proto__ rejection stays covered by unit tests
2026-11-16T19:58:04Z s=9ef67782 DONE fp=177de7b931b4 cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+47)
2026-11-16T19:58:04Z s=9ef67782 FINDING src/tree.ts:evaluateTree learn=test: src/regressions.test.ts 'tree parent identity' pins the README identity rules the fast path must keep (string vs number, -0/0, first duplicate, non-finite rejec
2026-11-16T19:58:04Z s=9ef67782 FINDING package.json devDependencies defuss-dbsonl learn=none: measurement-dependent documentation; the adapter suite runs against 0.5.0 and the companion
2026-11-16T20:12:37Z s=9ef67782 DONE fp=21843eed6ac4 cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+49)
2026-11-16T20:12:37Z s=9ef67782 FINDING scripts/benchmark-mongodb.mjs learn=memory: .vae/CLI_GIST.md mongo-bench line; a benchmark against a live local server is not a gate test
2026-11-16T20:56:15Z s=9ef67782 DONE fp=8d1335b3d87f cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+49)
2026-11-16T20:56:15Z s=9ef67782 FINDING scripts/benchmark-mongodb.mjs fixedIndex + documentation/MONGODB.md learn=none: measurement-dependent documentation
2026-11-16T21:52:31Z s=9ef67782 FAIL env.example
2026-11-16T21:55:47Z s=9ef67782 DONE fp=f71910f3df11 cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+54)
2026-11-16T21:55:47Z s=9ef67782 FINDING docs/index.html + docs/demo/index.html defuss-shadcn pins learn=test: tests/unit/docs.test.ts and the Playwright suite load every page with integrity and fail on failed requests
2026-11-16T21:55:47Z s=9ef67782 FINDING docs/index.html#mongodb + docs/assets/site.js showComparison/dumbbell + docs/assets/mongodb.json learn=test: tests/e2e/docs.spec.ts 'the MongoDB comparison shows mongodb.json' derives pairing counts and gauge values from the JSON, toggles both switches and checks both 
2026-11-16T21:55:47Z s=9ef67782 FINDING package.json packageManager + bun.lock + Makefile + .github/workflows/verify.yml + scripts/package-tests.mjs + scripts/verify.mjs learn=memory: .vae/MEMORY.md toolchain line now records the decision; verify.mjs requires bun.lock
2026-11-16T21:55:47Z s=9ef67782 FINDING DBSJONL_HANDOFF.md learn=none: documentation for another repository's agent
2026-11-16T21:58:18Z s=9ef67782 DONE fp=d3a9bce1f3d8 cov=98.9% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+54)
2026-11-16T21:58:18Z s=9ef67782 FINDING docs/index.html hero + nav learn=none: copy and navigation change
2026-11-16T23:17:38Z s=9ef67782 DONE fp=4bcc447a5269 cov=99.0% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+57)
2026-11-16T23:17:38Z s=9ef67782 FINDING src/adapters/dbsonl.ts:nativeBatches learn=test: src/adapters/dbsonl.test.ts asserts one sizeOf call per row on the native path, and a new test proves a row swapped after sizing is measured on arrival and reje
2026-11-17T00:55:13Z s=9ef67782 DONE fp=cd64e6a97c58 cov=99.0% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+59)
2026-11-17T00:55:13Z s=9ef67782 FINDING package.json devDependencies defuss-dbsonl; src/adapters/dbsonl.test.ts matrix learn=test: the row-only matrix entries keep the fallback path tested against real storage, and the native test's scanBatches assertion fails if a future dbsonl drops the c
2026-11-17T01:18:33Z s=9ef67782 DONE fp=4ed13d36e4b3 cov=99.0% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+64)
2026-11-17T01:18:33Z s=9ef67782 FINDING src/adapters/dbsonl.ts:projector|projectedBatches; src/stream/executor.ts:emit; src/stream/projection.ts learn=test: src/adapters/dbsonl-projection.test.ts compares warm, cold and plain results on real memory and file storage and counts native scans; mutations (covers always t
2026-11-17T01:24:31Z s=9ef67782 DONE fp=4814d281b0d9 cov=99.0% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+64)
2026-11-17T01:24:31Z s=9ef67782 FINDING docs/assets/site.js:PAIRINGS|showComparison; docs/index.html #mongodb; tests/e2e/docs.spec.ts learn=test: tests/e2e/docs.spec.ts checks the headline count, loss/cross card, every gauge per switch, both chart row counts and the paired table against mongodb.json
2026-11-17T01:27:57Z s=9ef67782 DONE fp=1419cdea29fa cov=99.0% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+63)
2026-11-17T01:28:25Z s=9ef67782 DONE fp=2b32b168e60a cov=99.0% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+62)
2026-11-17T01:32:09Z s=9ef67782 DONE fp=4eea20d35a3b cov=99.0% paths=.github/workflows/verify.yml,.oxlintrc.json,AGENTS.md,ARCH.md(+118)
2026-11-17T01:32:09Z s=9ef67782 FINDING branch release/0.5.0 diff against origin/main; SHA256SUMS learn=none: review of already tested code plus a file deletion; no new defect found
