# Compute semantics

VERIFIED: `src/compute/oracle.test.ts` compares every plan kind with an independent reference evaluator (`tests/compute/oracle.ts`) over seeded data, three source kinds and batch sizes 1, 7 and 256. The rules below are what both implement.

## Values and fields

`field(key)` reads an own property; a missing key and an explicit `undefined` both read as `undefined`, and `null` stays `null`. `path()` reads own properties segment by segment and yields `undefined` at the first missing or non-object step. Projection copies these values as they are: a selected nested object is the same object, not a copy, and every selected alias is an own property of the output row even when its value is `undefined`.

Equality and ordering come from the plan's `semantics`, the same `createValueOperations` contract as stream filters and sorters. The default orders by type, then by value: strings by UTF-16 code units, BigInts numerically, Dates by timestamp, binary values by bytes.

## Evaluation order

Per row, a plan evaluates `filters`, then `where`, then the expressions the row's role needs: measures and sort keys for every match (sort keys not at all when `limit` is 0), and the selected outputs only for rows in the returned page. A selected expression that would throw (say, a division by zero) therefore throws only when its row is returned. An expression used several times in one row is evaluated once. `and`, `or` and `coalesce` short-circuit.

## Numbers

`add`, `sub`, `mul` and `div` take finite numbers. A nullish operand gives `null`. Any other operand is an invalid number: under `invalidNumbers: 'error'` it throws a `TypeError`, under `'skip'` it reads as `null`. A non-finite result or a division by zero throws a `RangeError`.

`sum` and `avg` skip nullish operands and apply the invalid-number policy to the rest. They add in source order. `numberMode: 'compensated'` (the default) keeps a Neumaier correction term per sum, `'sequential'` adds plainly. Neither mode merges partial sums, so results are identical for every batch size. An overflowing sum or mean throws a `RangeError`. Without any value, `sum` and `avg` return `null`.

`count()` counts rows; `count(x)` counts rows where `x` is not nullish, including `NaN` and other invalid numbers. Counts fail with a `RangeError` before they could pass `Number.MAX_SAFE_INTEGER`.

`sumBigInt` sums BigInts exactly at any magnitude; a nullish operand is skipped, another type throws under `'error'` and is skipped under `'skip'`.

## Minimum and maximum

`min` and `max` accept Booleans, numbers, BigInts, strings, Dates and binary values, ordered by the plan's semantics. They skip values that range filters also skip (nullish, `NaN`, invalid Dates). Any other object throws a `TypeError`. On ties they keep the first value seen.

## Predicates

`where` and measure `where` must produce Booleans; anything else throws a `TypeError`. Comparisons (`gt` and the rest) are `false` when either side is nullish, `NaN` or an invalid Date, as in range filters. `eq` and `neq` use value equality, so `eq(NaN, NaN)` is `true`.

## Grouping

Two rows share a group when every key component is equal under the plan's equality:

- `NaN` groups with `NaN`, and `+0` with `-0`.
- A missing key groups with `undefined`; `null` is a separate group.
- `1`, `1n`, `'1'` and `true` are four groups.
- With value equality (the default), Dates group by timestamp and binary values by their visible bytes. With `equality: 'identity'`, every object is its own group.
- Functions and symbols throw a `TypeError`.

A group keeps the key values of its first row. Value-mode binary keys are copied, so a group never retains a large buffer that a small view points into. Locale collation does not merge groups: strings group by exact value even when their locale order ties.

Groups appear in first-encounter order unless `orderBy` sorts them; ties in `orderBy` keep first-encounter order.

## Result scope

An aggregate without `groupBy` returns exactly one row, also for empty input, where `count` is 0 and the other measures are `null`. A grouped aggregate over empty input returns no rows.

HAVING filters finished groups with the stream filter vocabulary over output aliases. Then `orderBy` sorts, then `offset` and `limit` page. `totalResultRows` counts groups after HAVING and before paging.

A view's totals cover every row that passed `filters` and `where`, including rows outside the page. Page and totals come from the same snapshot, even when the source is replaced during the scan.

## Counts and early stops

Plans read the whole input unless the result is already decided. Unsorted rows without `count: 'exact'` stop after the first row past the page; a grouping-only aggregate with a finite `limit`, no measures, no HAVING, no `orderBy` and no exact count stops after `offset + limit + 1` distinct groups. These runs report `totalResultRows: null` and `sourceExhausted: false`. Every other run is exact.
