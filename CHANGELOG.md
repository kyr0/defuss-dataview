# Changelog

## Unreleased

- Fix `setParent` throwing on class-instance rows; the row is copied like `updateRows` and 0.3.1 do, nested dot-path containers stay plain-only.
- Fix views throwing once a selection exists when row IDs are not JSON values (e.g. BigInt); such rows are reported unselected.
- Fix `npm run check` / `prepublishOnly` failing on macOS in the isolated tarball consumer check.
- Add `make verify` (lint, test, coverage, e2e) and a matching CI workflow; lint now denies warnings.

## 0.4.0

- Fix nontermination on parent cycles, disconnected cycle loss, deep-tree stack overflow and wide-tree spread overflow.
- Make ancestor inclusion linear in hierarchy size; allocate paged tree metadata only for returned entries.
- Distinguish omitted expansion from an explicit empty list; preserve default-all toggles through `expandAll`/`collapsedIds`.
- Use consistent structural JSON identifiers across selection, expansion, parent linking and patches.
- Honor dot-path ID/parent fields in data patches; reject unsafe/inherited traversal and cyclic moves.
- Preserve array/row/view identity on no-ops and retain view extension fields.
- Stabilize NaN/invalid-date ties, define consistent mixed-type ordering, exclude invalid relational cells and reject unsafe paging integers.
- Add `evaluateDataview` with exact match/visibility/page counts; retain `applyDataview`'s array contract.
- Retain all 67 original tests, original benchmarks, public functions, runtime engine range and dual ESM/CommonJS packaging.
- Add regression/differential tests, browser and module-worker tests, standalone configuration/lockfile, tarball consumer checks, audit evidence, release workflow and documentation.

## 0.3.1

Upstream baseline from kyr0/defuss at the revision recorded in NOTICE. This file does not reconstruct an undocumented upstream changelog.
