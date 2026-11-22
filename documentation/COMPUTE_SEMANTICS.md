# Compute semantics

VERIFIED: `src/compute/oracle.test.ts` compares every plan kind with an independent reference evaluator (`tests/compute/oracle.ts`) over seeded data, three source kinds and batch sizes 1, 7 and 256. The rules below are what both implement.

## Values and fields

`field(key)` reads an own property; a missing key and an explicit `undefined` both read as `undefined`, and `null` stays `null`. `path()` reads own properties segment by segment and yields `undefined` at the first missing or non-object step. Projection copies these values as they are: a selected nested object is the same object, not a copy, and every selected alias is an own property of the output row even when its value is `undefined`.

`get(expr, 'a.b')` reads the same own-property path from any value, such as an object element of `some()`. Array indexes are path segments: `path('tags.0')` and `get(list, '0')` read a first element.

Equality and ordering come from the plan's `semantics`, the same `createValueOperations` contract as stream filters and sorters. The default orders by type, then by value: Booleans, numbers, BigInts, strings, Dates, binary values, arrays, other objects, invalid values, nullish values. Strings compare by UTF-16 code units, BigInts numerically, Dates by timestamp, binary values by bytes. Arrays compare element by element, and a proper prefix sorts first, so `[]` < `[1]` < `[1, 0]` < `[2]`. Other objects tie.

Lists are values: under the default `equality: 'value'`, two arrays are equal when they have the same length and pairwise equal elements, so equal arrays match `eq` and `in`, group together and count as one distinct value. Nested arrays, Dates and binary values inside them compare by value too; plain objects inside them keep identity. An array that contains itself throws a `TypeError` when it meets another array in a comparison or a key. `equality: 'identity'` keeps every array apart from every other. This matters most for data from document stores, where an array field holds a value, not a reference: comparing it by identity would never match a stored array.

## Evaluation order

Per row, a plan evaluates `filters`, then `where`, then the expressions the row's role needs: measures and sort keys for every match (sort keys not at all when `limit` is 0), and the selected outputs only for rows in the returned page. A selected expression that would throw (say, a division by zero) therefore throws only when its row is returned. An expression used several times in one row is evaluated once, except where it reads an element of `some()` or `every()`: that expression is evaluated once per element. `and`, `or`, `coalesce`, `some` and `every` short-circuit.

## Numbers

`add`, `sub`, `mul` and `div` take finite numbers. A nullish operand gives `null`. Any other operand is an invalid number: under `invalidNumbers: 'error'` it throws a `TypeError`, under `'skip'` it reads as `null`. A non-finite result or a division by zero throws a `RangeError`.

`sum` and `avg` skip nullish operands and apply the invalid-number policy to the rest. `numberMode: 'compensated'` (the default) adds in source order and keeps a Neumaier correction term per sum; `'sequential'` adds plainly in source order. Neither mode merges partial sums, so results are identical for every batch size. `'exact'` returns the sum of all values rounded once to the nearest double, ties to even. Its result does not depend on the order of the rows, the batch size or how the input is split into partials. The sum of only `-0` values is `-0`; any other sum that cancels to zero is `+0`. `avg` divides that sum by the count. An overflowing sum or mean throws a `RangeError`. In `'exact'` mode a running sum that passes `Number.MAX_VALUE` throws too, so whether such an input throws can depend on the order. Without any value, `sum` and `avg` return `null`.

`count()` counts rows; `count(x)` counts rows where `x` is not nullish, including `NaN` and other invalid numbers. Counts fail with a `RangeError` before they could pass `Number.MAX_SAFE_INTEGER`.

`sumBigInt` sums BigInts exactly at any magnitude; a nullish operand is skipped, another type throws under `'error'` and is skipped under `'skip'`.

`floor`, `ceil` and `abs` are `Math.floor`, `Math.ceil` and `Math.abs`. `round` rounds to the nearest integer and takes halves away from zero: 2.5 gives 3, -2.5 gives -3. They apply the invalid-number policy and give `null` for a nullish operand.

`mod(a, b)` is JavaScript's remainder of two numbers or of two BigInts: its sign is the dividend's, so `mod(-7, 3)` is -1, and a zero divisor throws a `RangeError`. `pow`, `sqrt`, `ln` and `exp` throw a `RangeError` for a result that is not a finite real number: `sqrt` of a negative number, `ln` of zero, `pow(-8, 1/3)`, an overflow. All of them follow the invalid-number policy for their operands.

`bitAnd`, `bitOr` and `bitXor` take one or more operands, `bitNot` one. Numbers must be safe integers and compute as 64-bit two's complement, as MongoDB computes longs; their results are exact, because AND, OR, XOR and NOT keep the copies of the sign bit above bit 53 that every safe integer has. BigInts compute at their full width. A nullish operand gives `null`. Fractions, unsafe integers, other values and a mix of numbers and BigInts follow the invalid-number policy.

`least` and `greatest` return the smallest or largest operand in the typed order and skip nullish and invalid values, as `min` and `max` do; without any other value they give `null`, and on ties they keep the first operand.

`varPop`, `varSamp`, `stdDevPop` and `stdDevSamp` keep the exact sum of the values and the exact sum of their squares, each square split into two doubles without rounding (Dekker's TwoProduct). At the end they round `n * sum(x^2) - sum(x)^2` once, then divide by `n * n` (population) or `n * (n - 1)` (sample), and the standard deviations take the square root. A large mean therefore costs no precision, as it does in the one-pass textbook formula, and the result does not depend on order, batch size or partitioning, in every `numberMode`. Without values they give `null`, and the sample measures also give `null` for one value. A square beyond the double range throws a `RangeError`; squares below about 1e-300 lose their low bits. VERIFIED: `tests/compute/oracle.ts` computes them from exact BigInt sums, and the oracle tests compare them over seeded data and merged partials.

## Dates and time zones

`dateTrunc`, `datePart`, `dateAdd`, `dateDiff`, `toDate` and `epochMs` read a valid Date or a number of epoch milliseconds within the Date range. Nullish operands and invalid Dates give `null`, as does a truncation whose period starts before the first valid Date. Any other value is invalid: under `invalidNumbers: 'error'` it throws a `TypeError`, under `'skip'` it reads as `null`.

`epochMs` gives the epoch milliseconds of a Date and passes a number through, so dates take arithmetic: `sub(epochMs(end), epochMs(start))` is a duration in milliseconds, and `avg`, `max` or `percentile` over it measure durations. `sub` itself stays numeric and treats a Date as an invalid number, so a forgotten `epochMs` throws under `invalidNumbers: 'error'` and gives `null` under `'skip'`, never `NaN`. A duration is elapsed time, not calendar distance: across a DST change a local day is 23 or 25 hours.

`dateTrunc` and `datePart` work in UTC unless the expression names an IANA time zone, such as `{ timeZone: 'Europe/Berlin' }`; an unknown zone throws a `TypeError` when the plan is prepared. UTC is the default so that one plan gives the same groups in every process; pass the viewer's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) to bucket by local calendar days. A truncated value is the first instant of the period, as Temporal defines it:

- A day, ISO week, month, quarter or year starts at the first instant of its first local day. When a transition skips midnight, that is the transition; when midnight occurs twice, it is the earlier one. Every instant of one local date therefore truncates to the same Date, and grouping by it groups by local date.
- An hour or minute keeps the instant's own UTC offset where the truncated wall time has it. In a repeated hour, the instants of each pass truncate to their own hour.
- A second or millisecond is the instant's own: UTC offsets are whole seconds.
- `datePart` reads the local wall time: `weekday` is ISO, 1 for Monday to 7 for Sunday, and `quarter` counts from 1. `isoWeek` is the ISO week number (1 to 53) and `isoWeekYear` the year it belongs to, the year of its Thursday; `dayOfYear` counts from 1.

`startOfWeek` (`'monday'` to `'sunday'`, default `'monday'`) moves where `dateTrunc` and `dateDiff` start a week. `binSize` groups several units into one bin, counted from 2000-01-01 as MongoDB's `$dateTrunc` counts them: units below a day in elapsed time from that day's local midnight, days and weeks in local days (weeks from the first `startOfWeek` day on or after 2000-01-01), months, quarters and years in local months from January 2000. Bins below a day therefore keep their elapsed length across a DST change: in Europe/Berlin two-hour bins start at even hours in winter and at odd hours in summer.

`dateAdd(date, unit, amount)` adds an integer number of units, as MongoDB's `$dateAdd`. Hours and smaller units add elapsed time. Days and weeks keep the local wall clock; months, quarters and years keep it too and clamp the day to the end of a shorter month, so 31 January plus one month is 28 or 29 February. A wall time that a transition repeats keeps the UTC offset the start had; one that a transition skips moves past the gap. An amount that is no integer follows the invalid-number policy, and a result outside the Date range throws a `RangeError`.

`dateDiff(start, end, unit)` counts unit boundaries crossed, not whole units elapsed, as MongoDB's `$dateDiff` and SQL's `DATEDIFF` do: from 31 January 23:00 to 1 February 00:00 is one month and one day. Days and longer compare local calendar dates, weeks from `startOfWeek`. Smaller units compare local wall times less the whole units of an offset change, so the repeated hour of a DST change still counts as an hour. The result is negative when `end` is earlier.

VERIFIED: `src/compute/calendar.test.ts` replays MongoDB 9.0.8's answers to 3,600 cases of `$dateTrunc` with `binSize` and `startOfWeek`, the date parts, `$dateAdd` and `$dateDiff` in 11 zones, half of them within a day of a transition (`tests/compute/mongodb-calendar.json`, written by `scripts/mongodb-calendar-fixture.mjs` on 2026-11-22). Two cases of `dateTrunc` with a bin of one unit differ by design, where dataview keeps the Temporal rule of 0.8.0: MongoDB counts single hours and minutes in elapsed time from 2000-01-01 too, so in Australia/Lord_Howe in winter, whose offset then differs by half an hour, its hours start at half past; and when a transition repeats midnight, MongoDB starts the day at the second midnight, after the instant it truncates.

VERIFIED: `src/compute/dates.test.ts` compares every unit and part, Sunday weeks, and `dateAdd` and `dateDiff` in days and longer units (with Temporal's `offset: 'prefer'`), with Temporal around every transition from 2010 to 2026 and at random instants from 1900 to 2150, in eight zones: UTC, Europe/Berlin, America/New_York, America/Sao_Paulo (midnight skipped), America/Havana (midnight repeated), Australia/Lord_Howe (a 30-minute shift), Asia/Kathmandu (+05:45) and Pacific/Apia, which skipped 30 December 2011. The comparison runs where the runtime has Temporal (Node.js 26, Bun); fixed cases from the same zones run everywhere.

## Text

`lower`, `upper`, `trim`, `substring`, `concat`, `length`, `split`, `replaceAll` and `indexOf` take strings and give `null` for a nullish operand; any other value throws a `TypeError`. `length` also counts the elements of an array. Case mapping is the locale-independent `toLowerCase` and `toUpperCase`. `substring` and `length` count code points, so an emoji counts once and is never split; a lone surrogate counts as one code point. `concat` gives `null` as soon as one operand is nullish. `split` needs a nonempty separator and `replaceAll` a nonempty search string; `replaceAll` inserts the replacement as it is, without `$&` or `$1` patterns. `indexOf` gives the code-point index of the first occurrence, or -1.

`toText` turns a string, number, BigInt or Boolean into its JavaScript text and a Date into its ISO string; an invalid Date gives `null` and other values throw a `TypeError`. `parseNumber` reads a trimmed decimal string, with an optional sign, fraction and exponent, and passes a finite number through. Anything else follows the invalid-number policy, including hexadecimal, `Infinity`, an empty string and a value beyond the double range.

## Distinct values and percentiles

`countDistinct(x)` and `distinct(x)` skip nullish values and compare the rest as group keys compare: `NaN` equals `NaN`, `+0` equals `-0`, `1`, `1n` and `'1'` differ, Dates compare by timestamp, binary values by bytes and arrays element by element (value equality), other objects by identity. `distinct` returns the first occurrence of each value, in first-encounter order, and a private copy of each binary value. Functions and symbols throw a `TypeError`.

`percentile(x, p)` keeps every number of its group and sorts them at the end. With `n` values, the result is at rank `h = (n - 1) * p` from 0, interpolated linearly between the values below and above `h`. This is the default method of R and NumPy, and Excel's `PERCENTILE.INC`. `median` is `percentile(x, 0.5)`, so an even count gives the mean of the two middle values. Nullish operands are skipped and other values follow the invalid-number policy; `-0` counts as `0`. `p` must be a number from 0 to 1 when the plan is prepared.

Both keep their values in working memory, about 8 bytes per number and 48 bytes plus the value per distinct value, so `maxWorkingBytes` bounds them as it bounds groups. Percentiles and medians of one operand and predicate share their values, as do `countDistinct` and `distinct`.

## Minimum and maximum

`min` and `max` accept Booleans, numbers, BigInts, strings, Dates, binary values and arrays, ordered by the plan's semantics. They skip values that range filters also skip (nullish, `NaN`, invalid Dates). Any other object throws a `TypeError`. On ties they keep the first value seen.

## Predicates

`where` and measure `where` must produce Booleans; anything else throws a `TypeError`. Comparisons (`gt` and the rest) are `false` when either side is nullish, `NaN` or an invalid Date, as in range filters. `eq` and `neq` use value equality, so `eq(NaN, NaN)` is `true`.

`in`, `contains`, `startsWith` and `endsWith` give exactly what the filter operators give, so a filter can move into `where` unchanged; `in` takes any expression as its list, and a value that is no array never matches. VERIFIED: `src/compute/predicates.test.ts` compares each with its filter over every pair of 20 values in both equality modes.

`some(list, predicateFn)` is `true` when the predicate holds for one element of the array, `every(list, predicateFn)` when it holds for every element. `predicateFn` runs once, when the expression is built: it receives the element as an expression and returns a Boolean expression, so a descriptor stays plain data that JSON, workers and plan signatures carry. A value that is no array gives `false` for both, and an empty array gives `false` for `some` and `true` for `every`. Both stop at the first element that decides. A predicate that gives no Boolean throws a `TypeError`. Quantifiers nest, and an inner predicate can read the outer element: each nesting level has its own element. An element expression used outside its predicate throws a `TypeError` when the plan is prepared.

`typeOf(x)` names the value's family in the typed order: `'undefined'`, `'null'`, `'boolean'`, `'number'` (also for `NaN`), `'bigint'`, `'string'`, `'date'` (also for an invalid Date), `'binary'`, `'array'` or `'object'`.

## Grouping

Two rows share a group when every key component is equal under the plan's equality:

- `NaN` groups with `NaN`, and `+0` with `-0`.
- A missing key groups with `undefined`; `null` is a separate group.
- `1`, `1n`, `'1'` and `true` are four groups.
- With value equality (the default), Dates group by timestamp, binary values by their visible bytes and arrays element by element. With `equality: 'identity'`, every object is its own group.
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
- Counts and `sumBigInt` add exactly, and the variance measures add their exact sums. `min` and `max` keep the first of equal values, from the earliest part. Exact sums add the parts' exact terms, so their result is the single-pass result. Distinct values and percentile values are carried in full, so their results equal the single-pass results.
- HAVING, `orderBy` and paging apply to the merged groups. A group that would fail HAVING within one part can pass after merging.
- Binary `min` and `max` values in a partial are copies of their visible bytes, and every value in a partial that crossed a worker boundary is a structured clone: merged results equal the single-pass values without being the same objects.
- Group keys and distinct values that compare by identity cannot be copied without changing which rows they group: plain objects, arrays that contain them, and every object under `equality: 'identity'`. `partial()` rejects them with a `TypeError`. Arrays of primitives, Dates, binary values and such arrays compare by value and are carried as copies.

Given out of source order, the merged rows hold the same groups and the same counts, sums and `sumBigInt` values. Group order without `orderBy`, representative keys and the choice between equal `min`/`max` values then follow the given order.

## Counts and early stops

Plans read the whole input unless the result is already decided. Unsorted rows without `count: 'exact'` stop after the first row past the page; a grouping-only aggregate with a finite `limit`, no measures, no HAVING, no `orderBy` and no exact count stops after `offset + limit + 1` distinct groups. These runs report `totalResultRows: null` and `sourceExhausted: false`. Every other run is exact.
