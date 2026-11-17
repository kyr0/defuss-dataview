/**
 * defuss-dataview/compute: projection, scalar and grouped aggregation, and page-plus-totals views over the same
 * snapshot sources as defuss-dataview/stream. Plans are prepared once, immutable, and safe to run concurrently.
 * VERIFIED: the root entry does not import this module; scripts/package-tests.mjs checks every compute export path.
 */
import { collect, execute } from './compute/execute.js';
import { compilePlan } from './compute/compile.js';
import type { Plan } from './compute/compile.js';
import { createBuilders } from './compute/expressions.js';
import type { ComputeFor, ComputeOptions, Page, PreparedCompute } from './compute/types.js';
import type { RecordSource } from './stream/types.js';
export type * from './compute/types.js';
export { MAX_EXPRESSION_DEPTH, MAX_PLAN_NODES } from './compute/expressions.js';

function prepared(plan: Plan): PreparedCompute<object, never, never> {
  return Object.freeze({
    evaluate: (source: RecordSource<object>, page?: Page, options?: ComputeOptions<object>) => collect(plan, source, page, options),
    stream: (source: RecordSource<object>, page?: Page, options?: ComputeOptions<object>) => execute(plan, source, page, options),
    explain: () => plan.explain,
  }) as unknown as PreparedCompute<object, never, never>;
}

/** Binds the row type for inference and returns expression builders plus the three plan factories. */
export function forRows<T extends object>(): ComputeFor<T> {
  return Object.freeze({
    ...createBuilders<T>(),
    rows: descriptor => prepared(compilePlan('rows', descriptor)),
    aggregate: descriptor => prepared(compilePlan('aggregate', descriptor)),
    view: descriptor => prepared(compilePlan('view', descriptor)),
  } as ComputeFor<T>);
}
