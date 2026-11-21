# Compute API

`defuss-dataview/compute` adds projection, scalar and grouped aggregation, and a page plus totals over the same snapshot sources as `defuss-dataview/stream`. It is a separate entry point, so table, tree and stream consumers never load it. COMPUTE_SEMANTICS.md defines every result; COMPUTE_ARCHITECTURE.md explains how plans run.

```js
import { forRows } from 'defuss-dataview/compute';
import { createImmutableArraySource } from 'defuss-dataview/stream';

const q = forRows();
const revenue = q.mul(q.field('quantity'), q.field('unitPrice'));
const byCountry = q.aggregate({
  where: q.not(q.field('refunded')),
  groupBy: { country: q.field('country') },
  measures: { orders: q.count(), revenue: q.sum(revenue) },
  having: [{ field: 'orders', op: 'gte', value: 10 }],
  orderBy: [{ field: 'revenue', direction: 'desc' }],
});
const { rows, summary } = await byCountry.evaluate(createImmutableArraySource(orders), { limit: 20 }, { count: 'exact' });
```

## Entry

| Export | Result |
| --- | --- |
| `forRows<T>()` | Frozen builders plus `rows`, `aggregate` and `view`, typed for rows `T` |
| `MAX_EXPRESSION_DEPTH` | 64: deepest accepted expression tree |
| `MAX_PLAN_NODES` | 10,000: most distinct expression nodes in one plan |

`T` only drives inference; at runtime `forRows()` takes no argument and holds no state.

## Expression builders

Builders return frozen plain nodes (`{ v: 1, op, ... }`). Plans also accept the same nodes built by hand or parsed from JSON, and validate them when the plan is prepared.

| Builder | Value |
| --- | --- |
| `field(key)` | Own top-level property `key`, or `undefined` when missing |
| `path('a.b.c')` | Own-property path; `unknown` until narrowed |
| `literal(value)` | A constant |
| `number(expr)` | Narrows to `number \| null` under the plan's invalid-number policy |
| `add`, `sub`, `mul`, `div` | Finite arithmetic on numbers; nullish operands give `null` |
| `coalesce(...exprs)` | First non-nullish operand, else the last operand's value |
| `eq`, `neq` | Value equality of the plan's semantics |
| `gt`, `gte`, `lt`, `lte` | Ordering comparisons with filter range semantics |
| `isNullish(expr)` | `true` for `null` and `undefined` |
| `and`, `or`, `not` | Short-circuit Boolean logic; operands must be Booleans |
| `cond(test, then, otherwise)` | `then` when `test` is `true`, else `otherwise`; only the chosen branch is evaluated |
| `floor`, `ceil`, `round`, `abs` | Integer rounding and absolute value; `round` takes halves away from zero |
| `dateTrunc(expr, unit, { timeZone }?)` | The first instant of the `year`, `quarter`, `month`, ISO `week` (from Monday), `day`, `hour` or `minute`, as a Date |
| `datePart(expr, part, { timeZone }?)` | `year`, `quarter` (1 to 4), `month` (1 to 12), `day`, `weekday` (1 = Monday to 7), `hour` or `minute` |
| `lower`, `upper`, `trim` | The string in lower or upper case, or without surrounding whitespace |
| `substring(expr, start, length?)` | `length` code points from `start`, or the rest of the string |
| `concat(...exprs)` | The joined strings; `null` when any operand is nullish |
| `length(expr)` | Code points of a string, or elements of an array |
| `each(expr)` | A whole `groupBy` key: one group per distinct array element, as MongoDB's `$unwind` |
| `count(expr?, { where })` | Rows, or rows whose operand is not nullish |
| `sum`, `avg` | Finite number sum and mean, `null` without values |
| `min`, `max` | Smallest or largest value in the typed order, `null` without values |
| `sumBigInt` | Exact BigInt sum, `null` without values |
| `countDistinct`, `distinct` | Number of distinct non-nullish values, or the values in first-encounter order (`[]` without values) |
| `percentile(expr, p)`, `median` | Exact percentile for `p` from 0 to 1, interpolated between the closest ranks; `median` is `p` 0.5; `null` without values |

Every measure takes an optional `{ where }` predicate. Field keys and path segments may not be `__proto__`, `prototype` or `constructor`; field keys may not contain dots.

## Plans

| Factory | Descriptor | Output |
| --- | --- | --- |
| `q.rows(d)` | `select`, `orderBy: [{ expr, direction }]` | One row per match with the selected aliases |
| `q.aggregate(d)` | `groupBy`, `measures`, `having`, `orderBy: [{ field, direction }]` | One row per group, or one global row without `groupBy` |
| `q.view(d)` | `select`, `totals`, `orderBy: [{ expr, direction }]` | A page of rows plus totals over every match |

Every descriptor also accepts `filters` (the stream filter vocabulary), `where` (a Boolean expression), `semantics`, `numberMode` (`'compensated'` default, `'sequential'` or `'exact'`) and `invalidNumbers` (`'error'` default, or `'skip'`). Aliases are own string keys of a plain object, nonempty and without dots. Group and measure aliases must differ, and `having` and aggregate `orderBy` name output aliases. An unknown descriptor property throws a `TypeError`.

Preparing a plan validates the whole descriptor and freezes it. A prepared plan holds no source, snapshot or result state, so one plan can run on several sources at once.

| Method | Result |
| --- | --- |
| `plan.evaluate(source, page?, options?)` | `Promise<{ rows, summary }>`; views also return `totals` |
| `plan.stream(source, page?, options?)` | `AsyncGenerator` of `{ type: 'batch', rows }` events and one final `{ type: 'complete', summary }` (views add `totals`) |
| `plan.explain()` | Frozen description: kind, required fields, operators, measures, state count, candidate strategies, notes |
| `plan.partial(source, options?)` | Aggregate plans: `Promise<PartialAggregate>`, the mergeable state of one part of a snapshot |
| `plan.merge(partials, page?, options?)` | Aggregate plans: `Promise<{ rows, summary }>` over the union of the parts |

`page` is `{ offset?, limit? }`; both are safe nonnegative integers. `stream()` validates `page` and `options` synchronously and opens the source on the first pull.

## Partial aggregation

An aggregate plan can run as several partial scans plus one merge, for example one worker per key range. Each partial applies `filters`, `where` and the measures to its part; `having`, `orderBy` and the page apply once, in `merge()`.

```js
const plan = q.aggregate({
  groupBy: { country: q.path('value.country') },
  measures: { orders: q.count(), revenue: q.sum(q.number(q.path('value.amount'))) },
  orderBy: [{ field: 'revenue', direction: 'desc' }],
  numberMode: 'exact',
});
const session = await db.beginRead(); // one defuss-dbsonl snapshot for every part
const ranges = await session.split(4); // key ranges in key order, with exact row counts
const partials = await Promise.all(ranges.map(({ gte, lt }) => plan.partial(createDbsonlSource(db, { gte, lt, at: session.head }))));
const { rows, summary } = await plan.merge(partials, { limit: 20 }); // summary.strategy === 'merge'
await session.close();
```

In a worker, each part opens its own database handle and passes `session.head` as `at` (SOURCES.md); `examples/compute-partials.mjs` runs four worker threads this way.

`explain().strategies` contains `'merge'` when the plan accepts both methods. That holds for every aggregate plan without `sum` or `avg`, and for every aggregate plan under `numberMode: 'exact'`. Distinct values and percentiles merge in every mode, since their partials carry the values themselves. Compensated and sequential sums depend on the order of the additions, so `partial()` and `merge()` reject them with a `TypeError`.

A `PartialAggregate` is plain data that survives `structuredClone()` and `postMessage()`; it is not JSON, since it holds BigInts, Dates, typed arrays and `undefined`. A worker can transfer the buffers of its typed arrays (`partial.states`). `merge()` validates every partial as untrusted input.

| Field | Meaning |
| --- | --- |
| `format` | Partial format version, `1` |
| `signature` | Fingerprint of the plan's descriptor |
| `revision` | Snapshot revision of the part's source |
| `scannedRows`, `matchedRows` | Rows read and rows that passed `filters` and `where` |
| `groups` | Groups in the part, in first-encounter order; 1 without `groupBy` |
| `keys` | One array of representative key values per `groupBy` alias |
| `states` | Measure states by group; their layout belongs to the format version |
| `peakWorkingBytes` | Largest reserved working memory of the partial scan |

`partial()` takes the input options of `evaluate()` (`batchSize`, `maxBatchBytes`, `maxRowBytes`, `maxScannedRows`, `yieldEveryBatches`, `sizeOf`, `maxWorkingBytes`, `maxGroups`, `profile`, `signal`). `merge()` takes the output side: `batchSize`, `maxBatchBytes`, `sizeOfOutput`, `maxWorkingBytes`, `maxGroups`, `maxOutputRows`, `maxOutputBytes` and `signal`. A merge's `totalResultRows` is always exact.

To build the same plan in a worker, send the descriptor itself with `postMessage`. Its clone keeps the property order, so the worker's plan has the same signature. A descriptor with its aliases in another order is another plan, because aliases fix the order of outputs and states.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `count` | `'none'` | `'exact'` makes `totalResultRows` exact; it never changes measure precision |
| `batchSize`, `maxBatchBytes`, `maxRowBytes`, `maxScannedRows`, `yieldEveryBatches`, `sizeOf`, `signal` | as for stream queries | Input batching, validation, scan budget, host fairness and cancellation |
| `sizeOfOutput` | structural estimator | Accounted bytes of each produced row |
| `maxWorkingBytes` | 64 MiB | Group tables, measure state, retained keys and sort candidates |
| `maxGroups` | 100,000 | Groups before failure; at most 2³² − 2 |
| `maxOutputRows`, `maxOutputBytes` | 100,000, 64 MiB | What `evaluate()` collects; `stream()` leaves output bounding to the consumer |
| `profile` | `false` | Count field reads into `summary.fieldReads` |

Exceeding a cap throws `DataviewError` with code `LIMIT_EXCEEDED`. Compute never drops a group or truncates a result to stay under a cap.

## Summary

| Field | Meaning |
| --- | --- |
| `revision` | Snapshot revision of the source |
| `sourceRows` | Exact rows in the source scope, or `null` |
| `scannedRows` | Rows examined |
| `observedInputMatches` | Rows that passed `filters` and `where` |
| `totalInputMatches` | Exact matching rows once the source was exhausted, else `null` |
| `totalResultRows` | Rows or groups after HAVING and before paging; `null` when the plan stopped early |
| `returnedRows` | Output rows produced |
| `hasMore` | At least one result row lies after the page |
| `sourceExhausted` | The scan reached the end of the source |
| `strategy` | `scan`, `ordered`, `top-k`, `sort`, `scalar`, `hash`, `ordered-groups`, `first-seen`, or `merge` for `merge()` |
| `executionComplete` | Always `true`; failed executions throw instead |
| `peakWorkingBytes` | Largest reserved working memory |
| `peakOutputBytes` | `stream()`: the largest output batch; `evaluate()`: all collected output |
| `peakGroups` | Groups held at once (1 for ordered groups) |
| `cacheBytesPinned` | Bytes of prepared source columns this run read; 0 without them |
| `cacheBuilds`, `prunedRows` | Always 0: compute neither builds columns nor skips batches |
| `fieldReads` | With `profile`, field reads from rows and columns; else `null` |

## Errors

| Error | Cause |
| --- | --- |
| `TypeError` at preparation | Malformed, cyclic, too deep or too large expressions; unsafe keys or aliases; unknown operators, units, parts, time zones or descriptor properties; a percentile `p` outside 0 to 1 |
| `TypeError` at execution | A non-Boolean predicate or `cond` test, an invalid number or date under `'error'`, a non-string for a text operator, a non-BigInt for `sumBigInt`, an opaque object for `min`/`max`, a function or symbol group key or distinct value |
| `TypeError` in `partial()` or `merge()` | A `sum` or `avg` outside `numberMode: 'exact'`; a group key or distinct value that compares by identity; an empty list; a partial of another format version or plan, or with malformed fields |
| `RangeError` | Arithmetic or accumulator overflow, division by zero, a count beyond `Number.MAX_SAFE_INTEGER`, also when merging |
| `DataviewError` `LIMIT_EXCEEDED` | A row, batch, scan, group, working-memory or output cap |
| `DataviewError` `SOURCE_CONTRACT` | Malformed batches, a source that disagrees with its exact count, or partials of different snapshot revisions |
| `DataviewError` `ABORTED` | The signal aborted |

When cleanup also fails, the plan throws an `AggregateError` with the original error first, then the iterator-return and session-close errors.
