.PHONY: setup clean build check test coverage test-browser e2e typecheck lint benchmark bench metrics benchmark-compare audit verify release-verify test-package dev pack site-metrics start stop restart status log
setup:
	bun install --frozen-lockfile
	bunx playwright install chromium
clean:
	bun run clean
build:
	bun run build
check:
	bun run check
test:
	bun run test
# vitest prints an `All files` table; the summary line is the gate-readable total.
coverage:
	bun run test:coverage
	@node -e "const s=require('./coverage/coverage-summary.json').total;console.log('TOTAL '+s.lines.pct+'%')"
test-browser:
	bun run test:browser
# Consumes the publishable artifacts: built browser bundle in Chromium, then the packed tarball in an isolated consumer.
e2e: build
	bun run test:browser
	bun run test:package
typecheck:
	bun run typecheck
lint:
	bun run lint
benchmark:
	bun run benchmark
bench: benchmark
metrics: build
	@cat dist/stats.json
benchmark-compare:
	bun run benchmark:compare
audit:
	bun run audit:upstream
verify: lint typecheck test coverage e2e release-verify
# Release integrity: exports, metadata and upstream fixture/test hashes.
release-verify:
	bun run verify
test-package:
	bun run test:package
# The website as GitHub Pages serves docs/; the build first refreshes docs/assets/defuss-dataview@<version>/.
# VERIFIED: serve takes a directory; `serve ./docs/index.html` exits with ENOTDIR (serve 14.2.8, 2026-11-15).
dev: build
	bunx serve@14.2.8 ./docs
# The website's measured numbers: coverage and test counts from fresh runs, then the scaling benchmarks of dist/.
site-metrics: build coverage test-browser
	node scripts/site-metrics.mjs
pack: check
	@echo 'Verified npm tarball is in artifacts/'
start stop restart status log: ; @echo "∅ $@: no service"

# Snapshot query benchmarks report raw timings and accounting trade-offs.
bench-stream: build
	bun run benchmark:stream
