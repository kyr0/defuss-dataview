import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, lstat, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
// bun packs and installs, as the project's package manager; Node runs every consumer, as an application would.
const bun = (args, cwd = root) => run(process.env.BUN || 'bun', args, cwd);
await mkdir(join(root, 'artifacts'), { recursive: true });
const tarball = bun(['pm', 'pack', '--ignore-scripts', '--quiet', '--destination', 'artifacts']).trim().split('\n').at(-1);
const bytes = await readFile(tarball);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packed = {
  name: manifest.name, version: manifest.version, filename: tarball.split('/').at(-1), size: (await stat(tarball)).size,
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex'),
  files: run('tar', ['-tzf', tarball]).trim().split('\n').map(path => ({ path: path.replace(/^package\//, '') })),
};
assert(!packed.files.some(file => /^(?:src|tests|node_modules|coverage|artifacts)\//.test(file.path)), 'Unexpected source/development files in npm package');
// VERIFIED: canonicalize; esbuild reports symlink-resolved inputs (macOS /var -> /private/var).
const consumer = await realpath(await mkdtemp(join(tmpdir(), 'defuss-dataview-consumer-')));
try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'isolated-consumer', version: '1.0.0', private: true, type: 'module' }));
  bun(['add', '--ignore-scripts', tarball], consumer);
  assert(!(await lstat(join(consumer, 'node_modules/defuss-dataview'))).isSymbolicLink());
  const smoke = `
const {createDataview,applyDataview,evaluateDataview,toggleExpanded,updateRows}=api;
const rows=[{id:1,parentId:null,name:'a'},{id:2,parentId:1,name:'b'}];
const view=createDataview({tree:{idField:'id',parentIdField:'parentId'},pageSize:1});
assert.equal(evaluateDataview(rows,view).visibleRows,2);
assert.equal(applyDataview(rows,toggleExpanded(view,1)).length,1);
assert.equal(updateRows(rows,[2],[{name:'renamed'}])[1].name,'renamed');
assert.equal(rows[1].name,'b');
assert.equal(applyDataview([{id:1,parentId:2},{id:2,parentId:1}],createDataview({tree:{idField:'id',parentIdField:'parentId'}})).length,2);
`;
  const guard = "Object.defineProperty(globalThis,'window',{get(){throw Error('Unexpected browser access during SSR');},configurable:true});\n";
  await writeFile(join(consumer, 'esm.mjs'), "import assert from 'node:assert/strict';\n" + guard + "const api=await import('defuss-dataview');\n" + smoke);
  await writeFile(join(consumer, 'commonjs.cjs'), "const assert=require('node:assert/strict');\n" + guard + "const api=require('defuss-dataview');\n" + smoke);
  const streamSmoke = `
(async () => {
  const streaming = await import('defuss-dataview/stream');
  const queries = await import('defuss-dataview/query');
  const integration = await import('defuss-dataview/adapters/dbsonl');
  assert.equal(typeof integration.createDbsonlSource, 'function');
  assert(queries.compileQuery({filters:[{field:'n',op:'eq',value:2n}]}).matches({n:2n}));
  const result = await streaming.evaluateStream(streaming.createArraySource([{id:1,n:100n},{id:2,n:2n}]), {sorters:[{field:'n'}],limit:1});
  assert.equal(result.rows[0].id,2); assert.equal(result.summary.totalMatches,2);
  const immutable = streaming.createImmutableArraySource([{id:1}]);
  assert.equal(immutable.replace([{id:2}]),1n);
  assert.equal((await streaming.evaluateStream(immutable)).rows[0].id,2);
  assert.equal((await immutable.prepare()).cachedRows,1);
  const plan = streaming.prepareStreamQuery({filters:[{field:'id',op:'gte',value:2}]});
  assert.equal((await plan.evaluate(immutable)).rows[0].id,2);
  const index = streaming.createIndexedArraySource([{id:2},{id:1}],{sorters:[{field:'id'}]});
  const first = await index.readPage({limit:1});
  assert.equal(first.rows[0].id,1);
  assert.equal((await index.readPage({after:first.nextCursor})).rows[0].id,2);
  const cached = streaming.createImmutableArraySource([{id:2,n:3n},{id:1,n:1n}], {keyCache:{blockIndex:true,policy:'tiny-lfu'}});
  await cached.prepareKeys(['n']);
  assert.deepEqual((await streaming.evaluateStream(cached,{sorters:[{field:'n'}]})).rows.map(row=>row.id),[1,2]);
  const absent = await streaming.evaluateStream(cached,{filters:[{field:'n',op:'gt',value:9n}]},{count:'exact'});
  assert.equal(absent.summary.totalMatches,0);
  assert.equal(cached.keyCacheStats.prunedRows,2);
  assert.equal(cached.keyCacheStats.pinnedEntries,0);
  cached.clearKeyCache(); assert.equal(cached.keyCacheStats.bytes,0);
  const projected = streaming.createIndexedArraySource([{id:2,n:3n},{id:1,n:1n}],{sorters:[{field:'n'}]},{cacheSortKeys:true});
  assert.equal((await projected.readPage({limit:1})).rows[0].id,1);
  const compute = await import('defuss-dataview/compute');
  const q = compute.forRows();
  const orders = streaming.createImmutableArraySource([{c:'de',n:2,big:1n},{c:'fr',n:3,big:2n},{c:'de',n:4,big:3n}]);
  const grouped = await q.aggregate({groupBy:{c:q.field('c')},measures:{n:q.count(),total:q.sum(q.field('n')),big:q.sumBigInt(q.field('big'))},orderBy:[{field:'total',direction:'desc'}]}).evaluate(orders,{},{count:'exact'});
  assert.deepEqual(grouped.rows,[{c:'de',n:2,total:6,big:4n},{c:'fr',n:1,total:3,big:2n}]);
  assert.equal(grouped.summary.totalResultRows,2);
  const shown = await q.view({select:{n:q.field('n')},totals:{total:q.sum(q.field('n'))}}).evaluate(orders,{limit:1});
  assert.deepEqual([shown.rows,shown.totals],[[{n:2}],{total:9}]);
  assert.deepEqual((await q.rows({select:{double:q.mul(q.field('n'),q.literal(2))},orderBy:[{expr:q.field('n'),direction:'desc'}]}).evaluate(orders,{limit:1})).rows,[{double:8}]);
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
  await writeFile(join(consumer, 'stream.mjs'), "import assert from 'node:assert/strict';\n" + guard + streamSmoke);
  await writeFile(join(consumer, 'stream.cjs'), "const assert=require('node:assert/strict');\n" + guard + streamSmoke.replaceAll("await import(", "require("));
  run(process.execPath, ['esm.mjs'], consumer); run(process.execPath, ['commonjs.cjs'], consumer);
  run(process.execPath, ['stream.mjs'], consumer); run(process.execPath, ['stream.cjs'], consumer);
  // The shipped examples are documentation: run them from the installed package, where `../dist` is the packed build.
  // The DBSONL examples need the optional database package: the consumer installs the version this checkout pins,
  // as an application would, so those examples also run against the packed build.
  bun(['add', '--ignore-scripts', `defuss-dbsonl@${manifest.devDependencies['defuss-dbsonl']}`], consumer);
  const installed = join(consumer, 'node_modules/defuss-dataview/examples');
  const examples = packed.files.map(file => file.path).filter(path => /^examples\/[^/]+\.mjs$/.test(path));
  assert(examples.length >= 7, 'Expected the runnable examples in the npm package');
  for (const example of examples) run(process.execPath, [join(installed, example.slice('examples/'.length))], consumer);
  const apiTests = await readFile(join(root, 'tests/types/api.ts'), 'utf8');
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  for (const [file, module, resolution] of [['api.mts', 'NodeNext', 'NodeNext'], ['api.cts', 'NodeNext', 'NodeNext'], ['api.ts', 'ESNext', 'Bundler']]) {
    await writeFile(join(consumer, file), apiTests);
    run(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'ES2022', '--lib', 'ES2022', '--module', module, '--moduleResolution', resolution, file], consumer);
  }
  await writeFile(join(consumer, 'entry.js'), "export {createDataview,applyDataview,evaluateDataview} from 'defuss-dataview'; export * from 'defuss-dataview/stream'; export * from 'defuss-dataview/compute'; export * from 'defuss-dataview/query'; export * from 'defuss-dataview/adapters/dbsonl';\n");
  const bundled = await build({ entryPoints: [join(consumer, 'entry.js')], bundle: true, format: 'esm', platform: 'browser', write: false, metafile: true });
  assert(Object.keys(bundled.metafile.inputs).every(input => resolve(input).startsWith(consumer)), 'Consumer resolved outside its packed installation');
  const report = { name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity, shasum: packed.shasum, size: packed.size, files: packed.files.length, checks: ['isolated tarball install', 'ESM runtime (all entries)', 'CommonJS runtime (all entries)', 'SSR imports', 'NodeNext ESM types without DOM', 'NodeNext CommonJS types without DOM', 'Bundler types without DOM', 'isolated browser bundle', 'packaged examples'] };
  await writeFile(join(root, 'artifacts/package-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally { await rm(consumer, { recursive: true, force: true }); }
