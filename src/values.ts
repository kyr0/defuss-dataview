/** Comparison rules shared by array, tree and streaming execution. No coercion. */
export interface QuerySemantics {
  /** Dates compare by timestamp, binary views by visible bytes and arrays element by element. Other objects use identity. */
  equality?: 'value' | 'identity';
  /** Code-unit order is portable and matches DBSONL keys. Locale collation is explicit. */
  strings?: 'code-unit' | 'locale';
  locale?: string | string[];
  collatorOptions?: Intl.CollatorOptions;
}
export function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}
export const invalidValue = (value: unknown): boolean => value == null
  || (typeof value === 'number' && Number.isNaN(value))
  || (value instanceof Date && Number.isNaN(value.getTime()));
// A total preorder is essential for heaps and stable sorting. Opaque values tie;
// invoking arbitrary toString/valueOf would introduce side effects and cycles.
const rank = (v: unknown): number => v == null ? 9 : invalidValue(v) ? 8
  : typeof v === 'boolean' ? 0 : typeof v === 'number' ? 1 : typeof v === 'bigint' ? 2
  : typeof v === 'string' ? 3 : v instanceof Date ? 4 : (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) ? 5 : Array.isArray(v) ? 6 : 7;
const CYCLE = 'An array that contains itself cannot be compared or used as a key.';
/** Arrays being compared, outermost first: comparison is synchronous, so one stack serves every call. */
const open: unknown[] = [];
function enter(a: unknown, b: unknown): void {
  if (open.includes(a) || open.includes(b)) throw new TypeError(CYCLE);
  open.push(a, b);
}
/** A validated, frozen copy, so caller mutation cannot change a normalized view's comparisons.
 * VERIFIED: src/regressions.test.ts 'copies semantics' fails when createDataview keeps the caller's object. */
export function normalizeSemantics(options: QuerySemantics): QuerySemantics {
  createValueOperations(options);
  const copy: QuerySemantics = {};
  if (options.equality !== undefined) copy.equality = options.equality;
  if (options.strings !== undefined) copy.strings = options.strings;
  if (options.locale !== undefined) copy.locale = Array.isArray(options.locale) ? Object.freeze([...options.locale]) as string[] : options.locale;
  if (options.collatorOptions !== undefined) copy.collatorOptions = Object.freeze({ ...options.collatorOptions });
  return Object.freeze(copy);
}
export function createValueOperations(options: QuerySemantics = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('semantics must be an object.');
  if (options.equality !== undefined && !['value', 'identity'].includes(options.equality)) throw new TypeError('Invalid equality semantics.');
  if (options.strings !== undefined && !['code-unit', 'locale'].includes(options.strings)) throw new TypeError('Invalid string semantics.');
  if (options.strings !== 'locale' && (options.locale !== undefined || options.collatorOptions !== undefined)) throw new TypeError('Locale options require strings: locale.');
  const collator = options.strings === 'locale' ? new Intl.Collator(options.locale, options.collatorOptions) : undefined;
  const equality = options.equality ?? 'value';
  const comparisonId = `dataview-order-v2:${collator ? JSON.stringify(collator.resolvedOptions()) : 'code-unit'}`;
  function equal(a: unknown, b: unknown): boolean {
    if (a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))) return true;
    if (equality === 'identity') return false;
    if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime());
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && equalLists(a, b);
    const ab = bytesOf(a), bb = bytesOf(b);
    if (!ab || !bb || ab.length !== bb.length) return false;
    for (let i = 0; i < ab.length; i++) if (ab[i] !== bb[i]) return false;
    return true;
  }
  function compare(a: unknown, b: unknown): number {
    if (a === b || Object.is(a, b)) return 0;
    // Homogeneous scalar columns are common. Guard both types and NaN so the
    // heterogeneous total preorder and invalid-last semantics remain identical.
    if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) ? 1 : Number.isNaN(b) ? -1 : a < b ? -1 : 1;
    if (typeof a === 'string' && typeof b === 'string') return collator ? collator.compare(a, b) : a < b ? -1 : 1;
    if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : 1;
    const ar = rank(a), br = rank(b);
    if (ar !== br) return ar - br;
    if (ar >= 7) return 0;
    if (ar === 6) return compareLists(a as unknown[], b as unknown[]);
    if (a instanceof Date && b instanceof Date) return a.getTime() < b.getTime() ? -1 : a.getTime() > b.getTime() ? 1 : 0;
    const ab = bytesOf(a), bb = bytesOf(b);
    if (ab && bb) {
      for (let i = 0; i < Math.min(ab.length, bb.length); i++) if (ab[i] !== bb[i]) return ab[i] - bb[i];
      return ab.length - bb.length;
    }
    return (a as number | bigint | boolean) < (b as number | bigint | boolean) ? -1 : 1;
  }
  function equalLists(a: unknown[], b: unknown[]): boolean {
    enter(a, b);
    try { for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false; return true; } finally { open.length -= 2; }
  }
  /** Element by element in this order; a proper prefix sorts first. */
  function compareLists(a: unknown[], b: unknown[]): number {
    enter(a, b);
    try {
      for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) { const c = compare(a[i], b[i]); if (c) return c; }
      return Math.sign(a.length - b.length);
    } finally { open.length -= 2; }
  }
  return { equal, compare, comparisonId, equality };
}
/** Default deterministic value ordering. */
export const compareValues = createValueOperations().compare;

/** Binary bytes as a string key, one char per byte, so equal bytes give equal keys and nothing else does. */
export function latin1(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
}
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
/**
 * The key of a value-mode array: equal arrays give equal strings and unequal ones never do. Every element ends in a
 * comma and strings and bytes carry their length, so no element can run into the next. Elements follow the equality of
 * group keys: SameValueZero, Dates by timestamp, binary by visible bytes, arrays recursively, other objects by
 * identity (a number per object, held weakly).
 * VERIFIED: src/compute/lists.test.ts groups, deduplicates and merges arrays that are equal but never identical.
 */
export function listKey(list: readonly unknown[]): string {
  const seen: unknown[] = [];
  let out = '';
  const add = (v: unknown): void => {
    switch (typeof v) {
      case 'undefined': out += 'u,'; return;
      case 'boolean': out += v ? 't,' : 'f,'; return;
      case 'number': out += v !== v ? 'N,' : v === 0 ? 'n0,' : `n${v},`; return;
      case 'bigint': out += `b${v},`; return;
      case 'string': out += `s${v.length}:${v},`; return;
      case 'object': {
        if (v === null) { out += 'z,'; return; }
        if (v instanceof Date) { out += `d${v.getTime()},`; return; }
        const bytes = bytesOf(v);
        if (bytes) { out += `x${bytes.length}:${latin1(bytes)},`; return; }
        if (Array.isArray(v)) {
          if (seen.includes(v)) throw new TypeError(CYCLE);
          seen.push(v); out += `[${v.length}:`;
          for (let i = 0; i < v.length; i++) add(v[i]);
          out += '],'; seen.pop(); return;
        }
        let id = identities.get(v);
        if (id === undefined) { id = nextIdentity++; identities.set(v, id); }
        out += `o${id},`; return;
      }
      default: throw new TypeError(`Functions and symbols cannot be group keys or distinct values; got ${typeof v}.`);
    }
  };
  add(list);
  return out;
}
/**
 * Whether a structured clone keeps a key's equality: primitives, and in value mode Dates, binary values and arrays of
 * such values. Objects that compare by identity lose it in any copy.
 */
export function cloneKeepsEquality(value: unknown, byValue: boolean): boolean {
  const type = typeof value;
  if (type === 'function' || type === 'symbol') return false;
  if (type !== 'object' || value === null) return true;
  if (!byValue) return false;
  if (value instanceof Date || bytesOf(value)) return true;
  return Array.isArray(value) && listCopyable(value, []);
}
function listCopyable(list: readonly unknown[], seen: unknown[]): boolean {
  if (seen.includes(list)) return false;
  seen.push(list);
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (Array.isArray(v) ? !listCopyable(v, seen) : !cloneKeepsEquality(v, true)) return false;
  }
  seen.pop();
  return true;
}
/**
 * A value-mode operand that caller mutation cannot change: Dates and binary values copied (binary as a Uint8Array of
 * its visible bytes), arrays copied element by element. Other objects keep identity; identity mode copies nothing.
 */
export function snapshot(value: unknown, byValue: boolean, seen: unknown[] = []): unknown {
  if (!byValue || typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return new Date(value.getTime());
  const bytes = bytesOf(value);
  if (bytes) return bytes.slice();
  if (!Array.isArray(value)) return value;
  if (seen.includes(value)) throw new TypeError(CYCLE);
  seen.push(value);
  const copy = value.map(v => snapshot(v, true, seen));
  seen.pop();
  return copy;
}
