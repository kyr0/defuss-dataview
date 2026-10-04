import type { DataviewRow } from './types.js';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function fieldParts(field: string): string[] {
  if (typeof field !== 'string' || !field) throw new TypeError('Dataview field must be a non-empty dot path.');
  const parts = field.split('.');
  if (parts.some(part => !part || forbidden.has(part))) throw new TypeError(`Invalid or unsafe Dataview field: ${field}`);
  return parts;
}
export function compileAccessor(field: string): (row: unknown) => unknown {
  const parts = fieldParts(field);
  if (parts.length === 1) return row => typeof row === 'object' && row !== null && Object.hasOwn(row, field)
    ? (row as Record<string, unknown>)[field] : undefined;
  return row => {
    let current = row;
    for (const part of parts) {
      if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  };
}

/** Copy just the ancestors of a dot path; do not mutate nested row data. */
export function setField<T extends DataviewRow>(row: T, field: string, value: unknown): T {
  const parts = fieldParts(field);
  const ancestors: Array<Record<string, unknown> | unknown[]> = [];
  let current: unknown = row;
  for (const part of parts) {
    if (current === undefined || current === null) current = /^(0|[1-9]\d*)$/.test(part) ? [] : {};
    // VERIFIED: the row itself may be a class instance: it is spread like updateRows does; nested containers must be plain.
    if (typeof current !== 'object' || (current !== row && !Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null)) {
      throw new TypeError('Parent paths require plain objects or arrays.');
    }
    if (Array.isArray(current) && (!/^(0|[1-9]\d*)$/.test(part) || Number(part) > 4294967294)) throw new TypeError('Array paths require valid nonnegative indices.');
    const container = current as Record<string, unknown>;
    ancestors.push(container);
    current = Object.hasOwn(container, part) ? container[part] : undefined;
  }
  if (Object.is(current, value)) return row;
  let next = value;
  for (let index = parts.length - 1; index >= 0; index--) {
    const original = ancestors[index];
    const copy = Array.isArray(original) ? original.slice() : { ...original };
    Object.defineProperty(copy, parts[index], { value: next, enumerable: true, configurable: true, writable: true });
    next = copy;
  }
  return next as T;
}
