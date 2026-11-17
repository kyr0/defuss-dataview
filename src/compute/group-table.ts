import { DataviewError } from '../stream/common.js';
import { bytesOf } from '../values.js';
import { retainedBytes } from './aggregate.js';
import type { Ledger } from './aggregate.js';

/**
 * Exact grouping on native Maps: a trie with one level per key component, each level split into maps per key family.
 * SameValueZero on primitives already gives the documented equality (NaNs together, +0 with -0, null apart from
 * undefined, 1 apart from 1n and '1'). Value-mode Dates key on their timestamp and binary values on their visible
 * bytes, each in its own map, so a Date never meets a number and bytes never meet a string. Other objects key on
 * identity. No delimiter concatenation or JSON tuple can merge distinct typed tuples.
 * HYPOTHESIS: a custom open-addressed table beats Map only for some single numeric keys; falsifier: scripts/benchmark-compute.mjs
 * (documentation/COMPUTE_PERFORMANCE.md records the measurement and the decision).
 */
interface Level { p?: Map<unknown, Level | number>; d?: Map<number, Level | number>; b?: Map<string, Level | number>; o?: Map<object, Level | number> }
// Rough per-entry cost of a Map slot plus its key, charged so the cap tracks table growth.
const ENTRY_BYTES = 48;
export const MAX_GROUP_ID = 2 ** 32 - 2;

export class GroupTable {
  private readonly root: Level = {};
  size = 0;
  /** Representative key values per component, in first-encounter order (group id order). */
  readonly keys: unknown[][];
  constructor(private readonly width: number, private readonly byValue: boolean, private readonly ledger: Ledger, private readonly maxGroups: number) {
    this.keys = Array.from({ length: width }, () => []);
  }
  /** The group id of this tuple, creating it at the next id when new. `values` is caller scratch and is not kept. */
  find(values: readonly unknown[]): number {
    let level = this.root;
    for (let i = 0; i < this.width; i++) {
      const value = values[i];
      // Primitive keys (the common case) go straight to the primitive map; other kinds resolve through slot().
      let map: Map<unknown, Level | number>, key: unknown;
      if (value === null || (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'symbol')) { map = level.p ??= new Map(); key = value; }
      else { map = this.slot(level, value); key = this.key; }
      const hit = map.get(key);
      if (i === this.width - 1) {
        if (hit !== undefined) return hit as number;
        return this.create(map, key, values);
      }
      if (hit !== undefined) { level = hit as Level; continue; }
      this.ledger.reserve(ENTRY_BYTES);
      const next: Level = {};
      map.set(key, next);
      level = next;
    }
    throw new Error('unreachable');
  }
  private create(map: Map<unknown, Level | number>, key: unknown, values: readonly unknown[]): number {
    if (this.size >= this.maxGroups) throw new DataviewError('LIMIT_EXCEEDED', `Grouping would exceed maxGroups (${this.maxGroups}).`);
    const gid = this.size;
    let bytes = ENTRY_BYTES;
    const kept = values.map(value => { const own = this.own(value); bytes += retainedBytes(own); return own; });
    this.ledger.reserve(bytes);
    map.set(key, gid);
    for (let i = 0; i < this.width; i++) this.keys[i].push(kept[i]);
    this.size++;
    return gid;
  }
  /** Value-mode binary keys keep a private copy of their visible bytes, not the caller's possibly huge backing store. */
  private own(value: unknown): unknown {
    if (!this.byValue) return value;
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      return (value as unknown as { slice(): unknown }).slice();
    }
    return value;
  }
  /** The map key resolved by the last slot() call; a field instead of a returned pair, so lookups allocate nothing. */
  private key: unknown;
  private slot(level: Level, value: unknown): Map<unknown, Level | number> {
    const type = typeof value;
    if (type === 'function' || type === 'symbol') throw new TypeError(`Functions and symbols cannot be group keys; got ${type}.`);
    this.key = value;
    if (type !== 'object' || value === null) return level.p ??= new Map();
    if (this.byValue) {
      if (value instanceof Date) { this.key = value.getTime(); return (level.d ??= new Map()) as Map<unknown, Level | number>; }
      const bytes = bytesOf(value);
      if (bytes) { this.key = latin1(bytes); return (level.b ??= new Map()) as Map<unknown, Level | number>; }
    }
    return (level.o ??= new Map()) as Map<unknown, Level | number>;
  }
}
function latin1(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
}
