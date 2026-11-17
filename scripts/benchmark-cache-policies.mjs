import assert from 'node:assert/strict';
import { writeFile,readFile,readdir } from 'node:fs/promises';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
const directory=process.argv[2]??'dist';
const api=await import('../'+directory+'/stream.mjs');
const engine=process.versions.bun?'bun':'node';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const report={version,engine,node:process.version,bun:process.versions.bun,cpu:cpus()[0]?.model,directory,method:'Fixed immutable rows, same three-column accounting cap, one warmup and five samples. Rotate policy execution order. Source/accounting preparation excluded; key admission/build and queries included. Compare every result to a native stable-sort oracle. Policy metadata reported separately.',traces:[]};
const n=12000,rows=Array.from({length:n},(_,id)=>{const values={};for(let f=0;f<24;f++)values['f'+f]=(id*7919+f*31)%1009;return{id,values};});
const keys=Array.from({length:24},(_,f)=>'values.f'+f);
const expected=keys.map((_,f)=>[...rows].sort((a,b)=>a.values['f'+f]-b.values['f'+f]).slice(0,5).map(r=>r.id));
const cap=3*(64+2*'values.f23'.length+n*8);
const hot=Array.from({length:40},(_,i)=>i%2);
const fullHot=Array.from({length:60},(_,i)=>i%3);
const traces={full_hot_set_scan:[...fullHot,...Array.from({length:3},()=>Array.from({length:21},(_,i)=>i+3)).flat(),...fullHot],hot_reuse:[...hot,...hot,...hot],scan_pollution:[...hot,...Array.from({length:3},()=>Array.from({length:22},(_,i)=>i+2)).flat(),...hot],changing_hot_set:[...hot,...Array.from({length:80},(_,i)=>16+i%2)]};
for(const[name,trace]of Object.entries(traces)) {
 const policies=['off','slru','tiny-lfu'],samples=Object.fromEntries(policies.map(p=>[p,[]])),latencies=Object.fromEntries(policies.map(p=>[p,[]])),stats={};
 for(let round=-1;round<5;round++)for(let j=0;j<policies.length;j++) {
  const policy=policies[(j+round+1)%policies.length];
  const source=api.createImmutableArraySource(rows,policy==='off'?{}:{keyCache:{maxBytes:cap,policy}});await source.prepare();
  let elapsed=0;
  for(const f of trace){const start=performance.now();const r=await api.evaluateStream(source,{sorters:[{field:keys[f]}],limit:5});const ms=performance.now()-start;elapsed+=ms;if(round>=0)latencies[policy].push(ms);assert.deepEqual(r.rows.map(r=>r.id),expected[f]);}
  if(round>=0)samples[policy].push(elapsed);
  stats[policy]=source.keyCacheStats;
  if(stats[policy]){assert(stats[policy].peakBytes<=cap);assert.equal(stats[policy].pinnedEntries,0);}
 }
 const result={name,queries:trace.length,rows:n,columnCapBytes:cap,policies:Object.fromEntries(policies.map(p=>[p,{medianMs:[...samples[p]].sort((a,b)=>a-b)[2],samplesMs:samples[p],queryLatencyMs:{p50:[...latencies[p]].sort((a,b)=>a-b)[Math.floor(latencies[p].length*0.5)],p95:[...latencies[p]].sort((a,b)=>a-b)[Math.floor(latencies[p].length*0.95)],samples:latencies[p]},stats:stats[p]}]))};
 report.traces.push(result);console.log(name,JSON.stringify(Object.fromEntries(policies.map(p=>[p,{ms:Number(result.policies[p].medianMs.toFixed(2)),builds:stats[p]?.builds,hits:stats[p]?.hits,evictions:stats[p]?.evictions}]))));
}
report.moduleHashes={};for(const name of(await readdir(directory,{recursive:true})).sort())if(name.endsWith('.mjs'))report.moduleHashes[directory+'/'+name]=createHash('sha256').update(await readFile(directory+'/'+name)).digest('hex');
report.scriptSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
await writeFile(`artifacts/cache-policies${directory==='dist'?'':'-development'}-${engine}.json`,JSON.stringify(report,null,2)+'\n');
