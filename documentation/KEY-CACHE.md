# Immutable query acceleration

`createImmutableArraySource` optionally owns a reusable field-projection cache.
It is off by default. Enable it for repeated queries over immutable records whose
sort/filter accessors are pure and stable. Every reachable value must stay immutable,
including values returned to callers. This is a caller contract, not deep freezing.

```ts
import { createImmutableArraySource, evaluateStream } from 'defuss-dataview/stream';

const source = createImmutableArraySource(rows, {
  keyCache: {
    maxBytes: 32 * 1024 * 1024,
    policy: 'slru',
    blockIndex: true,
  },
});
await source.prepare();                 // optional default byte-accounting warmup
await source.prepareKeys(['metrics.score', 'category']); // optional forced admission
const result = await evaluateStream(source, {
  filters: [{ field: 'category', op: 'eq', value: 'active' }],
  sorters: [{ field: 'metrics.score', direction: 'desc' }],
  limit: 50,
}, { count: 'exact' });
console.log(result.summary, source.keyCacheStats);
source.clearKeyCache();
```

No key cache is created by `prepareKeys` when `keyCache` was omitted. It returns
undefined in that case. With a cache, preparation is best-effort under its cap and
returns a source-global diagnostic snapshot; it does not promise every requested
field fitted, or that a concurrently replaced revision was prepared. Stats include
rejections. Explicit preparation bypasses popularity admission, but never memory
admission or active-reader pins. Ordinary queries prepare fields automatically
when their admission policy permits it.

## Data layout and reuse

One column per exact field path contains raw values indexed by source ordinal.
It can serve different filters, ascending/descending sorts and comparison semantics.
Comparison always uses the current compiled query's typed/locale comparator. Mixed
cached and uncached sort fields work together; missing capacity falls back to normal
property access. Stable ties still use source ordinals and returned row identity is
unchanged. An already ordered source does not build redundant sort columns.

The cache belongs to one source. Replacement creates a new revision namespace and
retires all old entries. Data lookups use exact field strings and revision objects;
no hash can substitute one column for another. Popularity history survives replacement
because field-access frequency can remain useful; cached values never cross revisions.

The separate `createIndexedArraySource(..., {cacheSortKeys:true})` option uses
transient columns plus a Uint32 permutation to build one fixed index. It releases
those columns before returning. Its cursor pages already reuse the final order.
The persistent source cache instead accelerates varying queries on one revision.

## Admission and eviction

| Policy | Behavior | Intended trade-off |
| --- | --- | --- |
| `slru` (default) | Bounded 512-hash first-touch history; repeated fields become eligible. Segmented LRU uses probation and protected queues. | Lower policy complexity and quick adaptation. Hash collisions may admit a field early, never change results. |
| `tiny-lfu` | Bloom doorkeeper, four-way count-min frequency sketch, saturating counts and periodic aging; compare candidate popularity with planned victims. Uses the same segmented queues. | Can avoid many rebuilds during scans, but can adapt more slowly to changed hot fields and lose latency despite fewer allocations. |

A first touch normally uses the generic query. Explicit `prepareKeys` can warm a
known workload immediately. Hash collisions and Bloom false positives affect only
admission efficiency. New second-touch admissions enter the protected segment:
otherwise two alternating new hot fields can thrash in a single probation slot.
The protected accounting target is 80% of the column cap; excess entries are demoted.
Pins can prevent eviction but do not increase the cap. All required victims are
planned before mutation; an impossible admission does not evict a partial prefix.
TinyLFU admits equal-frequency candidates, preventing saturated counters from
blocking a new hot field indefinitely. The aging interval is 10,000 field accesses.
This is a compact TinyLFU-style admission policy, not the W-TinyLFU window algorithm.

No LRU/frequency updates run inside row comparisons. Bookkeeping occurs at field
acquisition. Both policies are workload choices; measured traces are in artifacts/.

## Memory, lifetime and cancellation

`maxBytes` defaults to 32 MiB. It bounds accounted column entries, active old-revision
entries and in-flight build reservations together. Each field reserves
`64 + 2 * field.length + 8 * sourceRowCount` bytes, plus optional block summaries.
Reservation happens before allocation. Zero disables column storage. A cold admitted
column reads the entire immutable revision before query scanning; query scan/batch
budgets govern the scan, while projection has its separate cache budget. Include this
preparation cost when using small pages or tight scan limits. Builders and
active queries pin entries; capacity pressure selects the generic path rather than
failing an otherwise valid query. A cache can retain old revision data until the
last associated query releases its lease.

Admission metadata is separately bounded: SLRU accounts up to 16,384 bytes for its
512 numeric history entries; TinyLFU uses 4,224 typed-array payload bytes. Queue/map
and VM overhead, growing-array capacity, caller rows, source membership, default
accounting caches, input/output buffers and query retention remain separate.
These are deterministic accounting scopes, not a physical-heap guarantee.

Concurrent queries share an in-flight column build. Cancelling one waiter releases
only its pin; other waiters keep the build alive. Builders yield every 16,384 rows.
An unobserved build cancels at its next cooperative boundary. Clearing or replacing
retires entries immediately; pinned/building storage is reclaimed when safe.
Cancellation, callback errors, collector failure, iterator return and normal completion
all release leases. Private comparator/pruning closures drop their column references
on release. `clearKeyCache` leaves cumulative statistics and bounded popularity history.

`keyCacheStats` is a detached diagnostic snapshot: bytes, peakBytes, maxBytes,
metadataBytes, entries, pinnedEntries, buildingEntries, hits, misses, builds,
evictions, rejected and prunedRows. Builds count completed projections; rejections
include first-touch bypasses and insufficient capacity. Hits include shared builders.

## Optional block summaries

`blockIndex:true` adds a summary per 1,024 field values. Each summary has default-order
min/max bounds over valid range values and a scalar-equality Bloom filter. Bloom
payload uses eight bits per row, rounded up to a power of two with at least 64 bits;
three probes are used. Each block adds 64 accounted header bytes plus Bloom payload.

- `eq` and `in`: scalar hashing distinguishes types and respects SameValueZero,
  including NaN and signed zero. Object/Date/binary/identity operands fall back.
- `gt`, `gte`, `lt`, `lte`: default code-unit comparison permits conservative min/max
  rejection for scalar operands. Locale ranges fall back to exact predicates.
- Other operators retain exact evaluation. A positive Bloom result is always checked
  by the real predicate. Summaries never supply a successful match.

An input span can skip predicate execution only when every covered block is proven
impossible for at least one AND predicate. The entire emitted batch has already passed
current byte/row validation. Scanned rows, source-count checks, scan budgets, exact
match counts and cleanup remain enforced. `prunedRows` records avoided predicate
visits; it does not mean skipped validation, avoided reads or skipped decoding.
No DBSONL format or storage-I/O pruning change is part of this release.

## Choosing a configuration

Start with no persistent key cache for one-off queries. For repeated immutable
queries, measure the default SLRU cache under a fixed byte cap. Add block summaries
when selective filters can exclude substantial blocks. Evaluate TinyLFU when protecting
established hot fields and reducing rebuild volume matters. Include preparation,
first-query latency, changing hot sets, allocation volume and peak accounting in the
comparison. A higher hit rate alone is insufficient evidence of a faster query.
