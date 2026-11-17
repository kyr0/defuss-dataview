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
| `count(expr?, { where })` | Rows, or rows whose operand is not nullish |
| `sum`, `avg` | Finite number sum and mean, `null` without values |
| `min`, `max` | Smallest or largest value in the typed order, `null` without values |
| `sumBigInt` | Exact BigInt sum, `null` without values |

Every measure takes an optional `{ where }` predicate. Field keys and path segments may not be `__proto__`, `prototype` or `constructor`; field keys may not contain dots.

## Plans

| Factory | Descriptor | Output |
| --- | --- | --- |
| `q.rows(d)` | `select`, `orderBy: [{ expr, direction }]` | One row per match with the selected aliases |
| `q.aggregate(d)` | `groupBy`, `measures`, `having`, `orderBy: [{ field, direction }]` | One row per group, or one global row without `groupBy` |
| `q.view(d)` | `select`, `totals`, `orderBy: [{ expr, direction }]` | A page of rows plus totals over every match |

Every descriptor also accepts `filters` (the stream filter vocabulary), `where` (a Boolean expression), `semantics`, `numberMode` (`'compensated'` default, or `'sequential'`) and `invalidNumbers` (`'error'` default, or `'skip'`). Aliases are own string keys of a plain object, nonempty and without dots. Group and measure aliases must differ, and `having` and aggregate `orderBy` name output aliases. An unknown descriptor property throws a `TypeError`.

Preparing a plan validates the whole descriptor and freezes it. A prepared plan holds no source, snapshot or result state, so one plan can run on several sources at once.

| Method | Result |
| --- | --- |
| `plan.evaluate(source, page?, options?)` | `Promise<{ rows, summary }>`; views also return `totals` |
| `plan.stream(source, page?, options?)` | `AsyncGenerator` of `{ type: 'batch', rows }` events and one final `{ type: 'complete', summary }` (views add `totals`) |
| `plan.explain()` | Frozen description: kind, required fields, operators, measures, state count, candidate strategies, notes |

`page` is `{ offset?, limit? }`; both are safe nonnegative integers. `stream()` validates `page` and `options` synchronously and opens the source on the first pull.

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
| `strategy` | `scan`, `ordered`, `top-k`, `sort`, `scalar`, `hash`, `ordered-groups` or `first-seen` |
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
| `TypeError` at preparation | Malformed, cyclic, too deep or too large expressions; unsafe keys or aliases; unknown operators or descriptor properties |
| `TypeError` at execution | A non-Boolean predicate, an invalid number under `'error'`, a non-BigInt for `sumBigInt`, an opaque object for `min`/`max`, a function or symbol group key |
| `RangeError` | Arithmetic or accumulator overflow, division by zero, a count beyond `Number.MAX_SAFE_INTEGER` |
| `DataviewError` `LIMIT_EXCEEDED` | A row, batch, scan, group, working-memory or output cap |
| `DataviewError` `SOURCE_CONTRACT` | Malformed batches, or a source that disagrees with its exact count |
| `DataviewError` `ABORTED` | The signal aborted |

When cleanup also fails, the plan throws an `AggregateError` with the original error first, then the iterator-return and session-close errors.
