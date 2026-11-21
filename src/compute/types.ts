import type { DataviewFilter } from '../types.js';
import type { QuerySemantics } from '../values.js';
import type { CancellationSignal } from '../stream/types.js';
import type { DatePart, DateUnit } from './dates.js';

export type { DatePart, DateUnit };

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
/** An aggregate measure over an optional operand and predicate; `p` is percentile()'s fraction. */
export interface AggregateExpr<V> {
  readonly v: 1;
  readonly op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'sumBigInt' | 'countDistinct' | 'distinct' | 'percentile' | 'median';
  readonly arg?: Expr<unknown>;
  readonly where?: Expr<boolean>;
  readonly p?: number;
  readonly [valueType]?: V;
}
export type ExprValue<E> = E extends Expr<infer V> ? V : E extends AggregateExpr<infer V> ? V : never;
export interface MeasureOptions { where?: Expr<boolean> }
/** IANA time zone of a date expression, such as 'Europe/Berlin'; default 'UTC'. */
export interface ZoneOptions { timeZone?: string }
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
  /** `then` when `test` is true, else `otherwise`; only the chosen branch is evaluated. */
  cond<A, B>(test: Expr<boolean>, then: Expr<A>, otherwise: Expr<B>): Expr<A | B>;
  floor(expr: Expr<Numeric>): Expr<number | null>;
  ceil(expr: Expr<Numeric>): Expr<number | null>;
  /** To the nearest integer, halves away from zero. */
  round(expr: Expr<Numeric>): Expr<number | null>;
  abs(expr: Expr<Numeric>): Expr<number | null>;
  /**
   * Epoch milliseconds of a Date, so dates take arithmetic: `sub(epochMs(b), epochMs(a))` is the duration between
   * them. A number in the Date range passes through; nullish operands and invalid Dates give null.
   */
  epochMs(expr: Expr<unknown>): Expr<number | null>;
  /** The start of the instant's year, quarter, month, ISO week (Monday), day, hour or minute, as a Date. */
  dateTrunc(expr: Expr<unknown>, unit: DateUnit, options?: ZoneOptions): Expr<Date | null>;
  /** year, quarter (1-4), month (1-12), day (1-31), weekday (ISO, 1 = Monday), hour (0-23) or minute. */
  datePart(expr: Expr<unknown>, part: DatePart, options?: ZoneOptions): Expr<number | null>;
  lower(expr: Expr<unknown>): Expr<string | null>;
  upper(expr: Expr<unknown>): Expr<string | null>;
  trim(expr: Expr<unknown>): Expr<string | null>;
  /** Code points from `start`, `length` of them or to the end. */
  substring(expr: Expr<unknown>, start: number, length?: number): Expr<string | null>;
  /** Joined strings; null when any operand is nullish. */
  concat(...exprs: Expr<unknown>[]): Expr<string | null>;
  /** Code points of a string, or elements of an array. */
  length(expr: Expr<unknown>): Expr<number | null>;
  /**
   * A whole groupBy key only: a row joins one group per distinct element of the array, as MongoDB's `$unwind`, and
   * no group for an empty array; any other value groups as it is.
   */
  each<V>(expr: Expr<readonly V[] | V>): Expr<V>;
  /** count() counts matching rows; count(expr) counts non-nullish values. */
  count(expr?: Expr<unknown>, options?: MeasureOptions): AggregateExpr<number>;
  sum(expr: Expr<Numeric>, options?: MeasureOptions): AggregateExpr<number | null>;
  avg(expr: Expr<Numeric>, options?: MeasureOptions): AggregateExpr<number | null>;
  min<V>(expr: Expr<V>, options?: MeasureOptions): AggregateExpr<NonNullable<V> | null>;
  max<V>(expr: Expr<V>, options?: MeasureOptions): AggregateExpr<NonNullable<V> | null>;
  sumBigInt(expr: Expr<bigint | null | undefined>, options?: MeasureOptions): AggregateExpr<bigint | null>;
  /** Distinct non-nullish values, under the equality of group keys. */
  countDistinct(expr: Expr<unknown>, options?: MeasureOptions): AggregateExpr<number>;
  /** The distinct non-nullish values in first-encounter order; [] without values. */
  distinct<V>(expr: Expr<V>, options?: MeasureOptions): AggregateExpr<NonNullable<V>[]>;
  /** Exact percentile, `p` from 0 to 1, interpolated linearly between the closest ranks; null without values. */
  percentile(expr: Expr<Numeric>, p: number, options?: MeasureOptions): AggregateExpr<number | null>;
  /** percentile(expr, 0.5). */
  median(expr: Expr<Numeric>, options?: MeasureOptions): AggregateExpr<number | null>;
}

/**
 * How sum and avg add floating-point numbers: source-order Neumaier compensation (default), plain sequential IEEE
 * additions, or 'exact': the correctly rounded sum, independent of order and partitioning, so partials can merge.
 */
export type NumberMode = 'compensated' | 'sequential' | 'exact';
export interface PlanOptions {
  numberMode?: NumberMode;
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
export type ComputeStrategy = 'scan' | 'ordered' | 'top-k' | 'sort' | 'scalar' | 'hash' | 'ordered-groups' | 'first-seen' | 'merge';
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
/** Input options of one partial scan; output options belong to merge(). */
export type PartialOptions<T extends object> = Omit<ComputeOptions<T>, 'count' | 'sizeOfOutput' | 'maxOutputRows' | 'maxOutputBytes'>;
/** Options of the final stage: its working memory, groups, output batches and collected output. */
export type MergeOptions = Pick<ComputeOptions<object>, 'batchSize' | 'maxBatchBytes' | 'sizeOfOutput' | 'maxWorkingBytes' | 'maxGroups' | 'maxOutputRows' | 'maxOutputBytes' | 'signal'>;
/**
 * One measure state of a partial, by group: `counts` for count measures; `counts`, `offsets` and `terms` for exact
 * sums (group g's terms are terms[offsets[g]] up to terms[offsets[g + 1]]); `values` for min, max and sumBigInt,
 * `undefined` where a group has none; `offsets` and `items` for distinct values; `offsets` and `numbers` for
 * percentiles. Treat it as opaque: its layout belongs to the partial format version.
 */
export type PartialState = { readonly counts: Float64Array } | { readonly counts: Float64Array; readonly offsets: Float64Array; readonly terms: Float64Array }
  | { readonly values: readonly unknown[] } | { readonly offsets: Float64Array; readonly items: readonly unknown[] } | { readonly offsets: Float64Array; readonly numbers: Float64Array };
/**
 * The mergeable state of one aggregate plan over one part of a snapshot. Plain data that survives structuredClone and
 * postMessage (BigInts, Dates, typed arrays, undefined), not JSON. merge() validates it as untrusted input.
 */
export interface PartialAggregate {
  /** Partial format version; merge() rejects other versions. */
  readonly format: 1;
  /** Fingerprint of the plan's descriptor; merge() rejects a partial of a different plan. */
  readonly signature: string;
  readonly revision: string | number | bigint;
  readonly scannedRows: number;
  readonly matchedRows: number;
  /** Groups in this part, in first-encounter order; 1 for a plan without groupBy. */
  readonly groups: number;
  /** Representative key values, one array per groupBy alias, indexed by group. */
  readonly keys: readonly (readonly unknown[])[];
  /** One entry per deduplicated measure state, in plan order. */
  readonly states: readonly PartialState[];
  readonly peakWorkingBytes: number;
}
export interface PreparedCompute<T extends object, R, X = never> {
  evaluate(source: import('../stream/types.js').RecordSource<T>, page?: Page, options?: ComputeOptions<T>): Promise<[X] extends [never] ? ComputeResult<R> : ViewResult<R, X>>;
  stream(source: import('../stream/types.js').RecordSource<T>, page?: Page, options?: ComputeOptions<T>): AsyncGenerator<ComputeEvent<R, X>>;
  explain(): Explain;
}
/** An aggregate plan, which can also run as partial scans and one final merge. */
export interface PreparedAggregate<T extends object, R> extends PreparedCompute<T, R> {
  /**
   * Scans one part of a snapshot, such as a key range, into mergeable state. Filters, where and measures apply here;
   * having, orderBy and paging wait for merge(). Rejects with a TypeError when the plan has a sum or avg outside
   * numberMode 'exact', or when a group key would group by identity.
   */
  partial(source: import('../stream/types.js').RecordSource<T>, options?: PartialOptions<T>): Promise<PartialAggregate>;
  /**
   * Merges partials of disjoint parts of one snapshot revision. Given in source order, the result equals evaluate()
   * over the union of the parts, including group order and the first of equal min/max values.
   */
  merge(partials: readonly PartialAggregate[], page?: Page, options?: MergeOptions): Promise<ComputeResult<R>>;
}
export interface ComputeFor<T extends object> extends ComputeBuilders<T> {
  rows<const D extends RowsDescriptor>(descriptor: D): PreparedCompute<T, RowsOutput<D>>;
  aggregate<const D extends AggregateDescriptor>(descriptor: D): PreparedAggregate<T, AggregateOutput<D>>;
  view<const D extends ViewDescriptor>(descriptor: D): PreparedCompute<T, RowsOutput<D>, TotalsOutput<D>>;
}
