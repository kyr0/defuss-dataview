.PHONY: setup clean build check test test-browser e2e typecheck lint benchmark benchmark-compare audit verify test-package dev pack
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
test-browser:
	npm run test:browser
e2e: test-browser
typecheck:
	npm run typecheck
lint:
	npm run lint
benchmark:
	npm run benchmark
benchmark-compare:
	npm run benchmark:compare
audit:
	npm run audit:upstream
verify:
	npm run verify
test-package:
	npm run test:package
dev:
	npm run dev
pack: check
	@echo 'Verified npm tarball is in artifacts/'
