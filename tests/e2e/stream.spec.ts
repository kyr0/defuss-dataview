import { expect, test } from '@playwright/test';

test('built stream/query modules work in a real browser and clean up on break', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createArraySource, evaluateStream, streamQuery } = await import('/dist/browser-stream.mjs');
    const source = createArraySource(Array.from({ length: 1000 }, (_, id) => ({ id, n: BigInt(id % 37) })));
    const page = await evaluateStream(source, { sorters: [{ field: 'n', direction: 'desc' }], offset: 10, limit: 7 }, { batchSize: 13, count: 'exact' });
    const iterator = streamQuery(source, {}, { batchSize: 3 });
    const first = await iterator.next(); await iterator.return(undefined);
    return { ids: page.rows.map((r: { id: number }) => r.id), summary: page.summary, first: first.value.rows.length };
  });
  expect(result.ids).toEqual([406, 443, 480, 517, 554, 591, 628]);
  expect(result.summary).toMatchObject({ totalMatches: 1000, peakBufferedRows: 17, strategy: 'top-k' });
  expect(result.first).toBe(3);
});

test('real worker OPFS keeps snapshot pins and releases them after completion/cancellation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => new Promise(resolve => {
    const worker = new Worker('/artifacts/dbsonl.worker.mjs', { type: 'module' });
    worker.onmessage = e => { resolve(e.data); setTimeout(() => worker.terminate(), 200); };
    worker.onerror = e => { worker.terminate(); resolve({ error: e.message }); };
    worker.postMessage({});
  }));
  expect(result).toMatchObject({ first: 'batch', oldHasThree: true, oldHasFour: true, oldHasNew: false, snapshotRevision: 1, code: 'ABORTED', keys: ['03', '07', '06'], total: 5, scope: 5 });
  expect((result as { pinned: number }).pinned).toBeGreaterThan(0);
  expect((result as { reclaimed: number }).reclaimed).toBeGreaterThan(0);
  expect((result as { cancelled: number }).cancelled).toBeGreaterThan(0);
});

test('stream documentation demo renders the current executor and unknown-count paging', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/docs/stream.html');
  await expect(page.locator('#rows tr')).toHaveCount(10);
  await expect(page.locator('#summary')).toContainText('"strategy": "top-k"');
  await page.selectOption('#ordering', 'scan'); await page.selectOption('#count', 'none'); await page.click('#run');
  await expect(page.locator('#summary')).toContainText('"totalMatches": null');
  await expect(page.locator('#summary')).toContainText('"sourceExhausted": false');
  await expect(page.locator('#status')).toContainText('10 rows');
  expect(errors).toEqual([]);
});

test('versioned immutable browser source pins snapshots and measures each input once', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createImmutableArraySource, evaluateStream, streamQuery } = await import('/dist/browser-stream.mjs');
    const source = createImmutableArraySource([{ n: 1 }, { n: 2 }]);
    const query = streamQuery(source, {}, { batchSize: 1 });
    await query.next(); source.replace([{ n: 3 }]);
    const second = await query.next(), complete = await query.next();
    let calls = 0;
    const latest = await evaluateStream(source, {}, { sizeOf: () => { calls++; return 32; } });
    return { old: second.value.rows[0].n, revision: String(complete.value.summary.revision), latest: latest.rows[0].n, current: String(latest.summary.revision), calls };
  });
  expect(result).toEqual({ old: 2, revision: '0', latest: 3, current: '1', calls: 1 });
});

test('browser host yields admit timer cancellation and reusable indexes page by cursor', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createImmutableArraySource, createIndexedArraySource, evaluateStream, prepareStreamQuery } = await import('/dist/browser-stream.mjs');
    const source = createImmutableArraySource(Array.from({ length: 100000 }, (_, n) => ({ n })));
    const controller = new AbortController(); let code;
    const timer = setTimeout(() => controller.abort(), 0);
    try { await evaluateStream(source, { filters: [{ field: 'n', op: 'gte', value: 0 }], limit: 1 }, { count: 'exact', signal: controller.signal, yieldEveryBatches: 1 }); }
    catch (e) { code = e.code; } finally { clearTimeout(timer); }
    const index = createIndexedArraySource([{ n: 3 }, { n: 1 }, { n: 2 }], { sorters: [{ field: 'n' }] });
    const first = await index.readPage({ limit: 1 });
    const second = await index.readPage({ after: first.nextCursor, limit: 1 });
    const plan = prepareStreamQuery({ filters: [{ field: 'n', op: 'gte', value: 2 }] });
    const prepared = await plan.evaluate(index);
    return { code, first: first.rows[0].n, second: second.rows[0].n, prepared: prepared.rows.map(r => r.n), cache: index.cachedBytes };
  });
  expect(result).toEqual({ code: 'ABORTED', first: 1, second: 2, prepared: [2, 3], cache: 24 });
});

test('optimized flat pages, key projection and warm block scans preserve browser results', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createDataview, evaluateDataview } = await import('/dist/browser.mjs');
    const { createImmutableArraySource, createIndexedArraySource, evaluateStream } = await import('/dist/browser-stream.mjs');
    const rows = Array.from({ length: 5000 }, (_, id) => ({ id, a: { b: { c: (id * 7919) % 1009 } }, group: id % 7 }));
    const descriptor = { filters: [{ field: 'group', op: 'gte', value: 0 }, { field: 'id', op: 'gte', value: 0 }], sorters: [{ field: 'a.b.c', direction: 'desc' }, { field: 'group', direction: 'asc' }] };
    const reference = [...rows].sort((a,b)=>b.a.b.c-a.a.b.c || a.group-b.group).slice(40,60).map(r=>r.id);
    const flat = evaluateDataview(rows,createDataview({...descriptor,page:2,pageSize:20}));
    const index=createIndexedArraySource(rows,descriptor,{cacheSortKeys:true});
    const indexed=await evaluateStream(index,{offset:40,limit:20});
    const source=createImmutableArraySource(rows);await source.prepare();
    const warm=await evaluateStream(source,{...descriptor,offset:40,limit:20},{count:'exact',batchSize:127});
    let budgetCode;
    try{await evaluateStream(source,{limit:1},{maxRowBytes:1});}catch(e){budgetCode=e.code;}
    return { reference,flat:flat.entries.map(e=>e.row.id),indexed:indexed.rows.map(r=>r.id),warm:warm.rows.map(r=>r.id),total:warm.summary.totalMatches,keyBytes:index.sortKeyBytes,budgetCode };
  });
  expect(result.flat).toEqual(result.reference); expect(result.indexed).toEqual(result.reference); expect(result.warm).toEqual(result.reference);
  expect(result).toMatchObject({total:5000,keyBytes:140128,budgetCode:'LIMIT_EXCEEDED'});
});

test('revision key caches and block summaries keep exact browser results and byte limits', async ({ page }) => {
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createImmutableArraySource,evaluateStream}=await import('/dist/browser-stream.mjs');
    const rows=Array.from({length:5000},(_,id)=>({id,a:{b:id}}));
    const source=createImmutableArraySource(rows,{keyCache:{policy:'tiny-lfu',blockIndex:true,maxBytes:100000}});
    await source.prepare();await source.prepareKeys(['a.b']);
    const query={filters:[{field:'a.b',op:'gte',value:4500}],sorters:[{field:'a.b',direction:'desc'}],limit:10};
    const first=await evaluateStream(source,query,{count:'exact'}),second=await evaluateStream(source,query,{count:'exact'});
    let code;try{await evaluateStream(source,{filters:[{field:'a.b',op:'eq',value:-1}],limit:0},{maxRowBytes:1});}catch(e){code=e.code;}
    const stats=source.keyCacheStats;source.clearKeyCache();
    return {ids:first.rows.map(r=>r.id),same:JSON.stringify(first.rows)===JSON.stringify(second.rows),total:first.summary.totalMatches,scanned:first.summary.scannedRows,stats,cleared:source.keyCacheStats.bytes,code};
  });
  expect(result.ids).toEqual([4999,4998,4997,4996,4995,4994,4993,4992,4991,4990]);
  expect(result).toMatchObject({same:true,total:500,scanned:5000,cleared:0,code:'LIMIT_EXCEEDED'});
  expect(result.stats.prunedRows).toBeGreaterThan(0);expect(result.stats.pinnedEntries).toBe(0);expect(result.stats.peakBytes).toBeLessThanOrEqual(100000);
});

test('shared browser key builds survive one cancelled waiter and release pins', async ({ page }) => {
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createImmutableArraySource}=await import('/dist/browser-stream.mjs');
    const source=createImmutableArraySource(Array.from({length:50000},(_,a)=>({a})),{keyCache:{}});
    const controller=new AbortController();
    const first=source.prepareKeys(['a'],{signal:controller.signal}).then(()=>undefined,e=>e.code);
    const second=source.prepareKeys(['a']);controller.abort();
    const code=await first;await second;const before=source.keyCacheStats;
    source.replace([{a:99}]);return {code,before,after:source.keyCacheStats};
  });
  expect(result.code).toBe('ABORTED');expect(result.before).toMatchObject({builds:1,pinnedEntries:0,buildingEntries:0});expect(result.after.bytes).toBe(0);
});
