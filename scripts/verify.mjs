import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(pkg.name, 'defuss-dataview'); assert.equal(pkg.private, undefined);
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0); assert.equal(pkg.sideEffects, false);
for (const entry of Object.values(pkg.exports['.'])) for (const file of Object.values(entry)) await access(file);
for (const file of ['README.md', 'ARCH.md', 'CHANGELOG.md', 'RELEASE.md', 'LICENSE', 'NOTICE', 'package-lock.json', 'dist/browser.mjs', 'dist/browser.min.mjs']) await access(file);
const provenance = JSON.parse(await readFile('tests/fixtures/provenance.json', 'utf8'));
for (const file of [...provenance.fixtures, ...provenance.originalTests]) {
  assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.sha256, `Upstream evidence changed: ${file.path}`);
}
console.log('Exports, dual formats, package metadata, standalone files, zero runtime dependencies and upstream fixture/test integrity verified.');
