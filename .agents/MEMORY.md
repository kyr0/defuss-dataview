# Agent memory

<!-- One tagged line per durable fact NOT derivable from code, git or docs:
- VERIFIED[scope] fact BC evidence
- HYPOTHESIS[scope] claim; falsifier=`cmd`
- UNKNOWN[scope] gap BC missing evidence
Replace stale lines instead of appending. Mechanizable lessons belong in tests or .agents/VERIFY.py.
Budget 4 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->

- VERIFIED[release] SHA256SUMS also hashes gitignored dist/ + artifacts/, which every build rewrites; regenerate it over the same file list right before tagging a release, not per commit.
- UNKNOWN[toolchain] npm kept BC existing published package + lockfile; bun migration never proposed to/decided by the maintainer.
