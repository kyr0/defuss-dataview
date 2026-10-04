.PHONY: setup clean build check test coverage test-browser e2e typecheck lint benchmark bench metrics benchmark-compare audit verify release-verify test-package dev pack start stop restart status log
setup:
	npm ci
	npx playwright install chromium
clean:
	npm run clean
build:
	npm run build
check:
	npm run check
test:
	npm test
# vitest prints an `All files` table; the summary line is the gate-readable total.
coverage:
	npm run test:coverage
	@node -e "const s=require('./coverage/coverage-summary.json').total;console.log('TOTAL '+s.lines.pct+'%')"
test-browser:
	npm run test:browser
# Consumes the publishable artifacts: built browser bundle in Chromium, then the packed tarball in an isolated consumer.
e2e: build
	npm run test:browser
	npm run test:package
typecheck:
	npm run typecheck
lint:
	npm run lint
benchmark:
	npm run benchmark
bench: benchmark
metrics: build
	@cat dist/stats.json
benchmark-compare:
	npm run benchmark:compare
audit:
	npm run audit:upstream
verify: lint test coverage e2e
# Release integrity: exports, metadata and upstream fixture/test hashes.
release-verify:
	npm run verify
test-package:
	npm run test:package
dev:
	npm run dev
pack: check
	@echo 'Verified npm tarball is in artifacts/'
start stop restart status log: ; @echo "∅ $@: no service"
