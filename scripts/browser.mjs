import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
for (const minify of [false, true]) {
  await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify, sourcemap: true, outfile: minify ? 'dist/browser.min.mjs' : 'dist/browser.mjs' });
}
const minified = await readFile('dist/browser.min.mjs');
const stats = { esmBytes: (await readFile('dist/index.mjs')).length, commonjsBytes: (await readFile('dist/index.cjs')).length, browserMinifiedBytes: minified.length, browserGzipBytes: gzipSync(minified).length };
await writeFile('dist/stats.json', JSON.stringify(stats, null, 2) + '\n');
console.log(stats);
// Focused, dependency-free browser entry points for streaming consumers.
for (const [name, entry] of [['stream', 'src/stream.ts'], ['query', 'src/query.ts'], ['dbsonl', 'src/adapters/dbsonl.ts']]) {
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true, outfile: `dist/browser-${name}.mjs` });
}
// Each standalone bundle carries its own copy of the private capability registries, so a plan from one bundle cannot
// see the leased columns or trusted sizes a source from another bundle registers. The compute bundle therefore exports
// the stream API too: sources and plans then share one module instance.
// VERIFIED: tests/e2e/stream.spec.ts pins prepared columns through browser-compute.mjs alone (cacheBytesPinned > 0).
await build({ stdin: { contents: "export * from './src/stream.ts'; export * from './src/compute.ts';", resolveDir: '.', loader: 'ts', sourcefile: 'browser-compute.ts' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true, outfile: 'dist/browser-compute.mjs' });
// Browser integration tests consume the built package plus real DBSONL/OPFS dependencies.
await build({ entryPoints: ['tests/browser/dbsonl.worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: 'artifacts/dbsonl.worker.mjs' });

