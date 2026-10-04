import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const npm = (args, cwd = root) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], cwd)
  : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd);
await mkdir(join(root, 'artifacts'), { recursive: true });
const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', 'artifacts']));
assert(!packed.files.some(file => /^(?:src|tests|node_modules|coverage|artifacts)\//.test(file.path)), 'Unexpected source/development files in npm package');
const tarball = join(root, 'artifacts', packed.filename);
const consumer = await mkdtemp(join(tmpdir(), 'defuss-dataview-consumer-'));
try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'isolated-consumer', version: '1.0.0', private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer);
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
  run(process.execPath, ['esm.mjs'], consumer); run(process.execPath, ['commonjs.cjs'], consumer);
  const apiTests = await readFile(join(root, 'tests/types/api.ts'), 'utf8');
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  for (const [file, module, resolution] of [['api.mts', 'NodeNext', 'NodeNext'], ['api.cts', 'NodeNext', 'NodeNext'], ['api.ts', 'ESNext', 'Bundler']]) {
    await writeFile(join(consumer, file), apiTests);
    run(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'ES2022', '--lib', 'ES2022', '--module', module, '--moduleResolution', resolution, file], consumer);
  }
  await writeFile(join(consumer, 'entry.js'), "export {createDataview,applyDataview,evaluateDataview} from 'defuss-dataview';\n");
  const bundled = await build({ entryPoints: [join(consumer, 'entry.js')], bundle: true, format: 'esm', platform: 'browser', write: false, metafile: true });
  assert(Object.keys(bundled.metafile.inputs).every(input => resolve(input).startsWith(consumer)), 'Consumer resolved outside its packed installation');
  const report = { name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity, shasum: packed.shasum, size: packed.size, unpackedSize: packed.unpackedSize, files: packed.files.length, checks: ['isolated tarball install', 'ESM runtime', 'CommonJS runtime', 'SSR imports', 'NodeNext ESM types without DOM', 'NodeNext CommonJS types without DOM', 'Bundler types without DOM', 'isolated browser bundle'] };
  await writeFile(join(root, 'artifacts/package-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally { await rm(consumer, { recursive: true, force: true }); }
