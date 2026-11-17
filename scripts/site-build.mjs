// Build the documentation against the exact local artifact under review.
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const path = `assets/defuss-dataview@${version}`;
// One versioned folder only: the site must never serve a bundle other than the one under review.
// VERIFIED: tests/e2e/docs.spec.ts fails when the import-map pin differs from package.json's version.
for (const name of await readdir('docs/assets')) if (name.startsWith('defuss-dataview@') && `assets/${name}` !== path) await rm(`docs/assets/${name}`, { recursive: true });
await mkdir(`docs/${path}`, { recursive: true });
for (const name of ['browser.min.mjs', 'browser.min.mjs.map', 'browser-stream.mjs', 'browser-stream.mjs.map', 'browser-compute.mjs', 'browser-compute.mjs.map', 'browser-query.mjs', 'browser-query.mjs.map', 'browser-dbsonl.mjs', 'browser-dbsonl.mjs.map', 'stats.json']) await copyFile(`dist/${name}`, `docs/${path}/${name}`);
const stats = JSON.parse(await readFile('dist/stats.json', 'utf8'));
let html = await readFile('docs/index.html', 'utf8');
const oldMap = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
const oldUrl = oldMap.imports['defuss-dataview'];
const oldHash = oldMap.integrity[oldUrl];
const hash = 'sha384-' + createHash('sha384').update(await readFile('dist/browser.min.mjs')).digest('base64');
html = html.replaceAll(oldUrl, `./${path}/browser.min.mjs`).replaceAll(oldHash, hash);
// The live compute panel imports the compute bundle through the same import map, pinned by its own hash, so the
// browser refuses a bundle other than the one under review.
// VERIFIED: tests/e2e/docs.spec.ts runs the panel through this import map; a wrong hash would fail its module load.
const computeHash = 'sha384-' + createHash('sha384').update(await readFile('dist/browser-compute.mjs')).digest('base64');
const inline = (entries) => `{ ${Object.entries(entries).map(([key, value]) => `"${key}": "${value}"`).join(', ')} }`;
const imports = { 'defuss-dataview': `./${path}/browser.min.mjs`, 'defuss-dataview/compute': `./${path}/browser-compute.mjs` };
const integrity = { [imports['defuss-dataview']]: hash, [imports['defuss-dataview/compute']]: computeHash };
html = html.replace(/(<script type="importmap">)[\s\S]*?(<\/script>)/, (_, open, close) =>
  `${open}\n    {\n      "imports": ${inline(imports)},\n      "integrity": ${inline(integrity)}\n    }\n  ${close}`);
html = html.replace(/v0\.\d+\.\d+(?=<\/span>Zero dependencies)/, `v${version}`)
  .replace(/defuss-dataview@0\.\d+\.\d+/g, `defuss-dataview@${version}`)
  .replace(/MIT licensed · 0\.\d+\.\d+/, `MIT licensed · ${version}`)
  .replace(/Zero dependencies · [\d.]+&nbsp;kB gzip/, `Zero dependencies · ${(stats.browserGzipBytes / 1000).toFixed(1)}&nbsp;kB gzip`)
  .replace(/(<div class="mk-stat" id="stat-gzip"><span class="mk-stat-value">)[\d,]+ B/, `$1${stats.browserGzipBytes.toLocaleString('en')} B`)
  .replace(/[\d,]+ B minified: the standalone/, `${stats.browserMinifiedBytes.toLocaleString('en')} B minified: the standalone`)
  .replace(/(<span id="intro-size"><strong>)[\d.]+&nbsp;kB(<\/strong> \(<strong>)[\d.]+(&nbsp;kB gzip)/, `$1${(stats.browserMinifiedBytes / 1000).toFixed(1)}&nbsp;kB$2${(stats.browserGzipBytes / 1000).toFixed(1)}$3`);
for (const [id, key] of [['stats-esm', 'esmBytes'], ['stats-cjs', 'commonjsBytes'], ['stats-min', 'browserMinifiedBytes'], ['stats-gzip', 'browserGzipBytes']]) {
  html = html.replace(new RegExp(`(id="${id}"[^>]*><code>\\s*<span class="mk-code-block-k">"${key}"</span>: <span class="dv-json-literal">)\\d+`), `$1${stats[key]}`);
}
await writeFile('docs/index.html', html);
let worker = await readFile('docs/demo/search.worker.js', 'utf8');
worker = worker.replace(/(?:https:\/\/cdn.jsdelivr.net\/npm\/defuss-dataview@[^']+|\.\.\/assets\/defuss-dataview@[^']+)/g, `../${path}/browser.min.mjs`);
await writeFile('docs/demo/search.worker.js', worker);
// The demo's Reports tab imports the compute bundle by path, pinned to the version under review like the worker.
let demo = await readFile('docs/demo/app.js', 'utf8');
demo = demo.replace(/\.\.\/assets\/defuss-dataview@[^/']+\/browser-compute\.mjs/g, `../${path}/browser-compute.mjs`);
await writeFile('docs/demo/app.js', demo);
let stream = await readFile('docs/stream.html', 'utf8');
stream = stream.replace(/assets\/defuss-dataview@0\.\d+\.\d+/g, path);
await writeFile('docs/stream.html', stream);
