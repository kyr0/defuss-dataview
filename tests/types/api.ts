import { applyDataview, createDataview, evaluateDataview, updateMeta, updateRows } from 'defuss-dataview';
import type { DataviewResult, DataviewState } from 'defuss-dataview';
const rows: readonly { id: number; name: string }[] = [{ id: 1, name: 'Alice' }];
const view = createDataview({ sorters: [{ field: 'name', dir: 'asc' }], tree: { idField: 'id', parentIdField: 'parentId', expandAll: true, collapsedIds: [1] } });
const result: DataviewResult<{ id: number; name: string }> = evaluateDataview(rows, view);
const name: string = applyDataview(rows, view)[0].row.name;
const extra = updateMeta({ ...view, application: 'keep' }, { selectedRowIds: [1] });
const preserved: string = extra.application;
const state: DataviewState = view;
// @ts-expect-error Filters have a closed operator vocabulary.
createDataview({ filters: [{ field: 'id', op: 'regex', value: 'x' }] });
// @ts-expect-error JSON IDs cannot contain bigint.
createDataview({ meta: { selectedRowIds: [1n] } });
// @ts-expect-error Patch values must match the row type.
updateRows([{ id: 1, name: 'a' }], [1], [{ name: 3 }]);
// @ts-expect-error Row properties retain their original type.
const bad: number = result.entries[0].row.name;
void [name, preserved, state, bad];

import { compileQuery } from 'defuss-dataview/query';
import { createArraySource, createImmutableArraySource, evaluateStream, streamQuery } from 'defuss-dataview/stream';
import type { RecordSource, CancellationSignal } from 'defuss-dataview/stream';
import { createDbsonlSource } from 'defuss-dataview/adapters/dbsonl';
import type { DbsonlDatabase } from 'defuss-dataview/adapters/dbsonl';
interface DocumentRow { id: string; amount: bigint; at: Date }
const source: RecordSource<DocumentRow> = createArraySource<DocumentRow>([{ id: 'a', amount: 10n, at: new Date() }]);
const query = compileQuery({ filters: [{ field: 'at', op: 'eq', value: new Date() }], sorters: [{ field: 'amount' }] });
const signal: CancellationSignal = { aborted: false };
const streamed = evaluateStream(source, { limit: 5 }, { signal });
const typed: Promise<bigint[]> = streamed.then(result => result.rows.map(row => row.amount));
declare const database: DbsonlDatabase<DocumentRow>;
const adapter = createDbsonlSource(database, { gte: 'a', lt: 'z' });
const integration: Promise<string[]> = evaluateStream(adapter).then(result => result.rows.map(row => row.value.id));
void [query, typed, integration, streamQuery];

const immutable = createImmutableArraySource<DocumentRow>([]);
const revision: bigint = immutable.replace([{ id: "b", amount: 1n, at: new Date() }]);
const pinned: RecordSource<DocumentRow> = immutable;
void [revision, pinned];


import { prepareStreamQuery, createIndexedArraySource } from 'defuss-dataview/stream';
import type { IndexCursor, PreparedStreamQuery } from 'defuss-dataview/stream';
const prepared: PreparedStreamQuery<DocumentRow> = prepareStreamQuery<DocumentRow>({ sorters: [{ field: 'amount' }] });
const preparedValues: Promise<bigint[]> = prepared.evaluate(source, { limit: 1 }).then(result => result.rows.map(row => row.amount));
const indexed = createIndexedArraySource<DocumentRow>([], {}, { maxCachedBytes: 1024 });
const pageWithCursor: Promise<IndexCursor | undefined> = indexed.readPage({ limit: 5 }).then(page => page.nextCursor);
const cachedBytes: number = immutable.cachedBytes;
void [preparedValues, pageWithCursor, cachedBytes, indexed.prepare()];

// Build-scoped key projection has an independent cap and observable accounting.
const keyedIndex = createIndexedArraySource([{ id: 1, score: 2 }], { sorters: [{ field: 'score' }] }, { cacheSortKeys: true, maxSortKeyBytes: 1024 });
const projectionBytes: number = keyedIndex.sortKeyBytes;
void projectionBytes;

const cachedSource = createImmutableArraySource([{id:1,score:2}], { keyCache: {maxBytes:4096,policy:'tiny-lfu',blockIndex:true} });
const cacheBytes: Promise<number | undefined> = cachedSource.prepareKeys(['score']).then(stats => stats?.bytes);
cachedSource.clearKeyCache();
void cacheBytes;
