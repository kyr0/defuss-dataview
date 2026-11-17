import type { DataviewFilterOperator } from './types.js';

/** Private captured operands: identical references/copies to the executable plan. */
export interface CapturedFilter { field: string; op: DataviewFilterOperator; value: unknown; members?: readonly unknown[] }
export interface QueryDetails {
  compareValues: (a: unknown, b: unknown) => number;
  filters: readonly CapturedFilter[];
}
const details = new WeakMap<object, QueryDetails>();
export function registerQueryDetails(query: object, value: QueryDetails): void { details.set(query, value); }
export function queryDetails(query: object): QueryDetails | undefined { return details.get(query); }
