import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createImmutableArraySource } from './array.js';
import { evaluateStream, streamQuery } from './executor.js';
import { yieldToHost } from './common.js';
import { compileQuery } from '../query.js';
import type { StreamRequest } from './types.js';
import { BlockSummary, scalarHash } from './block-summary.js';
import { FrequencyAdmission, SecondTouch } from './admission.js';

describe('revision-scoped bounded key cache', () => {
  it('admits repeated fields and preserves generic/cached results under either policy', async () => {
    const rows = Array.from({ length: 4101 }, (_, id) => ({ id, a: { b: (id * 7919) % 1009 }, group: id % 7 }));
    const request = { sorters: [{ field: 'a.b', direction: 'desc' as const }, { field: 'group' }], offset: 7, limit: 31 };
    const expected = await evaluateStream(createImmutableArraySource(rows), request);
    for (const policy of ['slru', 'tiny-lfu'] as const) {
      const source = createImmutableArraySource(rows, { keyCache: { policy } });
      expect(await evaluateStream(source, request)).toEqual(expected);
      expect(source.keyCacheStats?.builds).toBe(0);
      expect(await evaluateStream(source, request)).toEqual(expected);
      expect(source.keyCacheStats?.builds).toBe(2);
      expect(await evaluateStream(source, request)).toEqual(expected);
      expect(source.keyCacheStats?.hits).toBeGreaterThanOrEqual(2);
      expect(source.keyCacheStats?.pinnedEntries).toBe(0);
      expect(source.keyCacheStats!.peakBytes).toBeLessThanOrEqual(source.keyCacheStats!.maxBytes);
    }
  });
  it('accounts fixed column headers and falls back when even one column cannot fit', async () => {
    const rows = [{ a: 2 }, { a: 1 }], bytes = 64 + 2 + 2 * 8;
    for (const maxBytes of [0, bytes - 1, bytes]) {
      const source = createImmutableArraySource(rows, { keyCache: { maxBytes } });
      await source.prepareKeys(['a', 'a']);
      expect(source.keyCacheStats!.bytes).toBe(maxBytes < bytes ? 0 : bytes);
      expect((await evaluateStream(source, { sorters: [{ field: 'a' }] })).rows).toEqual([{ a: 1 }, { a: 2 }]);
      source.clearKeyCache(); expect(source.keyCacheStats!.bytes).toBe(0);
    }
    const off = createImmutableArraySource(rows);
    expect(await off.prepareKeys(['a'])).toBeUndefined(); expect(off.keyCacheStats).toBeUndefined(); off.clearKeyCache();
  });
  it('pins active readers, falls back under pressure and invalidates replacement without changing old results', async () => {
    const rows = Array.from({ length: 8 }, (_, id) => ({ id, a: 8 - id, b: id }));
    const source = createImmutableArraySource(rows, { keyCache: { maxBytes: 130 } });
    await source.prepareKeys(['a']);
    const iterator = streamQuery(source, { sorters: [{ field: 'a' }] }, { batchSize: 1 });
    const first = await iterator.next(); expect(first.value!.type).toBe('batch');
    expect(source.keyCacheStats!.pinnedEntries).toBe(1);
    await source.prepareKeys(['b']); expect(source.keyCacheStats!.bytes).toBe(130);
    source.clearKeyCache(); expect(source.keyCacheStats!.bytes).toBe(130);
    source.replace([{ id: 99, a: -1, b: 99 }]);
    const rest: number[] = [];
    for await (const event of iterator) if (event.type === 'batch') rest.push(...event.rows.map(r => r.id));
    expect(rest).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(source.keyCacheStats!.bytes).toBe(0);
    await source.prepareKeys(['a']);
    expect((await evaluateStream(source, { sorters: [{ field: 'a' }] })).rows[0].id).toBe(99);
  });
  it('protects popular fields, evicts unpinned entries and caps reservations', async () => {
    const rows = Array.from({ length: 8 }, (_, id) => ({ a: id, b: 8-id, c: id % 3 }));
    const source = createImmutableArraySource(rows, { keyCache: { maxBytes: 260, policy: 'tiny-lfu' } });
    await source.prepareKeys(['a','b']);
    for (let i=0;i<8;i++) await evaluateStream(source,{sorters:[{field:'a'}],limit:1});
    const before = source.keyCacheStats!;
    await evaluateStream(source,{sorters:[{field:'c'}],limit:1});
    await evaluateStream(source,{sorters:[{field:'c'}],limit:1});
    expect(source.keyCacheStats!.evictions).toBeGreaterThan(before.evictions);
    expect(source.keyCacheStats!.peakBytes).toBeLessThanOrEqual(260);
    const builds = source.keyCacheStats!.builds;
    await evaluateStream(source,{sorters:[{field:'a'}],limit:1});
    expect(source.keyCacheStats!.builds).toBe(builds);
  });
  it('adapts segmented LRU to a new hot set without probation thrashing', async () => {
    const rows=Array.from({length:1000},(_,n)=>({a:n,b:-n,c:n%7,d:n%11}));
    const source=createImmutableArraySource(rows,{keyCache:{maxBytes:3*(64+2+8000),policy:'slru'}});
    for(const field of [...Array(12).fill(['a','b']).flat(),...Array(12).fill(['c','d']).flat()])await evaluateStream(source,{sorters:[{field}],limit:1});
    expect(source.keyCacheStats!.builds).toBe(4);
    expect(source.keyCacheStats!.peakBytes).toBeLessThanOrEqual(source.keyCacheStats!.maxBytes);
  });
  it('aggregates pre-scan key failures with close failures while releasing reservations', async () => {
    const source=createImmutableArraySource([{get a():number{throw new Error('key failure');}}],{keyCache:{}});
    const wrapped={async open(){const session=await source.open(),close=session.close;session.close=async()=>{await close();throw new Error('close failure');};return session;}};
    // First touch bypasses projection; second touch takes the pre-scan build path.
    await expect(evaluateStream(source,{sorters:[{field:'a'}]},{sizeOf:()=>1})).resolves.toBeDefined();
    const error=await evaluateStream(wrapped,{sorters:[{field:'a'}]},{sizeOf:()=>1}).catch(e=>e);
    expect(error).toBeInstanceOf(AggregateError);expect(error.errors.map((e:Error)=>e.message)).toEqual(['key failure','close failure']);
    expect(source.keyCacheStats).toMatchObject({bytes:0,pinnedEntries:0});
  });
  it('shares a build while cancellation remains per caller', async () => {
    let reads = 0;
    const rows = Array.from({ length: 50000 }, (_, id) => ({ id, get a() { reads++; return id; } }));
    const source = createImmutableArraySource(rows, { keyCache: {} });
    const controller = new AbortController();
    const first = source.prepareKeys(['a'], { signal: controller.signal });
    const second = source.prepareKeys(['a']);
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'ABORTED' });
    await second;
    expect(reads).toBe(rows.length);
    expect(source.keyCacheStats).toMatchObject({ builds: 1, pinnedEntries: 0, buildingEntries: 0 });
  });
  it('releases cancelled unobserved builds and clear-during-build reservations', async () => {
    const rows = Array.from({ length: 50000 }, (_, a) => ({ a }));
    const source = createImmutableArraySource(rows, { keyCache: {} });
    const controller = new AbortController(), first = source.prepareKeys(['a'], { signal: controller.signal });
    controller.abort(); await expect(first).rejects.toMatchObject({ code: 'ABORTED' });
    await yieldToHost(); await yieldToHost();
    expect(source.keyCacheStats).toMatchObject({ bytes: 0, entries: 0, buildingEntries: 0 });
    const next = source.prepareKeys(['a']); source.clearKeyCache(); await next;
    expect(source.keyCacheStats).toMatchObject({ bytes: 0, entries: 0 });
  });
  it('shares a late build error without leaking bytes or unhandled rejections', async () => {
    const rows = Array.from({ length: 50000 }, (_, id) => ({ get a() { if (id === 20000) throw new Error('key failure'); return id; } }));
    const source = createImmutableArraySource(rows, { keyCache: {} });
    const results = await Promise.allSettled([source.prepareKeys(['a']), source.prepareKeys(['a'])]);
    expect(results.map(r => r.status)).toEqual(['rejected','rejected']);
    expect(source.keyCacheStats).toMatchObject({ bytes: 0, entries: 0, pinnedEntries: 0 });
  });
  it('releases query leases on early return, callback failure and collection failure', async () => {
    const source = createImmutableArraySource(Array.from({length:100},(_,a)=>({a})),{keyCache:{}});
    await source.prepareKeys(['a']);
    const iterator=streamQuery(source,{sorters:[{field:'a'}]},{batchSize:1});
    await iterator.next();await iterator.return(undefined);
    expect(source.keyCacheStats!.pinnedEntries).toBe(0);
    await expect(evaluateStream(source,{sorters:[{field:'a'}]},{sizeOf:()=>{throw new Error('accounting');}})).rejects.toThrow('accounting');
    expect(source.keyCacheStats!.pinnedEntries).toBe(0);
    await expect(evaluateStream(source,{sorters:[{field:'a'}]},{maxBufferedRows:1})).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});
    expect(source.keyCacheStats!.pinnedEntries).toBe(0);
  });
  it('does not authorize decorated scan methods through public cache-like metadata', async () => {
    const source=createImmutableArraySource([{a:2},{a:1}],{keyCache:{}});await source.prepareKeys(['a']);
    const before=source.keyCacheStats!.hits;
    const wrapped={async open(){const session=await source.open(),scan=session.scan.bind(session);session.scan=request=>scan(request);return session;}};
    expect((await evaluateStream(wrapped,{sorters:[{field:'a'}]})).rows).toEqual([{a:1},{a:2}]);
    expect(source.keyCacheStats!.hits).toBe(before);
  });
  it('validates cache options, paths and record shapes', async () => {
    for(const keyCache of [null,[],{policy:'lru'},{maxBytes:-1},{blockIndex:1}])expect(()=>createImmutableArraySource([],{keyCache:keyCache as never})).toThrow();
    const source=createImmutableArraySource([{}],{keyCache:{}});
    await expect(source.prepareKeys(['a.__proto__'])).rejects.toThrow();
    expect(()=>source.prepareKeys('a' as never)).toThrow();
    await expect(createImmutableArraySource([null as never],{keyCache:{}}).prepareKeys(['a'])).rejects.toMatchObject({code:'SOURCE_CONTRACT'});
  });
});

describe('conservative block pruning', () => {
  it('agrees with generic evaluation for mixed values, every predicate and locale semantics', async () => {
    const symbol=Symbol('x');
    const values=[undefined,null,NaN,-0,0,4,Infinity,-Infinity,3n,'z','ä',true,false,new Date(0),new Date(NaN),new Uint8Array([2]),{},symbol];
    const rows=Array.from({length:4099},(_,id)=>({id,nested:{value:values[id%values.length]},text:id%2?'alpha':'beta'}));
    const source=createImmutableArraySource(rows,{keyCache:{blockIndex:true}}),plain=createImmutableArraySource(rows);
    await source.prepareKeys(['nested.value','id','text']);
    const requests:StreamRequest[]=[];
    for(const op of ['eq','neq','gt','gte','lt','lte'] as const)for(const value of [undefined,NaN,-0,3n,'z',new Date(0),symbol])requests.push({filters:[{field:'nested.value',op,value}]});
    requests.push({filters:[{field:'nested.value',op:'in',value:[null,4,new Date(0)]}]},{filters:[{field:'nested.value',op:'in',value:[]}]},{filters:[{field:'nested.value',op:'in',value:42}]},{filters:[{field:'text',op:'contains',value:'ph'}]},{filters:[{field:'text',op:'gte',value:'b'}],semantics:{strings:'locale',locale:'de'}});
    for(const request of requests){request.sorters=[{field:'id',direction:'desc'}];request.offset=3;request.limit=11;expect(await evaluateStream(source,request,{batchSize:127,count:'exact'})).toEqual(await evaluateStream(plain,request,{batchSize:127,count:'exact'}));}
  });
  it('prunes impossible ranges and equality blocks but still validates all input bytes and scan limits', async () => {
    const rows=Array.from({length:5000},(_,id)=>({id,text:'row'+id}));
    const source=createImmutableArraySource(rows,{keyCache:{blockIndex:true}});await source.prepareKeys(['id']);await source.prepare();
    const query={filters:[{field:'id',op:'gte' as const,value:4500}],limit:20};
    const result=await evaluateStream(source,query,{count:'exact'});
    expect(result.summary).toMatchObject({totalMatches:500,scannedRows:5000});expect(result.rows[0].id).toBe(4500);
    expect(source.keyCacheStats!.prunedRows).toBeGreaterThan(0);
    await expect(evaluateStream(source,{filters:[{field:'id',op:'eq',value:-1}],limit:0},{maxScannedRows:500})).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});
    await expect(evaluateStream(source,{filters:[{field:'id',op:'eq',value:-1}],limit:0},{maxRowBytes:1})).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});
    for(const batchSize of [1,1023,4097])expect((await evaluateStream(source,query,{count:'exact',batchSize})).rows).toEqual(result.rows);
  });
  it('never produces a Bloom false negative, including SameValueZero and UTF-16 strings', () => {
    const values=[undefined,null,NaN,-0,0,Infinity,-Infinity,1.25,-9007199254740991,9007199254740991,9n,true,false,'','\ud800','x\0y','😀'];
    const block=new BlockSummary(1024);for(const value of values)block.add(value);
    for(const value of values)expect(block.impossible({field:'x',op:'eq',value},true)).toBe(false);
    expect(scalarHash(-0)).toBe(scalarHash(0));expect(scalarHash(NaN)).toBe(scalarHash(Number('NaN')));
    expect(block.impossible({field:'x',op:'in',value:[],members:[]},true)).toBe(true);
    // Deliberately saturated filters may only lose pruning, never produce results.
    block.bloom.fill(0xffffffff);expect(block.impossible({field:'x',op:'eq',value:'absent'},true)).toBe(false);
    const invalid=new BlockSummary(3);for(const value of [null,undefined,NaN])invalid.add(value);
    expect(invalid.impossible({field:'x',op:'gt',value:0},true)).toBe(true);
    expect(block.impossible({field:'x',op:'lt',value:NaN},true)).toBe(true);
    const objects=new BlockSummary(2);objects.add({});objects.add(new Date(0));
    expect(objects.impossible({field:'x',op:'eq',value:{}},true)).toBe(false);
  });
  it('keeps comparator ties stable when projections contain dates, binary values and opaque objects', async () => {
    const rows=Array.from({length:1500},(_,id)=>({id,a:id%3?new Date(id%7):new Uint8Array([id%5]),b:{}}));
    const source=createImmutableArraySource(rows,{keyCache:{}});await source.prepareKeys(['a','b']);
    const request={sorters:[{field:'a',direction:'desc' as const},{field:'b'}],limit:50};
    expect((await evaluateStream(source,request)).rows).toEqual([...rows].sort(compileQuery(request).compare).slice(0,50));
  });
});

describe('bounded admission histories', () => {
  it('ages TinyLFU and bounds first-touch history without affecting payload identity', () => {
    const frequency=new FrequencyAdmission();
    expect(frequency.record(42)).toBe(1);
    for(let i=0;i<30;i++)frequency.record(42);
    expect(frequency.estimate(42)).toBe(16);
    for(let i=0;i<10000;i++)frequency.record(i+1000);
    expect(frequency.estimate(42)).toBeLessThanOrEqual(16);
    const second=new SecondTouch();expect(second.record(1)).toBe(1);expect(second.record(1)).toBe(2);
    for(let i=2;i<600;i++)second.record(i);
    expect(second.record(1)).toBe(1);
  });
});

describe('timerless runtimes', () => {
  it('builds and shares key columns and prepares accounting without host timers when fairness yields are off', () => {
    // A child process, because removing the host scheduler inside the test runner would stall it.
    const stream = JSON.stringify(new URL('../stream.ts', import.meta.url).href);
    const script = `import assert from 'node:assert/strict';
const { createImmutableArraySource, evaluateStream } = await import(${stream});
delete globalThis.setImmediate; globalThis.setTimeout = undefined; delete globalThis.scheduler;
const rows = Array.from({ length: 40000 }, (_, a) => ({ a: 39999 - a }));
const source = createImmutableArraySource(rows, { keyCache: { maxBytes: 8_000_000 } });
await source.prepare();
const [first, second] = await Promise.all([0, 1].map(() => evaluateStream(source, { sorters: [{ field: 'a' }], limit: 2 }, { yieldEveryBatches: 0 })));
assert.deepEqual(first.rows.map(r => r.a), [0, 1]); assert.deepEqual(second.rows.map(r => r.a), [0, 1]);
await assert.rejects(evaluateStream(source, { sorters: [{ field: 'a' }], limit: 2 }), /yieldEveryBatches to 0/);`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  });
});
