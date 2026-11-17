import { DataviewError, estimateRowBytes } from '../stream/common.js';
import { bytesOf, invalidValue } from '../values.js';
import { describe, numeric } from './expressions.js';
import type { NumericPolicy, ValueOps } from './expressions.js';

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
  constructor(readonly spec: StateSpec, private readonly ledger: Ledger, private readonly compensated: boolean) {}
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
        this.counts = grow(this.counts, n => new Float64Array(n)); this.sums = grow(this.sums, n => new Float64Array(n));
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
    if (this.values) { const old = this.values[gid]; if (old !== undefined) this.ledger.release(retainedBytes(old)); this.values[gid] = undefined; }
  }
  release(): void { this.ledger.release(this.bytes); this.bytes = 0; this.capacity = 0; if (this.values) for (const value of this.values) if (value !== undefined) this.ledger.release(retainedBytes(value)); this.values = undefined; }
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
  final(gid: number, op: string): unknown {
    switch (op) {
      case 'count': return this.counts![gid];
      case 'sum': {
        if (!this.counts![gid]) return null;
        const total = this.sums![gid] + (this.corrections ? this.corrections[gid] : 0);
        if (!Number.isFinite(total)) throw new RangeError('A sum overflowed when finalized.');
        return total;
      }
      case 'avg': {
        const n = this.counts![gid];
        if (!n) return null;
        const mean = (this.sums![gid] + (this.corrections ? this.corrections[gid] : 0)) / n;
        if (!Number.isFinite(mean)) throw new RangeError('An average overflowed when finalized.');
        return mean;
      }
      case 'min': case 'max': return this.seen![gid] ? this.values![gid] : null;
      case 'sumBigInt': return this.values![gid] ?? null;
    }
    throw new TypeError(`Unknown measure ${op}.`);
  }
  /** Test hook for the count-boundary fixture: sets a slot's count. */
  setCount(gid: number, count: number): void { this.counts![gid] = count; }
}
