import { DataviewError, estimateRowBytes } from '../stream/common.js';
import { bytesOf, invalidValue } from '../values.js';
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
function bigintBytes(value: bigint): number {
  if (value > -0x10000000000000000n && value < 0x10000000000000000n) return 24;
  return 16 + Math.ceil(value.toString(16).replace('-', '').length / 2);
}

export type StateKind = 'rows' | 'count' | 'sum' | 'min' | 'max' | 'sumBigInt';
/** One deduplicated state: sum(x) and avg(x) with the same operand and predicate share it. */
export interface StateSpec { readonly kind: StateKind; readonly arg: number | undefined; readonly where: number | undefined }
export interface MeasureSpec { readonly alias: string; readonly op: string; readonly state: number }

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const growth = (capacity: number) => Math.max(16, capacity * 2);
const STRICT: NumericPolicy = { invalidNumbers: 'error' };
/** Bytes charged for an exact sum's term list: array header plus one double per term. */
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
  constructor(readonly spec: StateSpec, private readonly ledger: Ledger, mode: NumberMode) {
    this.compensated = mode === 'compensated'; this.exact = mode === 'exact';
  }
  /** Bytes per group for this state's fixed-width components. */
  private width(): number {
    switch (this.spec.kind) {
      case 'rows': case 'count': return 8;
      case 'sum': return this.compensated ? 24 : 16;
      case 'min': case 'max': return 9;
      case 'sumBigInt': return 8;
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
      case 'sumBigInt': (this.values ??= []).length = capacity; break;
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
  private slotBytes(value: unknown): number { return this.exact && this.spec.kind === 'sum' ? termBytes(value as number[]) : retainedBytes(value); }
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
  /** min/max over DataView's typed order; invalid values skipped, opaque values rejected; ties keep the first. */
  addOrdered(gid: number, value: unknown, ops: ValueOps): void {
    if (invalidValue(value)) return;
    const type = typeof value;
    if (type === 'object' ? !(value instanceof Date) && !bytesOf(value) : type !== 'boolean' && type !== 'number' && type !== 'bigint' && type !== 'string')
      throw new TypeError(`min/max accept Booleans, numbers, BigInts, strings, Dates and binary values; got ${describe(value)}.`);
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
  private total(gid: number): number {
    return this.exact ? roundTerms(this.values![gid] as number[]) : this.sums![gid] + (this.corrections ? this.corrections[gid] : 0);
  }
  final(gid: number, op: string): unknown {
    switch (op) {
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
