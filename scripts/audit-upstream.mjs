import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['tests/fixtures/upstream-src/index.ts'], bundle: true, platform: 'node', format: 'esm', target: 'es2022', outfile: 'artifacts/upstream-audit.mjs' });
const moduleUrl = pathToFileURL(resolve('artifacts/upstream-audit.mjs')).href;
const probes = [
  ['cycle-nontermination', `applyDataview([{id:1,parentId:2},{id:2,parentId:1}],createDataview({tree:{idField:'id',parentIdField:'parentId'}}));`, 'timeout'],
  ['deep-tree-stack-overflow', `const rows=Array.from({length:20000},(_,id)=>({id,parentId:id?id-1:null})); applyDataview(rows,createDataview({tree:{idField:'id',parentIdField:'parentId',includeAncestors:false}}));`, 'RangeError'],
  ['cycle-component-dropped', `const rows=[{id:0,parentId:null},{id:1,parentId:2},{id:2,parentId:1}]; assert.equal(applyDataview(rows,createDataview({tree:{idField:'id',parentIdField:'parentId',includeAncestors:false}})).length,3);`, 'AssertionError'],
  ['empty-expansion-list', `assert.equal(applyDataview([{id:1,parentId:null},{id:2,parentId:1}],createDataview({tree:{idField:'id',parentIdField:'parentId',expandedIds:[]}})).length,1);`, 'AssertionError'],
  ['structural-selection', `assert.equal(applyDataview([{id:{tenant:'a',key:1}}],createDataview({meta:{selectedRowIds:[{tenant:'a',key:1}]}}))[0].meta.isSelected,true);`, 'AssertionError'],
  ['nested-patch-id', `assert.equal(updateRows([{key:{id:1},name:'old'}],[1],[{name:'new'}],'key.id')[0].name,'new');`, 'AssertionError'],
  ['no-op-patch-identity', `const rows=[{id:1,name:'same'}];assert.equal(updateRows(rows,[1],[{name:'same'}]),rows);`, 'AssertionError'],
  ['meta-extension-loss', `const view={...createDataview(),application:'keep'};assert.equal(updateMeta(view,{selectedRowIds:[1]}).application,'keep');`, 'AssertionError'],
  ['inherited-field-access', `assert.equal(applyDataview([Object.assign(Object.create({score:99}),{id:1})],createDataview({filters:[{field:'score',op:'eq',value:99}]})).length,0);`, 'AssertionError'],
  ['nan-sort-instability', `assert.deepEqual(applyDataview([{id:1,n:NaN},{id:2,n:NaN}],createDataview({sorters:[{field:'n',direction:'desc'}]})).map(x=>x.row.id),[1,2]);`, 'AssertionError'],
];
const results = probes.map(([name, body, expected]) => {
  const source = `import assert from 'node:assert/strict'; import {applyDataview,createDataview,updateRows,updateMeta} from ${JSON.stringify(moduleUrl)}; try { ${body} } catch(error) { console.error(error.name + ': ' + error.message); process.exitCode=1; }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 1500 });
  const observation = child.error?.code === 'ETIMEDOUT' ? 'timeout' : (child.stderr?.trim().split('\n')[0] || 'passed');
  return { name, expected, observation, reproduced: observation.startsWith(expected) };
});
await writeFile('artifacts/upstream-audit.json', JSON.stringify({ repository: 'kyr0/defuss', commit: '50aae32aa9aea45612510703e75875ed98aa6386', results }, null, 2) + '\n');
console.table(results);
if (results.some(result => !result.reproduced)) process.exitCode = 1;
