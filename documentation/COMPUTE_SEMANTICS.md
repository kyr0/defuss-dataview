# Compute semantics

VERIFIED: `src/compute/oracle.test.ts` compares every plan kind with an independent reference evaluator (`tests/compute/oracle.ts`) over seeded data, three source kinds and batch sizes 1, 7 and 256. The rules below are what both implement.

## Values and fields

`field(key)` reads an own property; a missing key and an explicit `undefined` both read as `undefined`, and `null` stays `null`. `path()` reads own properties segment by segment and yields `undefined` at the first missing or non-object step. Projection copies these values as they are: a selected nested object is the same object, not a copy, and every selected alias is an own property of the output row even when its value is `undefined`.

Equality and ordering come from the plan's `semantics`, the same `createValueOperations` contract as stream filters and sorters. The default orders by type, then by value: strings by UTF-16 code units, BigInts numerically, Dates by timestamp, binary values by bytes.

## Evaluation order

Per row, a plan evaluates `filters`, then `where`, then the expressions the row's role needs: measures and sort keys for every match (sort keys not at all when `limit` is 0), and the selected outputs only for rows in the returned page. A selected expression that would throw (say, a division by zero) therefore throws only when its row is returned. An expression used several times in one row is evaluated once. `and`, `or` and `coalesce` short-circuit.

## Numbers

`add`, `sub`, `mul` and `div` take finite numbers. A nullish operand gives `null`. Any other operand is an invalid number: under `invalidNumbers: 'error'` it throws a `TypeError`, under `'skip'` it reads as `null`. A non-finite result or a division by zero throws a `RangeError`.

`sum` and `avg` skip nullish operands and apply the invalid-number policy to the rest. `numberMode: 'compensated'` (the default) adds in source order and keeps a Neumaier correction term per sum; `'sequential'` adds plainly in source order. Neither mode merges partial sums, so results are identical for every batch size. `'exact'` returns the sum of all values rounded once to the nearest double, ties to even. Its result does not depend on the order of the rows, the batch size or how the input is split into partials. The sum of only `-0` values is `-0`; any other sum that cancels to zero is `+0`. `avg` divides that sum by the count. An overflowing sum or mean throws a `RangeError`. In `'exact'` mode a running sum that passes `Number.MAX_VALUE` throws too, so whether such an input throws can depend on the order. Without any value, `sum` and `avg` return `null`.

`count()` counts rows; `count(x)` counts rows where `x` is not nullish, including `NaN` and other invalid numbers. Counts fail with a `RangeError` before they could pass `Number.MAX_SAFE_INTEGER`.

`sumBigInt` sums BigInts exactly at any magnitude; a nullish operand is skipped, another type throws under `'error'` and is skipped under `'skip'`.

`floor`, `ceil` and `abs` are `Math.floor`, `Math.ceil` and `Math.abs`. `round` rounds to the nearest integer and takes halves away from zero: 2.5 gives 3, -2.5 gives -3. They apply the invalid-number policy and give `null` for a nullish operand.

## Dates and time zones

`dateTrunc`, `datePart` and `epochMs` read a valid Date or a number of epoch milliseconds within the Date range. Nullish operands and invalid Dates give `null`, as does a truncation whose period starts before the first valid Date. Any other value is invalid: under `invalidNumbers: 'error'` it throws a `TypeError`, under `'skip'` it reads as `null`.

`epochMs` gives the epoch milliseconds of a Date and passes a number through, so dates take arithmetic: `sub(epochMs(end), epochMs(start))` is a duration in milliseconds, and `avg`, `max` or `percentile` over it measure durations. `sub` itself stays numeric and treats a Date as an invalid number, so a forgotten `epochMs` throws under `invalidNumbers: 'error'` and gives `null` under `'skip'`, never `NaN`. A duration is elapsed time, not calendar distance: across a DST change a local day is 23 or 25 hours.

`dateTrunc` and `datePart` work in UTC unless the expression names an IANA time zone, such as `{ timeZone: 'Europe/Berlin' }`; an unknown zone throws a `TypeError` when the plan is prepared. UTC is the default so that one plan gives the same groups in every process; pass the viewer's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) to bucket by local calendar days. A truncated value is the first instant of the period, as Temporal defines it:

- A day, ISO week, month, quarter or year starts at the first instant of its first local day. When a transition skips midnight, that is the transition; when midnight occurs twice, it is the earlier one. Every instant of one local date therefore truncates to the same Date, and grouping by it groups by local date.
- An hour or minute keeps the instant's own UTC offset where the truncated wall time has it. In a repeated hour, the instants of each pass truncate to their own hour.
- `datePart` reads the local wall time: `weekday` is ISO, 1 for Monday to 7 for Sunday, and `quarter` counts from 1.

VERIFIED: `src/compute/dates.test.ts` compares every unit and part with Temporal around every transition from 2010 to 2026 and at random instants from 1900 to 2150, in eight zones: UTC, Europe/Berlin, America/New_York, America/Sao_Paulo (midnight skipped), America/Havana (midnight repeated), Australia/Lord_Howe (a 30-minute shift), Asia/Kathmandu (+05:45) and Pacific/Apia, which skipped 30 December 2011. The comparison runs where the runtime has Temporal (Node.js 26, Bun); fixed cases from the same zones run everywhere.

## Text

`lower`, `upper`, `trim`, `substring`, `concat` and `length` take strings and give `null` for a nullish operand; any other value throws a `TypeError`. `length` also counts the elements of an array. Case mapping is the locale-independent `toLowerCase` and `toUpperCase`. `substring` and `length` count code points, so an emoji counts once and is never split; a lone surrogate counts as one code point. `concat` gives `null` as soon as one operand is nullish.

## Distinct values and percentiles

`countDistinct(x)` and `distinct(x)` skip nullish values and compare the rest as group keys compare: `NaN` equals `NaN`, `+0` equals `-0`, `1`, `1n` and `'1'` differ, Dates compare by timestamp and binary values by bytes (value equality), other objects by identity. `distinct` returns the first occurrence of each value, in first-encounter order, and a private copy of each binary value. Functions and symbols throw a `TypeError`.

`percentile(x, p)` keeps every number of its group and sorts them at the end. With `n` values, the result is at rank `h = (n - 1) * p` from 0, interpolated linearly between the values below and above `h`. This is the default method of R and NumPy, and Excel's `PERCENTILE.INC`. `median` is `percentile(x, 0.5)`, so an even count gives the mean of the two middle values. Nullish operands are skipped and other values follow the invalid-number policy; `-0` counts as `0`. `p` must be a number from 0 to 1 when the plan is prepared.

Both keep their values in working memory, about 8 bytes per number and 48 bytes plus the value per distinct value, so `maxWorkingBytes` bounds them as it bounds groups. Percentiles and medians of one operand and predicate share their values, as do `countDistinct` and `distinct`.

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

A `groupBy` key `each(x)` unwinds arrays: a row joins one group per distinct element of `x`, the first occurrence of each under the same equality, and no group when `x` is an empty array. A value that is no array groups as it is, so a missing array groups as `undefined`. With two `each` keys a row joins every combination of their elements. Every measure counts the row once in each group it joins. `each` must be a whole key: nested in another expression, in `where`, in a measure or in a row plan it throws a `TypeError` when the plan is prepared. An `each` plan never runs as ordered groups.

A group keeps the key values of its first row. Value-mode binary keys are copied, so a group never retains a large buffer that a small view points into. Locale collation does not merge groups: strings group by exact value even when their locale order ties.

Groups appear in first-encounter order unless `orderBy` sorts them; ties in `orderBy` keep first-encounter order.

## Result scope

An aggregate without `groupBy` returns exactly one row, also for empty input, where `count` is 0 and the other measures are `null`. A grouped aggregate over empty input returns no rows.

HAVING filters finished groups with the stream filter vocabulary over output aliases. Then `orderBy` sorts, then `offset` and `limit` page. `totalResultRows` counts groups after HAVING and before paging.

A view's totals cover every row that passed `filters` and `where`, including rows outside the page. Page and totals come from the same snapshot, even when the source is replaced during the scan.

## Partials and merge

`merge()` over partials of disjoint parts of one snapshot, given in source order, returns what `evaluate()` returns over the union of the parts. The parts must cover the scope once each; `merge()` cannot detect overlapping or missing parts. It checks that every partial has the same snapshot revision and the same `signature`, the fingerprint of the plan's descriptor.

- Groups appear in first-encounter order across the parts, and a group keeps the key values of the earliest part that has it.
- Counts and `sumBigInt` add exactly. `min` and `max` keep the first of equal values, from the earliest part. Exact sums add the parts' exact terms, so their result is the single-pass result. Distinct values and percentile values are carried in full, so their results equal the single-pass results.
- HAVING, `orderBy` and paging apply to the merged groups. A group that would fail HAVING within one part can pass after merging.
- Binary `min` and `max` values in a partial are copies of their visible bytes, and every value in a partial that crossed a worker boundary is a structured clone: merged results equal the single-pass values without being the same objects.
- Group keys and distinct values that compare by identity cannot be copied without changing which rows they group: plain objects and arrays, and every object under `equality: 'identity'`. `partial()` rejects them with a `TypeError`.

Given out of source order, the merged rows hold the same groups and the same counts, sums and `sumBigInt` values. Group order without `orderBy`, representative keys and the choice between equal `min`/`max` values then follow the given order.

## Counts and early stops

Plans read the whole input unless the result is already decided. Unsorted rows without `count: 'exact'` stop after the first row past the page; a grouping-only aggregate with a finite `limit`, no measures, no HAVING, no `orderBy` and no exact count stops after `offset + limit + 1` distinct groups. These runs report `totalResultRows: null` and `sourceExhausted: false`. Every other run is exact.
