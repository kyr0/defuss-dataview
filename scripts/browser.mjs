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
