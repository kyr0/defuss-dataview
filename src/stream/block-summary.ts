import { compareValues, invalidValue } from '../values.js';
import type { CapturedFilter } from '../query-internals.js';
import { hashText, mix } from './admission.js';
export const KEY_BLOCK_ROWS = 1024;
/** Scalar equality hashes respect SameValueZero; unsupported identity values fall back. */
export function scalarHash(value: unknown): number | undefined {
  if (value === null) return 0x82f63b78;
  switch (typeof value) {
    case 'undefined': return 0x9e3779b9;
    case 'boolean': return value ? 0xa24baed4 : 0x9fb21c65;
    case 'number':
      if (Number.isNaN(value)) return 0x7fc00000;
      if (Number.isSafeInteger(value)) return mix((value >>> 0) ^ Math.floor(value / 4294967296) ^ 0x12345678);
      return hashText(String(value), 0x12345678);
    case 'string': return hashText(value, 0x811c9dc5);
    case 'bigint': return hashText(String(value), 0xabcdef01);
    default: return undefined;
  }
}
export function bloomBytes(rows: number): number { return Math.max(64, 2 ** Math.ceil(Math.log2(rows * 8))) / 8; }
export function summaryBytes(rows: number): number {
  const full = Math.floor(rows / KEY_BLOCK_ROWS), tail = rows % KEY_BLOCK_ROWS;
  return full * (64 + bloomBytes(KEY_BLOCK_ROWS)) + (tail ? 64 + bloomBytes(tail) : 0);
}
export class BlockSummary {
  readonly bloom: Uint32Array;
  private readonly mask: number;
  private min: unknown;
  private max: unknown;
  private valid = false;
  constructor(rows: number) { this.bloom = new Uint32Array(bloomBytes(rows) / 4); this.mask = this.bloom.length * 32 - 1; }
  add(value: unknown): void {
    if (!invalidValue(value)) {
      if (!this.valid) { this.min = this.max = value; this.valid = true; }
      else { if (compareValues(value, this.min) < 0) this.min = value; if (compareValues(value, this.max) > 0) this.max = value; }
    }
    const hash = scalarHash(value);
    if (hash !== undefined) {
      const step = mix(hash ^ 0x85ebca6b) | 1;
      for (let i = 0; i < 3; i++) { const bit = (hash + Math.imul(i, step)) & this.mask; this.bloom[bit >>> 5] |= 1 << (bit & 31); }
    }
  }
  maybe(hash: number): boolean {
    const step = mix(hash ^ 0x85ebca6b) | 1;
    for (let i = 0; i < 3; i++) { const bit = (hash + Math.imul(i, step)) & this.mask; if (!(this.bloom[bit >>> 5] & (1 << (bit & 31)))) return false; }
    return true;
  }
  /** Range bounds use the default total preorder and exclude invalid values. */
  rangeImpossible(op: string, value: unknown): boolean {
    if (invalidValue(value) || !this.valid) return true;
    switch (op) {
      case 'gt': return compareValues(this.max, value) <= 0;
      case 'gte': return compareValues(this.max, value) < 0;
      case 'lt': return compareValues(this.min, value) >= 0;
      case 'lte': return compareValues(this.min, value) > 0;
      default: return false;
    }
  }
  /** Convenience for direct invariant tests; execution compiles this once. */
  impossible(filter: CapturedFilter, codeUnit: boolean): boolean {
    return compileBlockFilter(filter, codeUnit)?.(this) ?? false;
  }
}
/** Capture immutable scalar hashes once per execution, outside the block loop. */
export function compileBlockFilter(filter: CapturedFilter, codeUnit: boolean): ((block: BlockSummary) => boolean) | undefined {
  if (filter.op === 'in') {
    if (!filter.members) return () => true;
    const hashes: number[] = [];
    for (const value of filter.members) { const hash = scalarHash(value); if (hash === undefined) return undefined; hashes.push(hash); }
    const unique = [...new Set(hashes)];
    return block => !unique.some(hash => block.maybe(hash));
  }
  if (!['eq', 'gt', 'gte', 'lt', 'lte'].includes(filter.op)) return undefined;
  const hash = scalarHash(filter.value);
  if (hash === undefined) return undefined;
  if (filter.op === 'eq') return block => !block.maybe(hash);
  if (!codeUnit) return undefined;
  return block => block.rangeImpossible(filter.op, filter.value);
}
