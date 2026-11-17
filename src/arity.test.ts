import { describe, it, expect } from 'vitest';
import { compileAccessor } from './fields.js';
import { compileQuery } from './query.js';

describe('small arity query specialization', () => {
  it('preserves left-to-right filter and comparator short circuits at arities 0..6', () => {
    for (let n = 0; n <= 6; n++) for (let stop = 0; stop <= n; stop++) {
      const reads: string[] = [], a = {}, b = {};
      for (let i = 0; i < n; i++) {
        Object.defineProperty(a, 'k'+i, { get() { reads.push('a'+i); return i === stop ? 0 : 1; } });
        Object.defineProperty(b, 'k'+i, { get() { reads.push('b'+i); return 1; } });
      }
      const query = compileQuery({ filters: Array.from({length:n},(_,i)=>({field:'k'+i,op:'eq',value:1})), sorters: Array.from({length:n},(_,i)=>({field:'k'+i})) });
      expect(query.matches(a)).toBe(stop === n);
      expect(reads).toEqual(Array.from({length:Math.min(n,stop+1)},(_,i)=>'a'+i));
      reads.length=0;
      expect(query.compare(a,b)).toBe(stop === n ? 0 : -1);
      expect(reads).toEqual(Array.from({length:Math.min(n,stop+1)},(_,i)=>['a'+i,'b'+i]).flat());
    }
  });
  it('preserves own-only traversal, arrays, null/function guards and getters at depths 1..6', () => {
    for (let depth=1;depth<=6;depth++) {
      const path=Array(depth).fill('k').join('.'), get=compileAccessor(path);
      let row: unknown=7;
      for(let i=0;i<depth;i++)row={k:row};
      expect(get(row)).toBe(7);
      expect(get(null)).toBeUndefined(); expect(get(undefined)).toBeUndefined();
      expect(get(Object.create(row as object))).toBeUndefined();
      for(const end of [null, undefined, 4, 's', ()=>7]) {
        let value: unknown=end;
        for(let i=1;i<depth;i++)value={k:value};
        expect(get(value)).toBeUndefined();
      }
      let calls=0; let target: unknown=7;
      for(let i=0;i<depth;i++){const captured=target;target={get k(){calls++;return captured;}};}
      expect(get(target)).toBe(7); expect(calls).toBe(depth);
    }
    expect(compileAccessor('a.0.b')({a:[{b:3}]})).toBe(3);
    for(const path of ['a.__proto__.b','a.constructor.b','a..b'])expect(()=>compileAccessor(path)).toThrow();
  });
});
