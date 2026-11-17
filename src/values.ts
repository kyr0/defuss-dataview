/** Comparison rules shared by array, tree and streaming execution. No coercion. */
export interface QuerySemantics {
  /** Dates compare by timestamp and binary views by visible bytes. Other objects use identity. */
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
const rank = (v: unknown): number => v == null ? 8 : invalidValue(v) ? 7
  : typeof v === 'boolean' ? 0 : typeof v === 'number' ? 1 : typeof v === 'bigint' ? 2
  : typeof v === 'string' ? 3 : v instanceof Date ? 4 : (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) ? 5 : 6;
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
  const comparisonId = `dataview-order-v1:${collator ? JSON.stringify(collator.resolvedOptions()) : 'code-unit'}`;
  function equal(a: unknown, b: unknown): boolean {
    if (a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))) return true;
    if (equality === 'identity') return false;
    if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime());
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
    if (ar >= 6) return 0;
    if (a instanceof Date && b instanceof Date) return a.getTime() < b.getTime() ? -1 : a.getTime() > b.getTime() ? 1 : 0;
    const ab = bytesOf(a), bb = bytesOf(b);
    if (ab && bb) {
      for (let i = 0; i < Math.min(ab.length, bb.length); i++) if (ab[i] !== bb[i]) return ab[i] - bb[i];
      return ab.length - bb.length;
    }
    return (a as number | bigint | boolean) < (b as number | bigint | boolean) ? -1 : 1;
  }
  return { equal, compare, comparisonId, equality };
}
/** Default deterministic value ordering. */
export const compareValues = createValueOperations().compare;
