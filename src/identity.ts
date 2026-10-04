import type { DataviewJsonValue } from './types.js';

/** Canonical JSON identity: object-key order does not affect matching. */
export function idKey(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  const active = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null) throw new TypeError('Dataview identifiers must be finite JSON values.');
    if (active.has(item)) throw new TypeError('Dataview identifiers cannot contain cycles.');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Dataview identifiers require plain JSON objects.');
    }
    const ownKeys = Reflect.ownKeys(item);
    if (array && ownKeys.length !== item.length + 1) throw new TypeError('Sparse or extended arrays are not JSON identifiers.');
    const values = new Map<string, unknown>();
    for (const key of ownKeys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Invalid JSON identifier property.');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw new TypeError('Invalid JSON identifier array index.');
      values.set(key, descriptor.value);
    }
    active.add(item);
    try {
      if (array) return '[' + Array.from({ length: item.length }, (_, index) => encode(values.get(String(index)))).join(',') + ']';
      return '{' + [...values.keys()].sort().map(key => JSON.stringify(key) + ':' + encode(values.get(key))).join(',') + '}';
    } finally { active.delete(item); }
  }
  return encode(value);
}

export function uniqueIds(values: readonly unknown[]): DataviewJsonValue[] {
  const seen = new Set<string>();
  const result: DataviewJsonValue[] = [];
  for (const value of values) {
    const key = idKey(value);
    if (!seen.has(key)) { seen.add(key); result.push(JSON.parse(key) as DataviewJsonValue); }
  }
  return result;
}
export const rowIdKey = (value: unknown): string | undefined => value == null ? undefined : idKey(value);
/** VERIFIED: selected IDs are validated JSON, so a row ID without a JSON key can never be selected. */
export function selectionKey(value: unknown): string | undefined {
  try { return rowIdKey(value); } catch (error) { if (error instanceof TypeError) return undefined; throw error; }
}
export const sameIds = (left: readonly DataviewJsonValue[], right: readonly DataviewJsonValue[]): boolean =>
  left.length === right.length && left.every((value, index) => idKey(value) === idKey(right[index]));
