import { compileAccessor } from '../fields.js';
import { createValueOperations } from '../values.js';
import type { QueryDescriptor, QueryOrdering } from '../query.js';

/** Build-scoped columns: caller explicitly guarantees pure, stable accessors. */
export function keySorter<T extends object>(descriptor: QueryDescriptor, ordering: QueryOrdering) {
  const compare = createValueOperations(descriptor.semantics).compare;
  const fields = ordering.sorters.map(s => ({ get: compileAccessor(s.field), sign: s.direction === 'desc' ? -1 : 1 }));
  return {
    // Key slots (8 each), uint32 permutation (4), reordered row references (8).
    // Fixed accounting includes column headers. VM/native sort scratch is separate.
    bytes(count: number): number { return count ? count * (12 + fields.length * 8) + 64 + fields.length * 32 : 0; },
    sort(rows: readonly T[]): T[] {
      const columns = fields.map(f => rows.map(row => f.get(row)));
      const order = new Uint32Array(rows.length);
      for (let i = 0; i < order.length; i++) order[i] = i;
      const one = fields.length === 1, sign = fields[0]?.sign ?? 1;
      // The common one-column case needs no field loop or dynamic sign lookup.
      order.sort(one ? (a, b) => compare(columns[0][a], columns[0][b]) * sign || a - b : (a, b) => {
        for (let i = 0; i < fields.length; i++) {
          const result = compare(columns[i][a], columns[i][b]);
          if (result) return result * fields[i].sign;
        }
        return a - b;
      });
      // Keep input references intact until permutation completes; writing into
      // rows in place would overwrite references needed by later positions.
      return Array.from(order, i => rows[i]);
    },
  };
}
