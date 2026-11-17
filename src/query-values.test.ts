import { describe, expect, it } from 'vitest';
import { compareValues, compileQuery, createValueOperations, orderingSatisfies } from './query.js';

describe('value semantics', () => {
  it('orders bigint numerically and code units deterministically', () => {
    expect([100n, 2n, -10n].sort(compareValues)).toEqual([-10n, 2n, 100n]);
    expect(['a', 'Z', 'ä'].sort(compareValues)).toEqual(['Z', 'a', 'ä']);
  });
  it('compares visible binary contents and Date values, with opt-in identity equality', () => {
    const a = new Uint8Array([0, 4, 9]).subarray(1), b = new DataView(new Uint8Array([4, 9]).buffer);
    const equal = createValueOperations().equal;
    expect(equal(a, b)).toBe(true); expect(equal(new Date(42), new Date(42))).toBe(true);
    expect(equal(new Date(NaN), new Date(NaN))).toBe(true);
    expect(createValueOperations({ equality: 'identity' }).equal(a, b)).toBe(false);
    expect(equal({}, {})).toBe(false); expect(equal(null, undefined)).toBe(false);
    expect(equal(-0, 0)).toBe(true); expect(equal(NaN, NaN)).toBe(true);
  });
  it('snapshots typed query operands and membership lists', () => {
    const bytes = new Uint8Array([1, 2]), date = new Date(12), values = [1, 2];
    const a = compileQuery({ filters: [{ field: 'v', op: 'eq', value: bytes }] });
    const b = compileQuery({ filters: [{ field: 'v', op: 'eq', value: date }] });
    const c = compileQuery({ filters: [{ field: 'v', op: 'in', value: values }] });
    bytes[0] = 9; date.setTime(99); values.push(3);
    expect(a.matches({ v: new Uint8Array([1, 2]) })).toBe(true);
    expect(b.matches({ v: new Date(12) })).toBe(true); expect(c.matches({ v: 3 })).toBe(false);
  });
  it('has antisymmetric and transitive comparison including invalid and opaque values', () => {
    const values: unknown[] = [false, true, -Infinity, -2, 0, Infinity, 2n, 100n, 'Z', 'a', new Date(3), new Uint8Array([1]), new Uint8Array([1, 2]), {}, [], Symbol('a'), NaN, new Date(NaN), null, undefined];
    for (const a of values) for (const b of values) {
      expect(Math.sign(compareValues(a, b)) + Math.sign(compareValues(b, a))).toBe(0);
      for (const c of values) if (compareValues(a, b) <= 0 && compareValues(b, c) <= 0) expect(compareValues(a, c)).toBeLessThanOrEqual(0);
    }
  });
  it('keeps own-property lookup and invalid-range exclusion', () => {
    expect(compileQuery({ filters: [{ field: 'x', op: 'eq', value: 3 }] }).matches(Object.create({ x: 3 }))).toBe(false);
    for (const v of [null, undefined, NaN, new Date(NaN)]) expect(compileQuery({ filters: [{ field: 'x', op: 'gte', value: 0 }] }).matches({ x: v })).toBe(false);
    expect(() => compileQuery({ filters: [{ field: '__proto__.x', op: 'eq', value: 1 }] })).toThrow();
  });
  it('validates ordering equivalence and query arguments', () => {
    const a = compileQuery({ sorters: [{ field: 'x' }] }).ordering;
    expect(orderingSatisfies(a, a)).toBe(true);
    expect(orderingSatisfies(a, compileQuery({ sorters: [{ field: 'x', direction: 'desc' }] }).ordering)).toBe(false);
    expect(() => compileQuery({ semantics: { locale: 'en' } })).toThrow();
    expect(() => createValueOperations({ equality: 'wrong' as 'value' })).toThrow();
    expect(() => createValueOperations({ strings: 'wrong' as 'locale' })).toThrow();
    expect(() => compileQuery({ filters: [{ field: 'x', op: 'oops' as 'eq', value: 1 }] })).toThrow();
  });
});
