# Compute engine

`compile.ts` turns a descriptor into a frozen plan: it validates aliases and descriptor properties, interns expressions through `expressions.ts`, deduplicates measure states and builds `explain()`. `expressions.ts` owns the node vocabulary, validation limits and the per-execution evaluators. `aggregate.ts` owns the working-memory `Ledger` and the measure state columns. `group-table.ts` maps key tuples to dense group ids. `execute.ts` binds a plan to one snapshot, runs the per-batch kernel, finalizes groups and emits output. `../compute.ts` is the public entry; `types.ts` holds the public types and output inference.

A plan never holds source state, so one plan runs on several sources concurrently; every execution builds its own evaluators, tables and state. Input reading, row validation, host fairness and cancellation between batches come from `readBatches` in `../stream/driver.ts`, which applies the stream executor's batch rules; session validation is shared with it. Existing key-cache columns reach compute only through the private registry in `../stream/field-capability.ts`, bound to the identity of the source's original `scan`, as for the other stream capabilities; compute leases them for one execution and never builds them.

Why native Maps for grouping, not a custom hash table: SameValueZero already gives the grouping equality for primitives, Dates and bytes get their own maps, and VERIFIED: a compact open-addressed table measured faster only at 100,000 single-number keys (documentation/COMPUTE_PERFORMANCE.md), below the plan's 10% gate inside a full plan (HYPOTHESIS there, with its falsifier).

Why one synchronous kernel per batch: the async generator around it holds the source and output protocol; keeping the row loop in a plain function lets the engine optimize it. VERIFIED: the change cut a 200,000-row scalar sum from 10.6 ms to 7.0 ms (2026-11-17).

Operations: no I/O, no timers beyond the driver's host yields, no logging. Security: plans are validated data; nothing is compiled from strings, and unsafe keys and non-plain alias objects are rejected. Privacy: an execution keeps no rows after it ends, and the only cross-execution state is the source's own key cache.

Tests: `compute.test.ts` (descriptors, projection, scalar measures, views, lifecycle), `grouping.test.ts` (equality, caps, leases, strategies), `operators.test.ts` (every operator, validation errors, edge strategies) and `oracle.test.ts`, which compares every plan kind with the independent evaluator in `tests/compute/oracle.ts`.
