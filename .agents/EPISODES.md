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
