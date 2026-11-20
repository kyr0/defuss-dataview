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

import { forRows } from 'defuss-dataview/compute';
import type { Expr } from 'defuss-dataview/compute';
type IsAny<T> = 0 extends 1 & T ? true : false;
type Order = { id: number; country: string; quantity: number; unitPrice: number | null; meta?: unknown };
const cq = forRows<Order>();
const revenue = cq.mul(cq.field('quantity'), cq.field('unitPrice'));
const grouped = cq.aggregate({ groupBy: { country: cq.field('country') }, measures: { orders: cq.count(), revenue: cq.sum(revenue), top: cq.max(cq.field('unitPrice')), big: cq.sumBigInt(cq.literal(1n)) } });
type Grouped = Awaited<ReturnType<typeof grouped.evaluate>>['rows'][number];
const exactGroup: Grouped = { country: 'x', orders: 1, revenue: null, top: null, big: null };
const exactBack: { country: string; orders: number; revenue: number | null; top: number | null; big: bigint | null } = exactGroup;
const noAnyGroup: IsAny<Grouped['orders']> = false;
// @ts-expect-error Aliases are exact: an undeclared output property does not exist.
void exactGroup.missing;
// @ts-expect-error Arithmetic takes numeric operands only.
cq.mul(cq.field('country'), cq.field('quantity'));
// @ts-expect-error field() names an existing top-level key.
cq.field('nope');
// @ts-expect-error A path is unknown until narrowed with number().
cq.add(cq.path('meta.x'), cq.literal(1));
const narrowed: Expr<number | null> = cq.add(cq.number(cq.path('meta.x')), cq.literal(1));
const shown = cq.view({ select: { id: cq.field('id'), price: cq.field('unitPrice') }, totals: { n: cq.count(), mean: cq.avg(cq.field('unitPrice')) } });
type Shown = Awaited<ReturnType<typeof shown.evaluate>>;
const shownRow: { id: number; price: number | null } = {} as Shown['rows'][number];
const shownTotals: { n: number; mean: number | null } = {} as Shown['totals'];
const dynamic: Record<string, Expr<unknown>> = { id: cq.field('id') };
const honest = cq.rows({ select: dynamic });
const honestRow: Record<string, unknown> = {} as Awaited<ReturnType<typeof honest.evaluate>>['rows'][number];
const noAnyHonest: IsAny<Awaited<ReturnType<typeof honest.evaluate>>['rows'][number][string]> = false;
void [exactBack, noAnyGroup, narrowed, shownRow, shownTotals, honestRow, noAnyHonest];
import type { PartialAggregate } from 'defuss-dataview/compute';
const exactPlan = cq.aggregate({ groupBy: { country: cq.field('country') }, measures: { revenue: cq.sum(revenue) }, numberMode: 'exact' });
const orderSource = createImmutableArraySource<Order>([]);
const part: Promise<PartialAggregate> = exactPlan.partial(orderSource, { batchSize: 64, maxWorkingBytes: 1 << 20 });
const mergedRow: Promise<{ country: string; revenue: number | null } | undefined> = part.then(p => exactPlan.merge([p], { limit: 10 }, { maxGroups: 10 })).then(r => r.rows[0]);
// @ts-expect-error A partial scan has no output page.
exactPlan.partial(orderSource, { maxOutputRows: 1 });
// @ts-expect-error Only aggregate plans run as partials.
void shown.partial;
void mergedRow;
