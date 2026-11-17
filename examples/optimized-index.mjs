import { createIndexedArraySource } from '../dist/stream.mjs';
const rows=Array.from({length:10000},(_,id)=>({id,rank:{score:(id*7919)%1009}}));
// Opt in because these immutable records have pure, stable property access.
const index=createIndexedArraySource(rows,{sorters:[{field:'rank.score',direction:'desc'}]}, {
  cacheSortKeys:true,
  maxSortKeyBytes:16*1024*1024,
});
await index.prepare();
const first=await index.readPage({limit:20});
const second=await index.readPage({after:first.nextCursor,limit:20});
console.log({buildProjectionBytes:index.sortKeyBytes,accountingCacheBytes:index.cachedBytes,first:first.rows,second:second.rows});
