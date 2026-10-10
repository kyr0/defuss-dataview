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
