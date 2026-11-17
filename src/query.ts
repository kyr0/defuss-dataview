import { compileAccessor } from './fields.js';
import { registerQueryDetails } from './query-internals.js';
import type { CapturedFilter } from './query-internals.js';
import { createDataview } from './normalize.js';
import { bytesOf, createValueOperations, invalidValue } from './values.js';
import type { DataviewFilter, DataviewRow, DataviewSorter } from './types.js';
import type { QuerySemantics } from './values.js';
export { compareValues, createValueOperations } from './values.js';
export type { QuerySemantics } from './values.js';
export interface QueryDescriptor {
  filters?: readonly DataviewFilter[];
  sorters?: readonly DataviewSorter[];
  semantics?: QuerySemantics;
}
/** A promise about the entire source scan, including batch boundaries. */
export interface QueryOrdering {
  readonly comparisonId: string;
  readonly sorters: readonly Readonly<{ field: string; direction: 'asc' | 'desc' }>[];
}
export interface CompiledQuery {
  readonly ordering: QueryOrdering;
  readonly hasFilters: boolean;
  matches(row: DataviewRow): boolean;
  compare(left: DataviewRow, right: DataviewRow): number;
}
/** Capture mutable value operands; opaque object equality keeps identity. */
function operand(value: unknown, byValue: boolean): unknown {
  if (!byValue) return value;
  if (value instanceof Date) return new Date(value.getTime());
  const bytes = bytesOf(value);
  return bytes ? bytes.slice() : value;
}
/** Compile once per execution. Closures capture descriptor configuration. */
export function compileQuery(request: QueryDescriptor = {}): CompiledQuery {
  const view = createDataview({ filters: request.filters as DataviewFilter[] | undefined, sorters: request.sorters as DataviewSorter[] | undefined });
  const ops = createValueOperations(request.semantics);
  const captured = view.filters as CapturedFilter[];
  const filters = view.filters.map(filter => {
    const get = compileAccessor(filter.field), op = filter.op;
    const value = operand(filter.value, ops.equality === 'value');
    const members = op === 'in' && Array.isArray(value) ? value.map(v => operand(v, ops.equality === 'value')) : undefined;
    filter.value = value;
    if (op === 'in') (filter as CapturedFilter).members = members;
    // Primitive membership can use SameValueZero directly. Dates/buffers need value comparison.
    const set = members && members.length > 16 && members.every(v => v === null || typeof v !== 'object') ? new Set(members) : undefined;
    // Choose the operation once, outside the row loop. Scalar guards avoid
    // generic ranking without coercing mixed types or admitting invalid ranges.
    const primitive = value === null || typeof value !== 'object';
    const equal = primitive ? (cell: unknown) => cell === value || (typeof value === 'number' && Number.isNaN(value) && typeof cell === 'number' && Number.isNaN(cell))
      : (cell: unknown) => ops.equal(cell, value);
    // Identity-mode Date operands remain references, so their validity can
    // change after compilation. Only primitive validity is safe to hoist.
    const valid = primitive ? !invalidValue(value) : undefined;
    const range = (cell: unknown): number | undefined => {
      if (!(valid ?? !invalidValue(value)) || invalidValue(cell)) return undefined;
      return ops.compare(cell, value);
    };
    switch (op) {
      case 'eq': return (row: DataviewRow) => equal(get(row));
      case 'neq': return (row: DataviewRow) => !equal(get(row));
      case 'gt': return (row: DataviewRow) => { const c = range(get(row)); return c !== undefined && c > 0; };
      case 'gte': return (row: DataviewRow) => { const c = range(get(row)); return c !== undefined && c >= 0; };
      case 'lt': return (row: DataviewRow) => { const c = range(get(row)); return c !== undefined && c < 0; };
      case 'lte': return (row: DataviewRow) => { const c = range(get(row)); return c !== undefined && c <= 0; };
      case 'in': return (row: DataviewRow) => { const cell = get(row); return set ? set.has(cell) : members?.some(v => ops.equal(cell, v)) ?? false; };
      case 'contains': return (row: DataviewRow) => { const cell = get(row); return typeof cell === 'string' && typeof value === 'string' ? cell.includes(value) : Array.isArray(cell) && cell.some(v => ops.equal(v, value)); };
      case 'startsWith': return (row: DataviewRow) => { const cell = get(row); return typeof cell === 'string' && typeof value === 'string' && cell.startsWith(value); };
      case 'endsWith': return (row: DataviewRow) => { const cell = get(row); return typeof cell === 'string' && typeof value === 'string' && cell.endsWith(value); };
    }
  });
  const sorters = view.sorters.map(s => ({ get: compileAccessor(s.field), sign: s.direction === 'desc' ? -1 : 1 }));
  const [f0, f1, f2, f3] = filters;
  const matches = filters.length === 1 ? f0
    : filters.length === 2 ? (row: DataviewRow) => f0(row) && f1(row)
    : filters.length === 3 ? (row: DataviewRow) => f0(row) && f1(row) && f2(row)
    : filters.length === 4 ? (row: DataviewRow) => f0(row) && f1(row) && f2(row) && f3(row)
    : (row: DataviewRow) => { for (const f of filters) if (!f(row)) return false; return true; };
  const comparisons = sorters.length >= 2 && sorters.length <= 4 ? sorters.map(s => (left: DataviewRow, right: DataviewRow) => {
    const result = ops.compare(s.get(left), s.get(right)); return result ? result * s.sign : 0;
  }) : [];
  const [c0, c1, c2, c3] = comparisons;
  // Explicit small arities preserve short-circuit reads and arbitrary typed
  // values; longer descriptors retain the compact generic loop. No runtime eval.
  const compare = sorters.length === 1 ? (a: DataviewRow, b: DataviewRow) => { const result = ops.compare(sorters[0].get(a), sorters[0].get(b)); return result ? result * sorters[0].sign : 0; }
    : comparisons.length === 2 ? (a: DataviewRow, b: DataviewRow) => c0(a,b) || c1(a,b)
    : comparisons.length === 3 ? (a: DataviewRow, b: DataviewRow) => c0(a,b) || c1(a,b) || c2(a,b)
    : comparisons.length === 4 ? (a: DataviewRow, b: DataviewRow) => c0(a,b) || c1(a,b) || c2(a,b) || c3(a,b)
    : (a: DataviewRow, b: DataviewRow) => { for (const s of sorters) { const result = ops.compare(s.get(a), s.get(b)); if (result) return result * s.sign; } return 0; };
  const compiled = Object.freeze({
    ordering: Object.freeze({ comparisonId: ops.comparisonId, sorters: Object.freeze(view.sorters.map(s => Object.freeze({ field: s.field, direction: s.direction }))) }),
    hasFilters: filters.length > 0, matches, compare,
  });
  registerQueryDetails(compiled, { compareValues: ops.compare, filters: captured });
  return compiled;
}
/** Exact comparator semantics and a matching sort prefix authorize ordered paging. */
export function orderingSatisfies(actual: QueryOrdering | undefined, requested: QueryOrdering): boolean {
  return requested.sorters.length === 0 || !!actual && actual.comparisonId === requested.comparisonId
    && requested.sorters.every((s, i) => s.field === actual.sorters[i]?.field && s.direction === actual.sorters[i]?.direction);
}
