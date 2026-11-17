import { createImmutableArraySource, evaluateStream } from '../dist/stream.mjs';
const rows=Array.from({length:10000},(_,id)=>({id,metrics:{score:id},category:id%2?'active':'idle'}));
const source=createImmutableArraySource(rows,{keyCache:{maxBytes:1024*1024,policy:'slru',blockIndex:true}});
await source.prepare();await source.prepareKeys(['metrics.score','category']);
const result=await evaluateStream(source,{filters:[{field:'metrics.score',op:'gte',value:9000},{field:'category',op:'eq',value:'active'}],sorters:[{field:'metrics.score',direction:'desc'}],limit:10},{count:'exact'});
if(result.summary.totalMatches!==500||result.rows[0].id!==9999)throw new Error('Unexpected cached query');
console.log({ids:result.rows.map(r=>r.id),summary:result.summary,cache:source.keyCacheStats});
source.clearKeyCache();if(source.keyCacheStats.bytes!==0)throw new Error('Cache still pinned');
