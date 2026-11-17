import { performance } from 'node:perf_hooks';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createArraySource, evaluateStream, streamQuery } from '../dist/stream.mjs';
import { createDataview, evaluateDataview } from '../dist/index.mjs';
const environment = { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length };
const scenarios = [];
async function measure(name, count, run) {
  for (let i = 0; i < 2; i++) await run();
  const samplesMs = []; let summary;
  for (let i = 0; i < 7; i++) {
    const started = performance.now(); summary = await run(); samplesMs.push(performance.now() - started);
  }
  const sorted = [...samplesMs].sort((a,b) => a-b);
  scenarios.push({ name, rows: count, medianMs: sorted[3], p95Ms: sorted[6], samplesMs, summary });
}
for (const count of [100_000, 1_000_000]) {
  const rows = Array.from({length:count},(_,id)=>({id,score:(id*7919)%1009}));
  const source = createArraySource(rows, {isolation:'immutable'});
  const filters = [{field:'score',op:'gte',value:500}];
  const sorters = [{field:'score',direction:'desc'}];
  const oracle = rows.filter(r=>r.score>=500).sort((a,b)=>b.score-a.score).slice(0,50).map(r=>r.id);
  await measure('array full sort',count,()=>{
    const r=evaluateDataview(rows,createDataview({filters,sorters,pageSize:50}));
    assert.deepEqual(r.entries.map(e=>e.row.id),oracle);return {matched:r.matchedRows};
  });
  await measure('stream top-k / accounted values',count,async()=>{
    const r=await evaluateStream(source,{filters,sorters,limit:50},{batchSize:512,count:'exact'});
    assert.deepEqual(r.rows.map(r=>r.id),oracle);return r.summary;
  });
  await measure('stream top-k / fixed-schema accounting',count,async()=>{
    // Caller explicitly knows this immutable numeric-only row representation.
    const r=await evaluateStream(source,{filters,sorters,limit:50},{batchSize:512,count:'exact',sizeOf:()=>96});
    assert.deepEqual(r.rows.map(r=>r.id),oracle);return r.summary;
  });
  await measure('stream early page',count,async()=>{
    const r=await evaluateStream(source,{filters,limit:50},{batchSize:128});
    assert.equal(r.rows.length,50);return r.summary;
  });
}
// Constant source memory: demonstrate the executor without materializing its corpus.
const total = 1_000_000;
const generated = { async open() { return {
  consistency:'snapshot',revision:1,count:total,
  async *scan({batchSize}) { for(let start=0;start<total;start+=batchSize) yield Array.from({length:Math.min(batchSize,total-start)},(_,i)=>({id:start+i,score:(start+i)%100})); },
  async close() {},
}; } };
await measure('generated source full scan / no output retention',total,async()=>{
  let count=0,summary;
  for await(const event of streamQuery(generated,{}, {batchSize:512,sizeOf:()=>96,maxBufferedRows:1})) {
    if(event.type==='batch')count+=event.rows.length;else summary=event.summary;
  }
  assert.equal(count,total);return summary;
});
await mkdir('artifacts',{recursive:true});
const {version}=JSON.parse(await readFile('package.json','utf8'));
const report={version,measuredAt:new Date().toISOString(),environment,method:'Two warmups, seven timed runs. Input setup excluded; source open/membership copy, execution and result assertions included. p95 is nearest-rank over seven samples. Accounting is not heap measurement. Array input uses immutable mode; generated source holds one batch.',scenarios};
await writeFile('artifacts/stream-benchmark.json',JSON.stringify(report,null,2)+'\n');
console.table(scenarios.map(({name,rows,medianMs,p95Ms,summary})=>({name,rows,medianMs:+medianMs.toFixed(2),p95Ms:+p95Ms.toFixed(2),scanned:summary?.scannedRows,retained:summary?.peakBufferedRows})));
