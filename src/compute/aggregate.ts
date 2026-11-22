import { DataviewError, estimateRowBytes } from '../stream/common.js';
import { bytesOf, cloneKeepsEquality, invalidValue, latin1, listKey } from '../values.js';
import { describe, numeric } from './expressions.js';
import type { NumericPolicy, ValueOps } from './expressions.js';
import type { NumberMode, PartialState } from './types.js';

/**
 * Working-memory reservations. Every allocation or growth reserves first, allocates, then releases the old size, so
 * the cap bounds the peak including resize overlap instead of only the size after it.
 * VERIFIED: src/compute/compute.test.ts runs groups and states one below, at and above maxWorkingBytes and maxGroups.
 */
export class Ledger {
  used = 0;
  peak = 0;
  constructor(readonly limit: number) {}
  reserve(bytes: number): void {
    const next = this.used + bytes;
    if (!Number.isSafeInteger(next) || next > this.limit) throw new DataviewError('LIMIT_EXCEEDED', `Compute working memory would exceed maxWorkingBytes (${this.limit}).`);
    this.used = next;
    if (next > this.peak) this.peak = next;
  }
  release(bytes: number): void { this.used -= bytes; }
}

/** Retained bytes of a value kept as a representative: views keep their whole backing store alive. */
export function retainedBytes(value: unknown): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (typeof value === 'bigint') return bigintBytes(value);
  if (value instanceof Date) return 16;
  if (value instanceof ArrayBuffer) return 16 + value.byteLength;
  if (ArrayBuffer.isView(value)) return 16 + value.buffer.byteLength;
  if (typeof value === 'object' && value !== null) return estimateRowBytes(value);
  return 8;
}
const sliceTyped = Object.getPrototypeOf(Uint8Array.prototype).slice as (this: ArrayBufferView) => ArrayBufferView;
/**
 * A private copy of a binary value's visible bytes, of the same type; other values are returned as they are.
 * %TypedArray%.prototype.slice, not the value's own slice: Node's Buffer.prototype.slice returns a view of the pool.
 * VERIFIED: src/compute/grouping.test.ts 'copies a Node Buffer key instead of sharing its pooled memory'.
 */
export function ownBytes(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (ArrayBuffer.isView(value)) return sliceTyped.call(value);
  return value;
}
export { latin1 };
// Rough per-entry cost of a Map or Set slot plus its key, charged so the cap tracks table growth.
export const ENTRY_BYTES = 48;

/**
 * Distinct values of one group, in first-encounter order, under the equality of group keys: SameValueZero on
 * primitives; in value mode Dates by timestamp, binary values by their visible bytes (a private copy is kept) and
 * arrays by listKey(), each in its own set so a Date never meets a number; other objects by identity. Sets per family,
 * not one string key per value, because no delimiter or JSON encoding keeps 1, 1n, '1' and a Date at 1 apart.
 * VERIFIED: src/compute/operators.test.ts 'count distinct values with the equality of group keys', and the oracle's
 * linear search in tests/compute/oracle.ts.
 */
export class DistinctValues {
  static readonly BYTES = 64;
  readonly items: unknown[] = [];
  bytes = DistinctValues.BYTES;
  private primitives?: Set<unknown>;
  private dates?: Set<number>;
  private binary?: Set<string>;
  private lists?: Set<string>;
  private objects?: Set<object>;
  constructor(private readonly byValue: boolean) {}
  add(value: unknown, ledger: Ledger): void {
    const type = typeof value;
    if (type === 'function' || type === 'symbol') throw new TypeError(`Functions and symbols cannot be distinct values; got ${type}.`);
    let set: Set<unknown>, key: unknown = value, keyBytes = 0;
    if (type !== 'object' || value === null) set = this.primitives ??= new Set();
    else if (this.byValue && value instanceof Date) { set = (this.dates ??= new Set()) as Set<unknown>; key = value.getTime(); }
    else {
      const bytes = this.byValue ? bytesOf(value) : undefined;
      if (bytes) { set = (this.binary ??= new Set()) as Set<unknown>; key = latin1(bytes); keyBytes = 16 + bytes.length * 2; }
      else if (this.byValue && Array.isArray(value)) { set = (this.lists ??= new Set()) as Set<unknown>; key = listKey(value); keyBytes = 16 + (key as string).length * 2; }
      else set = (this.objects ??= new Set()) as Set<unknown>;
    }
    if (set.has(key)) return;
    const kept = this.byValue ? ownBytes(value) : value, bytes = ENTRY_BYTES + keyBytes + retainedBytes(kept);
    ledger.reserve(bytes);
    set.add(key); this.items.push(kept); this.bytes += bytes;
  }
}

function bigintBytes(value: bigint): number {
  if (value > -0x10000000000000000n && value < 0x10000000000000000n) return 24;
  return 16 + Math.ceil(value.toString(16).replace('-', '').length / 2);
}

export type StateKind = 'rows' | 'count' | 'sum' | 'min' | 'max' | 'sumBigInt' | 'distinct' | 'values' | 'moments';
/**
 * One deduplicated state: sum(x) and avg(x) with the same operand and predicate share it, as do countDistinct(x) and
 * distinct(x), every percentile and median of x, and the four variance and standard deviation measures of x.
 */
export interface StateSpec { readonly kind: StateKind; readonly arg: number | undefined; readonly where: number | undefined }
/** `p` is the fraction of a percentile or median. */
export interface MeasureSpec { readonly alias: string; readonly op: string; readonly state: number; readonly p?: number }

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const growth = (capacity: number) => Math.max(16, capacity * 2);
const STRICT: NumericPolicy = { invalidNumbers: 'error' };
/** Bytes charged for an exact sum's terms or a percentile's values: array header plus one double per number. */
const termBytes = (terms: readonly number[]) => 32 + 8 * terms.length;
export const malformed = (what: string) => new TypeError(`Malformed partial aggregate: ${what}.`);

/**
 * Rounds a nonoverlapping expansion (ascending magnitude, exact sum of every input) once to the nearest double,
 * ties to even: the final step of Shewchuk's msum as in Python's math.fsum.
 */
function roundTerms(terms: readonly number[]): number {
  let n = terms.length, hi = 0, lo = 0;
  if (!n) return 0;
  hi = terms[--n];
  while (n > 0) {
    const x = hi, y = terms[--n];
    hi = x + y; lo = y - (hi - x);
    if (lo !== 0) break;
  }
  // Half-way cases: the rest of the expansion decides the direction of a tie.
  if (n > 0 && ((lo < 0 && terms[n - 1] < 0) || (lo > 0 && terms[n - 1] > 0))) {
    const y = lo * 2, x = hi + y;
    if (y === x - hi) hi = x;
  }
  return hi;
}

// Veltkamp's splitter for doubles: 2^27 + 1.
const SPLIT = 134_217_729;
/** a * b as hi + lo exactly (Dekker's TwoProduct), for products that neither overflow nor underflow. */
function twoProduct(a: number, b: number): [number, number] {
  const p = a * b, t = SPLIT * a, ah = t - (t - a), al = a - ah, u = SPLIT * b, bh = u - (u - b), bl = b - bh;
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}

/**
 * Linear interpolation between the closest ranks of sorted values (Hyndman and Fan's type 7: the default of R and
 * NumPy, and Excel's PERCENTILE.INC): rank h = (n - 1) * p, between the values below and above it.
 */
function quantile(sorted: Float64Array, p: number): number {
  const h = (sorted.length - 1) * p, lo = Math.floor(h), f = h - lo;
  if (!f) return sorted[lo];
  const a = sorted[lo], b = sorted[lo + 1], x = a + f * (b - a);
  // b - a overflows for values near the double range; the weighted form cannot.
  return Number.isFinite(x) ? x : a * (1 - f) + b * f;
}

/**
 * One column per state component, indexed by group id, instead of one accumulator object per group.
 * Numeric components are typed arrays; counts stay exact safe integers and fail before they could round.
 */
export class StateColumns {
  capacity = 0;
  private counts?: Float64Array;
  private sums?: Float64Array;
  private corrections?: Float64Array;
  private values?: unknown[];
  private seen?: Uint8Array;
  private bytes = 0;
  private readonly compensated: boolean;
  private readonly exact: boolean;
  /** byValue: the plan's equality, for distinct values. */
  constructor(readonly spec: StateSpec, private readonly ledger: Ledger, mode: NumberMode, private readonly byValue = true) {
    this.compensated = mode === 'compensated'; this.exact = mode === 'exact';
  }
  /** Bytes per group for this state's fixed-width components. */
  private width(): number {
    switch (this.spec.kind) {
      case 'rows': case 'count': return 8;
      case 'sum': return this.compensated ? 24 : 16;
      case 'min': case 'max': return 9;
      case 'sumBigInt': case 'distinct': case 'values': return 8;
      case 'moments': return 16;
    }
  }
  ensure(gid: number): void {
    if (gid < this.capacity) return;
    const capacity = growth(this.capacity), bytes = capacity * this.width();
    this.ledger.reserve(bytes);
    const grow = <A extends Float64Array | Uint8Array>(old: A | undefined, make: (n: number) => A): A => { const next = make(capacity); if (old) next.set(old); return next; };
    switch (this.spec.kind) {
      case 'rows': case 'count': this.counts = grow(this.counts, n => new Float64Array(n)); break;
      case 'sum':
        this.counts = grow(this.counts, n => new Float64Array(n));
        if (this.exact) { (this.values ??= []).length = capacity; break; }
        this.sums = grow(this.sums, n => new Float64Array(n));
        if (this.compensated) this.corrections = grow(this.corrections, n => new Float64Array(n));
        break;
      case 'min': case 'max': this.seen = grow(this.seen, n => new Uint8Array(n)); (this.values ??= []).length = capacity; break;
      case 'sumBigInt': case 'distinct': case 'values': (this.values ??= []).length = capacity; break;
      case 'moments': this.counts = grow(this.counts, n => new Float64Array(n)); (this.values ??= []).length = capacity; break;
    }
    this.ledger.release(this.bytes); this.bytes = bytes; this.capacity = capacity;
  }
  /** Clears one slot for reuse by the ordered-groups strategy. */
  reset(gid: number): void {
    if (this.counts) this.counts[gid] = 0;
    if (this.sums) this.sums[gid] = 0;
    if (this.corrections) this.corrections[gid] = 0;
    if (this.seen) this.seen[gid] = 0;
    if (this.values) { const old = this.values[gid]; if (old !== undefined) this.ledger.release(this.slotBytes(old)); this.values[gid] = undefined; }
  }
  release(): void { this.ledger.release(this.bytes); this.bytes = 0; this.capacity = 0; if (this.values) for (const value of this.values) if (value !== undefined) this.ledger.release(this.slotBytes(value)); this.values = undefined; }
  private slotBytes(value: unknown): number {
    const { kind } = this.spec;
    if (kind === 'distinct') return (value as DistinctValues).bytes;
    if (kind === 'moments') { const [sums, squares] = value as [number[], number[]]; return termBytes(sums) + termBytes(squares); }
    return kind === 'values' || (this.exact && kind === 'sum') ? termBytes(value as number[]) : retainedBytes(value);
  }
  countRow(gid: number): void {
    const c = this.counts!;
    if (c[gid] === MAX_COUNT) throw new RangeError('A count would exceed Number.MAX_SAFE_INTEGER.');
    c[gid]++;
  }
  /** count(x): non-nullish values, NaN included. */
  countValue(gid: number, value: unknown): void { if (value !== null && value !== undefined) this.countRow(gid); }
  /** sum/avg: nullish skipped, invalid numbers per policy; source-order Neumaier or sequential update. */
  addNumber(gid: number, raw: unknown, policy: NumericPolicy): void {
    const x = numeric(raw, policy, 'sum/avg operand');
    if (x === null) return;
    if (this.exact) { this.addExact(gid, x); this.countRow(gid); return; }
    const sums = this.sums!, s = sums[gid], t = s + x;
    if (!Number.isFinite(t)) throw new RangeError(`A sum overflowed to ${t}.`);
    const corrections = this.corrections;
    if (corrections) {
      const c = corrections[gid] + (Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s);
      if (!Number.isFinite(c)) throw new RangeError('A compensated sum correction overflowed.');
      corrections[gid] = c;
    }
    sums[gid] = t;
    this.countRow(gid);
  }
  /**
   * numberMode 'exact': Shewchuk's msum keeps nonoverlapping terms whose sum is exactly the sum of every input, so the
   * final rounding gives the correctly rounded result, whatever the order, batch size or partitioning. A list grows by at
   * most one term per addition: that term is reserved first and the slack released after.
   * VERIFIED: src/compute/partial.test.ts 'exact sums' compares orders, batch sizes and every two-way split with the
   * BigInt reference in tests/compute/oracle.ts.
   */
  private addExact(gid: number, value: number): void {
    const values = this.values!, terms = values[gid] as number[] | undefined;
    if (terms === undefined) { this.ledger.reserve(termBytes([value])); values[gid] = [value]; return; }
    this.grow(terms, value);
  }
  /** Adds one double to a nonoverlapping expansion in place, reserving its growth first. */
  private grow(terms: number[], value: number): void {
    this.ledger.reserve(8);
    const length = terms.length;
    let x = value, i = 0;
    for (let j = 0; j < length; j++) {
      let y = terms[j];
      if (Math.abs(x) < Math.abs(y)) { const t = x; x = y; y = t; }
      const hi = x + y;
      if (!Number.isFinite(hi)) throw new RangeError(`A sum overflowed to ${hi}.`);
      const lo = y - (hi - x);
      if (lo !== 0) terms[i++] = lo;
      x = hi;
    }
    terms[i] = x; terms.length = i + 1;
    this.ledger.release(8 * (length - i));
  }
  /**
   * varPop, varSamp, stdDevPop, stdDevSamp: the exact sums of x and of x squared (each square split into two doubles by
   * TwoProduct), so the result does not depend on order, batch size or partitioning, and partials merge exactly.
   * VERIFIED: src/compute/oracle.test.ts compares them, also merged from 1, 2 and 5 parts, with exact BigInt arithmetic
   * in tests/compute/oracle.ts.
   */
  addMoment(gid: number, raw: unknown, policy: NumericPolicy): void {
    const x = numeric(raw, policy, 'variance operand');
    if (x === null) return;
    const [hi, lo] = twoProduct(x, x);
    if (!Number.isFinite(hi)) throw new RangeError(`A variance overflowed squaring ${x}.`);
    this.addMoments(gid, [x], [hi, lo]);
    this.countRow(gid);
  }
  private addMoments(gid: number, sums: readonly number[], squares: readonly number[]): void {
    const values = this.values!;
    let pair = values[gid] as [number[], number[]] | undefined;
    if (pair === undefined) { this.ledger.reserve(64); pair = [[], []]; values[gid] = pair; }
    for (const term of sums) this.grow(pair[0], term);
    for (const term of squares) this.grow(pair[1], term);
  }
  /** n * sum(x^2) - sum(x)^2, exactly, then rounded once: n^2 times the population variance. */
  private spread(gid: number, n: number): number {
    const [sums, squares] = this.values![gid] as [number[], number[]];
    const terms: number[] = [];
    this.ledger.reserve(termBytes(sums) * sums.length + termBytes(squares) * 2);
    const add = (a: number, b: number, sign: number) => {
      const [hi, lo] = twoProduct(a, b);
      if (!Number.isFinite(hi)) throw new RangeError('A variance overflowed when finalized.');
      this.grow(terms, sign * hi); this.grow(terms, sign * lo);
    };
    for (const q of squares) add(n, q, 1);
    for (const a of sums) for (const b of sums) add(a, b, -1);
    const total = roundTerms(terms);
    this.ledger.release(termBytes(sums) * sums.length + termBytes(squares) * 2 + 8 * terms.length);
    // Exact arithmetic cannot go negative; a square below the subnormal range can, by one rounding.
    return Math.max(0, total);
  }
  /** min/max over DataView's typed order; invalid values skipped, opaque objects rejected; ties keep the first. */
  addOrdered(gid: number, value: unknown, ops: ValueOps): void {
    if (invalidValue(value)) return;
    const type = typeof value;
    if (type === 'object' ? !(value instanceof Date) && !bytesOf(value) && !Array.isArray(value) : type !== 'boolean' && type !== 'number' && type !== 'bigint' && type !== 'string')
      throw new TypeError(`min/max accept Booleans, numbers, BigInts, strings, Dates, binary values and arrays; got ${describe(value)}.`);
    const values = this.values!, seen = this.seen!;
    if (seen[gid]) {
      const c = ops.compare(value, values[gid]);
      if (this.spec.kind === 'min' ? c >= 0 : c <= 0) return;
    }
    const bytes = retainedBytes(value);
    this.ledger.reserve(bytes);
    if (seen[gid]) this.ledger.release(retainedBytes(values[gid]));
    values[gid] = value; seen[gid] = 1;
  }
  /** sumBigInt: arbitrary precision; the result's size is reserved before the addition allocates it. */
  addBigInt(gid: number, value: unknown, policy: NumericPolicy): void {
    if (value === null || value === undefined) return;
    if (typeof value !== 'bigint') {
      if (policy.invalidNumbers === 'skip') return;
      throw new TypeError(`sumBigInt accepts BigInt values only; got ${describe(value)}.`);
    }
    const values = this.values!, old = values[gid] as bigint | undefined;
    if (old === undefined) { this.ledger.reserve(bigintBytes(value)); values[gid] = value; return; }
    // A sum has at most one more bit than its larger operand: reserve that bound, then settle to the actual size.
    const bound = Math.max(bigintBytes(old), bigintBytes(value)) + 1;
    this.ledger.reserve(bound);
    const next = old + value;
    this.ledger.release(bound - bigintBytes(next) + bigintBytes(old));
    values[gid] = next;
  }
  /** countDistinct/distinct: non-nullish values under the plan's equality, first occurrence kept. */
  addDistinct(gid: number, value: unknown): void {
    if (value === null || value === undefined) return;
    const values = this.values!;
    let set = values[gid] as DistinctValues | undefined;
    if (set === undefined) { this.ledger.reserve(DistinctValues.BYTES); set = new DistinctValues(this.byValue); values[gid] = set; }
    set.add(value, this.ledger);
  }
  /** percentile/median: every number is kept; nullish skipped, invalid numbers per policy. */
  addValue(gid: number, raw: unknown, policy: NumericPolicy): void {
    const value = numeric(raw, policy, 'percentile operand');
    if (value === null) return;
    // -0 as 0: the typed sort orders -0 before 0, so a -0 kept could change which zero a percentile returns.
    const x = value === 0 ? 0 : value;
    const values = this.values!, list = values[gid] as number[] | undefined;
    if (list === undefined) { this.ledger.reserve(termBytes([x])); values[gid] = [x]; return; }
    this.ledger.reserve(8);
    list.push(x);
  }
  private total(gid: number): number {
    return this.exact ? roundTerms(this.values![gid] as number[]) : this.sums![gid] + (this.corrections ? this.corrections[gid] : 0);
  }
  final(gid: number, op: string, p = 0.5): unknown {
    switch (op) {
      case 'countDistinct': return (this.values![gid] as DistinctValues | undefined)?.items.length ?? 0;
      case 'distinct': { const set = this.values![gid] as DistinctValues | undefined; return set ? [...set.items] : []; }
      case 'percentile': case 'median': {
        const list = this.values![gid] as number[] | undefined;
        if (!list) return null;
        // A typed array sorts numerically without a comparator call per pair. VERIFIED: a global median over 100,000
        // rows took 9.3 instead of 23.5 ms with Array.prototype.sort and a comparator (Node.js 26.13.1, 2026-11-21).
        this.ledger.reserve(8 * list.length);
        const value = quantile(Float64Array.from(list).sort(), p);
        this.ledger.release(8 * list.length);
        return value;
      }
      case 'count': return this.counts![gid];
      case 'sum': {
        if (!this.counts![gid]) return null;
        const total = this.total(gid);
        if (!Number.isFinite(total)) throw new RangeError('A sum overflowed when finalized.');
        return total;
      }
      case 'avg': {
        const n = this.counts![gid];
        if (!n) return null;
        const mean = this.total(gid) / n;
        if (!Number.isFinite(mean)) throw new RangeError('An average overflowed when finalized.');
        return mean;
      }
      case 'min': case 'max': return this.seen![gid] ? this.values![gid] : null;
      case 'sumBigInt': return this.values![gid] ?? null;
      case 'varPop': case 'varSamp': case 'stdDevPop': case 'stdDevSamp': {
        const n = this.counts![gid], sample = op === 'varSamp' || op === 'stdDevSamp';
        if (n < (sample ? 2 : 1)) return null;
        const variance = this.spread(gid, n) / n / (sample ? n - 1 : n);
        return op.startsWith('std') ? Math.sqrt(variance) : variance;
      }
    }
    throw new TypeError(`Unknown measure ${op}.`);
  }
  /**
   * The first `groups` slots as partial state: fresh typed columns for counts and exact sums (sum terms packed with
   * offsets), arrays for min/max and BigInt sums with `undefined` where a group has no value. Binary extremes are copied
   * to their visible bytes. VERIFIED: structuredClone of a 2-byte view into 1 MiB returns a 1 MiB buffer (Node.js 26,
   * 2026-11-20), so a postMessage would otherwise carry the whole backing store. Every copy is reserved.
   */
  export(groups: number): PartialState {
    const { kind } = this.spec;
    if (kind === 'rows' || kind === 'count' || kind === 'sum') this.ledger.reserve(8 * groups);
    // A grouped part without groups never allocated its columns.
    const counts = this.counts ? this.counts.slice(0, groups) : new Float64Array(groups);
    if (kind === 'rows' || kind === 'count') return { counts };
    const values = this.values ?? [];
    if (kind === 'distinct' || kind === 'values') return this.exportLists(groups, values);
    if (kind === 'moments') {
      const pack = (which: 0 | 1) => {
        let size = 0;
        for (let g = 0; g < groups; g++) size += (values[g] as [number[], number[]] | undefined)?.[which].length ?? 0;
        this.ledger.reserve(8 * (groups + 1) + 8 * size);
        const offsets = new Float64Array(groups + 1), terms = new Float64Array(size);
        for (let g = 0, at = 0; g < groups; g++) {
          const own = (values[g] as [number[], number[]] | undefined)?.[which];
          if (own) { terms.set(own, at); at += own.length; }
          offsets[g + 1] = at;
        }
        return [offsets, terms] as const;
      };
      const [offsets, terms] = pack(0), [squareOffsets, squares] = pack(1);
      return { counts, offsets, terms, squareOffsets, squares };
    }
    if (kind === 'sum') {
      let size = 0;
      for (let g = 0; g < groups; g++) size += (values[g] as number[] | undefined)?.length ?? 0;
      this.ledger.reserve(8 * (groups + 1) + 8 * size);
      const offsets = new Float64Array(groups + 1), terms = new Float64Array(size);
      for (let g = 0, at = 0; g < groups; g++) {
        const own = values[g] as number[] | undefined;
        if (own) { terms.set(own, at); at += own.length; }
        offsets[g + 1] = at;
      }
      return { counts, offsets, terms };
    }
    this.ledger.reserve(8 * groups);
    const out: unknown[] = Array.from({ length: groups });
    for (let g = 0; g < groups; g++) {
      const value = kind === 'sumBigInt' || this.seen![g] ? values[g] : undefined;
      if (typeof value === 'object' && !(value instanceof Date)) { const copy = ownBytes(value); this.ledger.reserve(retainedBytes(copy)); out[g] = copy; }
      else out[g] = value;
    }
    return { values: out };
  }
  /** Distinct values or percentile numbers of every group, packed with offsets as exact sum terms are. */
  private exportLists(groups: number, values: readonly unknown[]): PartialState {
    const distinct = this.spec.kind === 'distinct', list = (g: number) => (distinct ? (values[g] as DistinctValues | undefined)?.items : values[g] as number[] | undefined) ?? [];
    let size = 0;
    for (let g = 0; g < groups; g++) size += list(g).length;
    this.ledger.reserve(8 * (groups + 1) + 8 * size);
    const offsets = new Float64Array(groups + 1), packed = distinct ? Array.from<unknown>({ length: size }) : new Float64Array(size);
    for (let g = 0, at = 0; g < groups; g++) {
      for (const item of list(g)) {
        // Identity-equal objects cannot keep their equality through a structured clone.
        if (distinct && !cloneKeepsEquality(item, this.byValue))
          throw new TypeError('Partial aggregation cannot carry distinct values that compare by identity: objects other than value-mode Dates, binary values and arrays of such values.');
        packed[at++] = item as number;
      }
      offsets[g + 1] = at;
    }
    return distinct ? { offsets, items: packed as unknown[] } : { offsets, numbers: packed as Float64Array };
  }
  /**
   * Folds slot `index` of a partial state into group `gid`, validating each value as untrusted input. Counts and BigInt
   * sums add exactly; min/max apply the normal update, so merging parts in source order keeps the first of equal values;
   * exact sums add every term, which keeps the expansion exact. Column types and lengths are checked by the caller.
   */
  merge(gid: number, state: PartialState, index: number, ops: ValueOps): void {
    const { kind } = this.spec;
    if (kind === 'rows' || kind === 'count') { this.addCount(gid, (state as { counts: Float64Array }).counts[index]); return; }
    if (kind === 'sum') {
      const { counts, offsets, terms } = state as { counts: Float64Array; offsets: Float64Array; terms: Float64Array };
      const n = counts[index], start = offsets[index], end = offsets[index + 1];
      if (!Number.isInteger(start) || !(start <= end && end <= terms.length) || (n === 0) !== (start === end)) throw malformed('sum term offsets');
      for (let i = start; i < end; i++) {
        const term = terms[i];
        if (!Number.isFinite(term)) throw malformed('a sum term is not finite');
        this.addExact(gid, term);
      }
      this.addCount(gid, n);
      return;
    }
    if (kind === 'moments') {
      const { counts, offsets, terms, squareOffsets, squares } = state as { counts: Float64Array; offsets: Float64Array; terms: Float64Array; squareOffsets: Float64Array; squares: Float64Array };
      const n = counts[index], slice = (at: Float64Array, of: Float64Array) => {
        const start = at[index], end = at[index + 1];
        if (!Number.isInteger(start) || !(start <= end && end <= of.length) || (n === 0) !== (start === end)) throw malformed('variance term offsets');
        const out = Array.from(of.subarray(start, end));
        if (!out.every(Number.isFinite)) throw malformed('a variance term is not finite');
        return out;
      };
      const sums = slice(offsets, terms), sq = slice(squareOffsets, squares);
      if (n) this.addMoments(gid, sums, sq);
      this.addCount(gid, n);
      return;
    }
    if (kind === 'distinct' || kind === 'values') {
      const { offsets } = state as { offsets: Float64Array }, start = offsets[index], end = offsets[index + 1];
      const items = kind === 'distinct' ? (state as { items: readonly unknown[] }).items : (state as { numbers: Float64Array }).numbers;
      if (!Number.isInteger(start) || !(start <= end && end <= items.length)) throw malformed('list offsets');
      for (let i = start; i < end; i++) {
        const item = items[i];
        if (kind === 'values') { if (!Number.isFinite(item)) throw malformed('a percentile value is not finite'); this.addValue(gid, item, STRICT); continue; }
        if (item === null || item === undefined || !cloneKeepsEquality(item, this.byValue)) throw malformed('a distinct value');
        this.addDistinct(gid, item);
      }
      return;
    }
    const value = (state as { values: readonly unknown[] }).values[index];
    if (value === undefined) return;
    if (kind === 'sumBigInt') {
      if (typeof value !== 'bigint') throw malformed('a BigInt sum is not a BigInt');
      this.addBigInt(gid, value, STRICT);
    } else this.addOrdered(gid, value, ops);
  }
  private addCount(gid: number, n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw malformed('a count is not a safe nonnegative integer');
    const c = this.counts!, next = c[gid] + n;
    if (next > MAX_COUNT) throw new RangeError('A count would exceed Number.MAX_SAFE_INTEGER.');
    c[gid] = next;
  }
  /** Test hook for the count-boundary fixture: sets a slot's count. */
  setCount(gid: number, count: number): void { this.counts![gid] = count; }
}
