import type { DataviewFilter } from '../types.js';
import type { QuerySemantics } from '../values.js';
import type { CancellationSignal } from '../stream/types.js';

// Expressions carry their value type in a phantom property, so outputs are inferred from the descriptor itself
// instead of from a separately declared result type that could drift from it. A dynamic descriptor widens to
// Record<string, unknown>, never any.
// VERIFIED: tests/types/api.ts checks exact aliases, nullable arithmetic and the dynamic case, also inside the packed tarball.
declare const valueType: unique symbol;
/** A declarative expression node. `V` is the value it produces; it exists only for inference. */
export interface Expr<V> {
  readonly v: 1;
  readonly op: string;
  readonly [valueType]?: V;
}
/** An aggregate measure: count, sum, avg, min, max or sumBigInt over an optional operand and predicate. */
export interface AggregateExpr<V> {
  readonly v: 1;
  readonly op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'sumBigInt';
  readonly arg?: Expr<unknown>;
  readonly where?: Expr<boolean>;
  readonly [valueType]?: V;
}
export type ExprValue<E> = E extends Expr<infer V> ? V : E extends AggregateExpr<infer V> ? V : never;
export interface MeasureOptions { where?: Expr<boolean> }
type Numeric = number | null | undefined;

export interface ComputeBuilders<T> {
  /** An own top-level property; a missing property reads as undefined. */
  field<K extends keyof T & string>(key: K): Expr<T[K]>;
  /** A dot path with the same own-property semantics as filters; narrow it with number() before arithmetic. */
  path(path: string): Expr<unknown>;
  literal<V>(value: V): Expr<V>;
  /** Runtime-validated narrowing: a finite number or null; other values follow the plan's invalidNumbers policy. */
  number(expr: Expr<unknown>): Expr<number | null>;
  add(a: Expr<Numeric>, b: Expr<Numeric>): Expr<number | null>;
  sub(a: Expr<Numeric>, b: Expr<Numeric>): Expr<number | null>;
  mul(a: Expr<Numeric>, b: Expr<Numeric>): Expr<number | null>;
  div(a: Expr<Numeric>, b: Expr<Numeric>): Expr<number | null>;
  coalesce<V>(...exprs: Expr<V>[]): Expr<V>;
  eq(a: Expr<unknown>, b: Expr<unknown>): Expr<boolean>;
  neq(a: Expr<unknown>, b: Expr<unknown>): Expr<boolean>;
  gt(a: Expr<unknown>, b: Expr<unknown>): Expr<boolean>;
  gte(a: Expr<unknown>, b: Expr<unknown>): Expr<boolean>;
  lt(a: Expr<unknown>, b: Expr<unknown>): Expr<boolean>;
  lte(a: Expr<unknown>, b: Expr<unknown>): Expr<boolean>;
  isNullish(a: Expr<unknown>): Expr<boolean>;
  and(...exprs: Expr<boolean>[]): Expr<boolean>;
  or(...exprs: Expr<boolean>[]): Expr<boolean>;
  not(expr: Expr<boolean>): Expr<boolean>;
  /** count() counts matching rows; count(expr) counts non-nullish values. */
  count(expr?: Expr<unknown>, options?: MeasureOptions): AggregateExpr<number>;
  sum(expr: Expr<Numeric>, options?: MeasureOptions): AggregateExpr<number | null>;
  avg(expr: Expr<Numeric>, options?: MeasureOptions): AggregateExpr<number | null>;
  min<V>(expr: Expr<V>, options?: MeasureOptions): AggregateExpr<NonNullable<V> | null>;
  max<V>(expr: Expr<V>, options?: MeasureOptions): AggregateExpr<NonNullable<V> | null>;
  sumBigInt(expr: Expr<bigint | null | undefined>, options?: MeasureOptions): AggregateExpr<bigint | null>;
}

export interface PlanOptions {
  /** Source-order Neumaier compensation (default) or plain sequential IEEE additions. */
  numberMode?: 'compensated' | 'sequential';
  /** NaN, infinities and non-numbers in numeric positions: throw TypeError (default) or treat as null. */
  invalidNumbers?: 'error' | 'skip';
  semantics?: QuerySemantics;
  /** Ordinary DataView filters over source fields, applied before `where`. */
  filters?: readonly DataviewFilter[];
  where?: Expr<boolean>;
}
export interface RowOrder { expr: Expr<unknown>; direction?: 'asc' | 'desc' }
export interface OutputOrder { field: string; direction?: 'asc' | 'desc' }
export interface RowsDescriptor extends PlanOptions {
  select: Readonly<Record<string, Expr<unknown>>>;
  orderBy?: readonly RowOrder[];
}
export interface AggregateDescriptor extends PlanOptions {
  groupBy?: Readonly<Record<string, Expr<unknown>>>;
  measures: Readonly<Record<string, AggregateExpr<unknown>>>;
  /** Filters over output aliases, applied to finalized groups before ordering and paging. */
  having?: readonly DataviewFilter[];
  orderBy?: readonly OutputOrder[];
}
export interface ViewDescriptor extends PlanOptions {
  select: Readonly<Record<string, Expr<unknown>>>;
  totals: Readonly<Record<string, AggregateExpr<unknown>>>;
  orderBy?: readonly RowOrder[];
}
type Values<M> = { -readonly [K in keyof M]: ExprValue<M[K]> };
type Simplify<O> = { [K in keyof O]: O[K] } & {};
export type RowsOutput<D extends RowsDescriptor> = Simplify<Values<D['select']>>;
export type AggregateOutput<D extends AggregateDescriptor> = Simplify<Values<D['groupBy'] extends object ? D['groupBy'] : {}> & Values<D['measures']>>;
export type TotalsOutput<D extends ViewDescriptor> = Simplify<Values<D['totals']>>;

export interface ComputeOptions<T extends object> {
  /** 'exact' requires totalResultRows; it never changes measure precision. Default 'none'. */
  count?: 'none' | 'exact';
  batchSize?: number;
  maxBatchBytes?: number;
  maxRowBytes?: number;
  maxScannedRows?: number;
  yieldEveryBatches?: number;
  /** Input row accounting, as for stream queries. */
  sizeOf?: (row: T) => number;
  /** Accounting of each produced output row; default: the structural estimator. */
  sizeOfOutput?: (row: object) => number;
  /** Group tables, aggregate state and retained row candidates. Default 64 MiB. */
  maxWorkingBytes?: number;
  /** Default 100,000; exceeding it fails, it never drops a group. */
  maxGroups?: number;
  /** Collected output rows and bytes for evaluate(). Defaults 100,000 rows, 64 MiB. */
  maxOutputRows?: number;
  maxOutputBytes?: number;
  /** Count field reads into summary.fieldReads. Off by default because counting perturbs the hot loop. */
  profile?: boolean;
  signal?: CancellationSignal;
}
export interface Page { offset?: number; limit?: number }
export type ComputeStrategy = 'scan' | 'ordered' | 'top-k' | 'sort' | 'scalar' | 'hash' | 'ordered-groups' | 'first-seen';
export interface ComputeSummary {
  revision: string | number | bigint;
  sourceRows: number | null;
  scannedRows: number;
  observedInputMatches: number;
  /** Exact only once the scan reached the end of the source. */
  totalInputMatches: number | null;
  /** Rows or groups after HAVING, before paging; null when the plan stopped early. */
  totalResultRows: number | null;
  returnedRows: number;
  hasMore: boolean;
  sourceExhausted: boolean;
  strategy: ComputeStrategy;
  executionComplete: true;
  peakWorkingBytes: number;
  peakOutputBytes: number;
  peakGroups: number;
  /** Bytes of already-built source columns this execution pinned; compute never builds columns itself. */
  cacheBytesPinned: number;
  cacheBuilds: 0;
  prunedRows: 0;
  /** Field reads from rows plus reads from leased columns, when `profile` is set; otherwise null. */
  fieldReads: number | null;
}
export type ComputeEvent<R, X = never> = { type: 'batch'; rows: readonly R[] } | { type: 'complete'; summary: ComputeSummary } & ([X] extends [never] ? object : { totals: X });
export interface ComputeResult<R> { rows: R[]; summary: ComputeSummary }
export interface ViewResult<R, X> { rows: R[]; totals: X; summary: ComputeSummary }
export interface Explain {
  readonly kind: 'rows' | 'aggregate' | 'view';
  readonly requiredFields: readonly string[];
  readonly operators: readonly string[];
  readonly measures: readonly { readonly alias: string; readonly op: string; readonly state: number }[];
  readonly states: number;
  readonly strategies: readonly ComputeStrategy[];
  readonly notes: readonly string[];
}
export interface PreparedCompute<T extends object, R, X = never> {
  evaluate(source: import('../stream/types.js').RecordSource<T>, page?: Page, options?: ComputeOptions<T>): Promise<[X] extends [never] ? ComputeResult<R> : ViewResult<R, X>>;
  stream(source: import('../stream/types.js').RecordSource<T>, page?: Page, options?: ComputeOptions<T>): AsyncGenerator<ComputeEvent<R, X>>;
  explain(): Explain;
}
export interface ComputeFor<T extends object> extends ComputeBuilders<T> {
  rows<const D extends RowsDescriptor>(descriptor: D): PreparedCompute<T, RowsOutput<D>>;
  aggregate<const D extends AggregateDescriptor>(descriptor: D): PreparedCompute<T, AggregateOutput<D>>;
  view<const D extends ViewDescriptor>(descriptor: D): PreparedCompute<T, RowsOutput<D>, TotalsOutput<D>>;
}
