import { compileAccessor } from './fields.js';
import type { DataviewFilter, DataviewRow, DataviewState } from './types.js';

const invalid = (value: unknown) => value == null || (typeof value === 'number' && Number.isNaN(value)) || (value instanceof Date && Number.isNaN(value.getTime()));
// Type ranks avoid the inconsistent numeric/string equivalence of pairwise coercion.
const rank = (value: unknown): number => value == null ? 7
  : invalid(value) ? 6 : typeof value === 'boolean' ? 0 : typeof value === 'number' ? 1
  : typeof value === 'bigint' ? 2 : typeof value === 'string' ? 3 : value instanceof Date ? 4 : 5;
export function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right) || left === right) return 0;
  if (typeof left === 'number' && typeof right === 'number') {
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return left ? 1 : -1;
  const a = rank(left), b = rank(right);
  if (a !== b) return a - b;
  if (a >= 6) return 0;
  if (left instanceof Date && right instanceof Date) return Math.sign(left.getTime() - right.getTime());
  // Preserve upstream string collation and lexical BigInt fallback.
  return String(left).localeCompare(String(right));
}
function testFilter(cell: unknown, filter: DataviewFilter): boolean {
  const { op, value } = filter;
  switch (op) {
    case 'eq': return cell === value;
    case 'neq': return cell !== value;
    case 'gt': return !invalid(cell) && !invalid(value) && compareValues(cell, value) > 0;
    case 'gte': return !invalid(cell) && !invalid(value) && compareValues(cell, value) >= 0;
    case 'lt': return !invalid(cell) && !invalid(value) && compareValues(cell, value) < 0;
    case 'lte': return !invalid(cell) && !invalid(value) && compareValues(cell, value) <= 0;
    case 'in': return Array.isArray(value) && value.some(item => item === cell);
    case 'contains': return typeof cell === 'string' && typeof value === 'string' ? cell.includes(value)
      : Array.isArray(cell) && cell.some(item => item === value);
    case 'startsWith': return typeof cell === 'string' && typeof value === 'string' && cell.startsWith(value);
    case 'endsWith': return typeof cell === 'string' && typeof value === 'string' && cell.endsWith(value);
    default: return false;
  }
}
export function compileQuery(view: DataviewState) {
  const filters = view.filters.map(filter => {
    const get = compileAccessor(filter.field);
    if (filter.op === 'in' && Array.isArray(filter.value) && filter.value.length > 16) {
      const values = new Set<unknown>(filter.value);
      // Set uses SameValueZero; preserve strict equality even for unsafe NaN values.
      return (row: DataviewRow) => { const value = get(row); return !Number.isNaN(value) && values.has(value); };
    }
    return (row: DataviewRow) => testFilter(get(row), filter);
  });
  const sorters = view.sorters.map(sorter => ({ get: compileAccessor(sorter.field), sign: sorter.direction === 'desc' ? -1 : 1 }));
  return {
    matches: (row: DataviewRow) => {
      for (const filter of filters) if (!filter(row)) return false;
      return true;
    },
    compare: (left: DataviewRow, right: DataviewRow) => {
      for (const sorter of sorters) {
        const result = compareValues(sorter.get(left), sorter.get(right));
        if (result !== 0) return result * sorter.sign;
      }
      return 0;
    },
  };
}
