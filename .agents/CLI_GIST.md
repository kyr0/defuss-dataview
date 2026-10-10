# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd` — only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->

- VERIFIED[release-gate] `npm run check` — lint, types, build, coverage, Playwright, tarball consumer, upstream hash verify (exit 0, 2026-10-04, Node 24, macOS)
- VERIFIED[publish] `npm publish --access public` — published 0.4.0 (registry 2026-10-04T10:25Z, gitHead 669ab2c, shasum 4152765… = artifacts tarball); needs npm auth/OTP, so the maintainer runs it
