# Agent memory

<!-- One tagged line per durable fact NOT derivable from code, git or docs:
- VERIFIED[scope] fact BC evidence
- HYPOTHESIS[scope] claim; falsifier=`cmd`
- UNKNOWN[scope] gap BC missing evidence
Replace stale lines instead of appending. Mechanizable lessons belong in tests or .vae/VERIFY.py.
Budget 4 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->

- VERIFIED[versions] npm has 0.1.0, 0.3.0, 0.3.1, 0.4.0; 0.5.0 is the next release and folds all unpublished internal stages (once labelled 0.6–0.9) BC `npm view defuss-dataview versions` 2026-11-15 + maintainer decision.
- VERIFIED[bench] compare speed only within one machine/run: the 0.4.0 README table (M4, Node 24) is faster on trees than an M5 Max/Node 26 run of the same code BC `npm run benchmark:paired` 2026-11-15 ratios 0.88–1.01 for trees.
- VERIFIED[toolchain] bun 1.4.3 is the package manager (bun.lock, packageManager); Node.js stays the runtime for tests, scripts and consumers BC maintainer decision 2026-11-16.
