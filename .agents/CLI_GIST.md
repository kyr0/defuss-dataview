# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd` — only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->

- VERIFIED[release-gate] `npm run check` — lint, types, build, coverage, Playwright, tarball consumer, upstream hash verify (exit 0, 2026-10-04, Node 24, macOS)
- UNKNOWN[publish] `npm publish --access public` BC never run here; needs npm auth/OTP
