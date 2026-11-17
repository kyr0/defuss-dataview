import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(pkg.name, 'defuss-dataview'); assert.equal(pkg.private, undefined);
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0); assert.equal(pkg.sideEffects, false);
for (const subpath of Object.values(pkg.exports)) for (const entry of Object.values(subpath)) for (const file of Object.values(entry)) await access(file);
for (const file of ['README.md', 'ARCH.md', 'CHANGELOG.md', 'RELEASE.md', 'LICENSE', 'NOTICE', 'bun.lock', 'dist/browser.mjs', 'dist/browser.min.mjs']) await access(file);
const provenance = JSON.parse(await readFile('tests/fixtures/provenance.json', 'utf8'));
for (const file of [...provenance.fixtures, ...provenance.originalTests]) {
  assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.sha256, `Upstream evidence changed: ${file.path}`);
}
console.log('Exports, dual formats, package metadata, standalone files, zero runtime dependencies and upstream fixture/test integrity verified.');

// The differential tests' reference oracle is a pre-optimization build; it must not drift with the code under test.
// VERIFIED: src/stream/optimization.test.ts imports exactly these two files (tests/reference/).
const reference = { 'tests/reference/query.mjs': '741876d9503d282b7211276dfba47d2b9e95003145673f056631fdd4e3b5a39c', 'tests/reference/stream.mjs': 'c22728cd84481fed1650eddb8ad8fc73218162b950a92f37f9e474e39c1bf287' };
for (const [file, hash] of Object.entries(reference)) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash, `Reference oracle changed: ${file}`);
console.log('Differential reference oracle verified.');
