# Architecture and audit

Source baseline: `kyr0/defuss`, `packages/dataview`, commit `50aae32aa9aea45612510703e75875ed98aa6386`, package 0.3.1. The GitHub plugin confirmed this as main during preparation. The standalone package preserves every original test and benchmark; fixture and test hashes are checked by `npm run verify`.

## Reproduced issues

| Issue | Upstream observation | Change |
| --- | --- | --- |
| Parent cycle with default ancestors | Exceeded subprocess deadline; parent walk never terminates | Break cycles once before all hierarchy operations |
| 20k-deep tree | `RangeError: Maximum call stack size exceeded` | Iterative traversal |
| Cycle plus unrelated root | Cyclic component omitted | Every normalized component receives a root |
| Explicit empty expansion | Child still visible | Explicit expand-all flag; empty list collapses |
| Structurally equal ID | Selection false | Canonical JSON identity shared across operations |
| Nested patch identifier | Matching row unchanged | Shared dot-path access |
| Equal patch | New array/row allocated | Shallow own-property comparison; lazy copy |
| View subtype metadata update | Extra property lost despite return type T | Preserve view with spread; replace only meta |
| Inherited filter field | Prototype value matched | Own-property traversal |
| Descending NaN ties | Input order reversed | Stable invalid-value equivalence and type ordering |

`scripts/audit-upstream.mjs` writes reproducible observations to `artifacts/upstream-audit.json`. The pinned original source is retained under `tests/fixtures/upstream-src` in the source distribution only. The current regressions directly assert corrected behavior, including an isolated-process cycle deadline, 50k-deep and 150k-wide trees. A seeded differential test compares 160 ordinary forest/filter/sort/paging cases with the original implementation.

## Modules

- `types.ts`: public descriptor, state, entry, result and metadata types.
- `normalize.ts`: validation/defaults, explicit expansion mode, detached metadata IDs.
- `fields.ts`: validated own-property reads and immutable nested parent writes.
- `identity.ts`: canonical JSON identity, duplicate removal and ID-list equality.
- `query.ts`: compiled predicates and stable comparison rules; no code generation.
- `tree.ts`: cycle normalization, hierarchy inclusion, sorted iterative traversal.
- `dataview.ts`: flat execution and shared pagination result contract.
- `view-meta.ts`: state-preserving UI helpers.
- `data-patch.ts`: immutable shallow batches and guarded tree moves.

No module stores user data globally or imports a browser/Node API at runtime. There are no runtime dependencies. Request compilation is per apply; descriptors remain ordinary mutable JavaScript objects, so implicit caching would require a new invalidation contract and is intentionally absent.

## Hierarchy algorithm

Build a first-wins ID index and parent-index array. Color-walk this functional graph, cutting the lowest-index cycle member's parent edge in each component. The resulting forest permits finite parent and child walks while retaining every row. Build child lists only for parents that have children; sort roots/siblings when requested.

Evaluate filters once per row. Ancestor propagation uses a processed bitset: each ancestor edge is visited at most once, fixing quadratic work on chains. Descendant propagation also uses a visited bitset and single-value stack pushes, avoiding both duplicate work and engine argument-count limits. Iterative preorder tracks original hierarchy depth, applies expansion/depth visibility, counts visible entries, and allocates entry/meta objects only for the requested page.

With primitive IDs and fixed predicate/path costs, hierarchy construction, cycle handling, inclusion and traversal are O(n) time and O(n) working memory. Sibling sorting adds O(sum(k log k)) and comparator work. Canonical composite IDs additionally cost serialization and sorting of their object keys. Deep nested identifiers themselves are not promised stack-unbounded; only row hierarchy traversal is iterative.

Flat filtered/unsorted evaluation counts matches in one pass and allocates O(pageSize) result entries when paged. With neither filters nor sorters, counts come directly from array length and only the requested page is read: O(pageSize). Sorting still materializes all candidates and performs a full stable sort, then reads only its requested page. No top-k algorithm, persistent index or incremental query engine is introduced. Filtered exact totals require scanning all candidates.

## Compatibility and trade-offs

0.4.0 is a pre-1.0 minor release because empty expansion, malformed paths, invalid identifiers, parent cycles, mixed-type sorting and unsafe integers have corrected semantics. See README migration notes. The previous entry points, ESM/CommonJS formats, runtime engine range, procedural signatures and all 67 original tests are retained.

Canonical JSON IDs support descriptor round trips without reference-identity mismatch. Filter equality deliberately remains strict equality; changing it would alter unrelated filtering semantics. Object-key order is ignored only for identifiers. Native string collation remains host-dependent, matching upstream behavior; callers needing exact cross-locale ordering should normalize their sort keys.

Local benchmark reports contain raw samples and disclose regressions as well as gains. Safer access, composite identity and exact counts have costs. The primary performance guarantee is elimination of quadratic ancestor traversal and recursion/argument-limit failures, not a universal latency improvement.

## Packaging gates

pkgroll creates ESM/CJS JavaScript and matching declarations; esbuild creates direct browser ESM assets and measured sizes. Type checks run without DOM ambient libraries against a tarball installed outside the workspace. Runtime smoke tests import ESM and CommonJS while browser-global access throws. Playwright exercises the built minified bundle and a real module worker. Unit coverage excludes original fixture implementation; it measures current runtime source only.
