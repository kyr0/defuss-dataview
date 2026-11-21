// Independent reference semantics for defuss-dataview/compute (plan P0). Deliberately naive: a recursive evaluator
// over the raw expression nodes, linear-search grouping on value equality, plain loops for every measure. It shares
// no interning, memoization, hashing, state columns or strategy code with src/compute, so a production shortcut that
// changes results disagrees with it. Legacy filters and value operations are the existing, separately tested contract.
import { compileQuery, createValueOperations } from '../../src/query.js';
import { bytesOf, invalidValue } from '../../src/values.js';
import type { DataviewFilter } from '../../src/types.js';

type Node = { v: 1; op: string; key?: string; path?: string; value?: unknown; args?: Node[]; arg?: Node; where?: Node; unit?: string; part?: string; timeZone?: string; start?: number; length?: number; p?: number };
type Descriptor = Record<string, any>;
export type OracleResult = { rows: Record<string, unknown>[]; totals?: Record<string, unknown>; total: number; matches: number };

/**
 * The correctly rounded sum, from exact BigInt arithmetic: every finite double is an integer multiple of 2^-1074, so
 * the scaled sum is exact, and one rounding with guard and sticky bits gives the nearest double, ties to even.
 * It shares nothing with the expansion-based sum in src/compute/aggregate.ts.
 */
export function exactSum(values: readonly number[]): number {
  let scaled = 0n;
  for (const x of values) {
    let m = Math.abs(x), e = 0;
    while (!Number.isInteger(m)) { m *= 2; e++; }
    scaled += (x < 0 ? -1n : 1n) * (BigInt(m) << BigInt(1074 - e));
  }
  if (scaled === 0n) return values.length && values.every(x => Object.is(x, -0)) ? -0 : 0;
  const sign = scaled < 0n ? -1 : 1, a = scaled < 0n ? -scaled : scaled, bits = a.toString(2).length;
  if (bits <= 53) return sign * Number(a) * 2 ** -1074;
  const shift = bits - 55;
  let kept = a >> BigInt(shift);
  if (a & ((1n << BigInt(shift)) - 1n)) kept |= 1n;
  const result = sign * Number(kept) * 2 ** (shift - 1074);
  if (!Number.isFinite(result)) throw new RangeError('overflow');
  return result;
}

function own(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}
export function oracle(kind: 'rows' | 'aggregate' | 'view', d: Descriptor, input: readonly object[], page: { offset?: number; limit?: number } = {}): OracleResult {
  const ops = createValueOperations(d.semantics ?? {});
  const skip = d.invalidNumbers === 'skip', compensated = d.numberMode === undefined || d.numberMode === 'compensated', exact = d.numberMode === 'exact';
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (skip) return null;
    throw new TypeError('invalid number');
  };
  const bool = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new TypeError('not boolean'); return value; };
  const str = (value: unknown): string | null => { if (value == null) return null; if (typeof value !== 'string') throw new TypeError('not a string'); return value; };
  // UTC calendar arithmetic through ISO strings; time zones are checked against Temporal in src/compute/dates.test.ts.
  const when = (value: unknown): Date | null => {
    if (value == null) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number' && Math.abs(value) <= 8.64e15) return new Date(value);
    if (skip) return null;
    throw new TypeError('not a date');
  };
  const trunc = (d: Date, unit: string): Date => {
    const iso = d.toISOString(), month = Number(iso.slice(5, 7));
    if (unit === 'minute') return new Date(`${iso.slice(0, 16)}:00Z`);
    if (unit === 'hour') return new Date(`${iso.slice(0, 13)}:00:00Z`);
    if (unit === 'day') return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    if (unit === 'week') return new Date(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
    if (unit === 'month') return new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
    if (unit === 'quarter') return new Date(`${iso.slice(0, 5)}${String(month - (month - 1) % 3).padStart(2, '0')}-01T00:00:00Z`);
    return new Date(`${iso.slice(0, 4)}-01-01T00:00:00Z`);
  };
  const datePart = (d: Date, part: string): number => {
    const iso = d.toISOString(), month = Number(iso.slice(5, 7));
    return part === 'year' ? Number(iso.slice(0, 4)) : part === 'quarter' ? Math.ceil(month / 3) : part === 'month' ? month : part === 'day' ? Number(iso.slice(8, 10))
      : part === 'weekday' ? (d.getUTCDay() || 7) : part === 'hour' ? Number(iso.slice(11, 13)) : Number(iso.slice(14, 16));
  };
  const copy = (value: unknown) => {
    if (ops.equality !== 'value') return value;
    if (value instanceof Date) return new Date(value.getTime());
    const bytes = bytesOf(value); return bytes ? bytes.slice() : value;
  };
  const evaluate = (node: Node, row: object): unknown => {
    const arg = (i: number) => evaluate(node.args![i], row);
    switch (node.op) {
      case 'field': return own(row, node.key!);
      case 'path': return node.path!.split('.').reduce<unknown>((value, part) => own(value, part), row);
      case 'literal': return copy(node.value);
      case 'number': return num(arg(0));
      case 'add': case 'sub': case 'mul': case 'div': {
        const l = num(arg(0)); if (l === null) return null;
        const r = num(arg(1)); if (r === null) return null;
        if (node.op === 'div' && r === 0) throw new RangeError('div by zero');
        const result = node.op === 'add' ? l + r : node.op === 'sub' ? l - r : node.op === 'mul' ? l * r : l / r;
        if (!Number.isFinite(result)) throw new RangeError('overflow');
        return result;
      }
      case 'coalesce': { let value: unknown; for (const child of node.args!) { value = evaluate(child, row); if (value != null) return value; } return value; }
      case 'eq': return ops.equal(arg(0), arg(1));
      case 'neq': return !ops.equal(arg(0), arg(1));
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const l = arg(0), r = arg(1);
        if (invalidValue(l) || invalidValue(r)) return false;
        const c = ops.compare(l, r);
        return node.op === 'gt' ? c > 0 : node.op === 'gte' ? c >= 0 : node.op === 'lt' ? c < 0 : c <= 0;
      }
      case 'isNullish': return arg(0) == null;
      case 'and': for (const child of node.args!) if (!bool(evaluate(child, row))) return false; return true;
      case 'or': for (const child of node.args!) if (bool(evaluate(child, row))) return true; return false;
      case 'not': return !bool(arg(0));
      case 'cond': return bool(arg(0)) ? arg(1) : arg(2);
      case 'floor': case 'ceil': case 'round': case 'abs': {
        const x = num(arg(0)); if (x === null) return null;
        if (node.op === 'round') { const a = Math.abs(x), f = Math.floor(a), r = a - f >= 0.5 ? f + 1 : f; return x < 0 || Object.is(x, -0) ? -r : r; }
        return node.op === 'floor' ? Math.floor(x) : node.op === 'ceil' ? Math.ceil(x) : Math.abs(x);
      }
      case 'dateTrunc': case 'datePart': {
        if (node.timeZone !== undefined && node.timeZone !== 'UTC') throw new TypeError('oracle: UTC only');
        const d = when(arg(0)); if (d === null) return null;
        return node.op === 'dateTrunc' ? trunc(d, node.unit!) : datePart(d, node.part!);
      }
      case 'lower': return str(arg(0))?.toLowerCase() ?? null;
      case 'upper': return str(arg(0))?.toUpperCase() ?? null;
      case 'trim': return str(arg(0))?.trim() ?? null;
      case 'substring': { const s = str(arg(0)); if (s === null) return null; const points = [...s]; return points.slice(node.start!, node.length === undefined ? undefined : node.start! + node.length).join(''); }
      case 'concat': { const parts = []; for (const child of node.args!) { const s = str(evaluate(child, row)); if (s === null) return null; parts.push(s); } return parts.join(''); }
      case 'length': { const value = arg(0); if (value == null) return null; if (Array.isArray(value)) return value.length; if (typeof value !== 'string') throw new TypeError('no length'); return [...value].length; }
    }
    throw new TypeError(`oracle: unknown op ${node.op}`);
  };
  const filters = d.filters ? compileQuery({ filters: d.filters as DataviewFilter[], semantics: d.semantics }) : undefined;
  const matching: Array<{ row: object; ordinal: number }> = [];
  input.forEach((row, ordinal) => {
    if (filters && !filters.matches(row)) return;
    if (d.where && !bool(evaluate(d.where, row))) return;
    matching.push({ row, ordinal });
  });
  const measure = (m: Node, rows: object[]): unknown => {
    const accepted = rows.filter(row => !m.where || bool(evaluate(m.where, row)));
    if (m.op === 'count') {
      return m.arg === undefined ? accepted.length : accepted.filter(row => evaluate(m.arg!, row) != null).length;
    }
    if (m.op === 'sum' || m.op === 'avg') {
      let sum = 0, correction = 0, n = 0;
      const xs: number[] = [];
      for (const row of accepted) {
        const x = num(evaluate(m.arg!, row)); if (x === null) continue;
        if (exact) { xs.push(x); n++; continue; }
        const t = sum + x;
        if (!Number.isFinite(t)) throw new RangeError('overflow');
        if (compensated) correction += Math.abs(sum) >= Math.abs(x) ? (sum - t) + x : (x - t) + sum;
        sum = t; n++;
      }
      if (!n) return null;
      const total = exact ? exactSum(xs) : compensated ? sum + correction : sum;
      return m.op === 'sum' ? total : total / n;
    }
    if (m.op === 'min' || m.op === 'max') {
      let best: unknown, seen = false;
      for (const row of accepted) {
        const value = evaluate(m.arg!, row);
        if (invalidValue(value)) continue;
        if (!seen || (m.op === 'min' ? ops.compare(value, best) < 0 : ops.compare(value, best) > 0)) { best = value; seen = true; }
      }
      return seen ? best : null;
    }
    if (m.op === 'countDistinct' || m.op === 'distinct') {
      const seen: unknown[] = [];
      for (const row of accepted) {
        const value = evaluate(m.arg!, row);
        if (value == null) continue;
        if (!seen.some(other => ops.equal(other, value))) seen.push(copy(value));
      }
      return m.op === 'countDistinct' ? seen.length : seen;
    }
    if (m.op === 'percentile' || m.op === 'median') {
      const xs: number[] = [];
      for (const row of accepted) { const x = num(evaluate(m.arg!, row)); if (x !== null) xs.push(Object.is(x, -0) ? 0 : x); }
      if (!xs.length) return null;
      xs.sort((a, b) => a - b);
      const rank = (xs.length - 1) * (m.op === 'median' ? 0.5 : m.p!), below = Math.floor(rank), above = Math.ceil(rank);
      return xs[below] + (rank - below) * (xs[above] - xs[below]);
    }
    if (m.op === 'sumBigInt') {
      let total: bigint | null = null;
      for (const row of accepted) {
        const value = evaluate(m.arg!, row);
        if (value == null) continue;
        if (typeof value !== 'bigint') { if (skip) continue; throw new TypeError('not bigint'); }
        total = (total ?? 0n) + value;
      }
      return total;
    }
    throw new TypeError(`oracle: unknown measure ${m.op}`);
  };
  const offset = page.offset ?? 0, end = page.limit === undefined ? Infinity : offset + page.limit;
  const sortBy = <E extends { keys: unknown[]; ordinal: number }>(entries: E[], signs: number[]) => entries.sort((a, b) => {
    for (let i = 0; i < signs.length; i++) { const c = ops.compare(a.keys[i], b.keys[i]); if (c) return c * signs[i]; }
    return a.ordinal - b.ordinal;
  });
  if (kind === 'rows' || kind === 'view') {
    const order: Array<{ expr: Node; direction?: string }> = d.orderBy ?? [];
    const sorted = sortBy(matching.map(m => ({ ...m, keys: order.map(o => evaluate(o.expr, m.row)) })), order.map(o => o.direction === 'desc' ? -1 : 1));
    const rows = sorted.slice(offset, end).map(({ row }) => Object.fromEntries(Object.entries(d.select as Record<string, Node>).map(([alias, node]) => [alias, evaluate(node, row)])));
    const totals = kind === 'view' ? Object.fromEntries(Object.entries(d.totals as Record<string, Node>).map(([alias, m]) => [alias, measure(m, matching.map(x => x.row))])) : undefined;
    return { rows, totals, total: matching.length, matches: matching.length };
  }
  const keys = Object.entries((d.groupBy ?? {}) as Record<string, Node>);
  const groups: Array<{ key: unknown[]; rows: object[]; ordinal: number }> = [];
  if (!keys.length) groups.push({ key: [], rows: matching.map(m => m.row), ordinal: 0 });
  else for (const { row, ordinal } of matching) {
    // each(): every combination of the distinct elements (first occurrences) of the unwound arrays.
    let tuples: unknown[][] = [[]];
    for (const [, node] of keys) {
      const value = evaluate(node.op === 'each' ? node.args![0] : node, row);
      const options = node.op === 'each' && Array.isArray(value) ? value.filter((x, i) => value.findIndex(y => ops.equal(x, y)) === i) : [value];
      tuples = tuples.flatMap(t => options.map(v => [...t, v]));
    }
    for (const key of tuples) {
      for (const value of key) if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('bad key');
      const group = groups.find(g => g.key.every((value, i) => ops.equal(value, key[i])));
      if (group) group.rows.push(row); else groups.push({ key, rows: [row], ordinal });
    }
  }
  const outputs = groups.map((g, i) => ({
    ordinal: i,
    row: Object.fromEntries([...keys.map(([alias], k) => [alias, g.key[k]]), ...Object.entries(d.measures as Record<string, Node>).map(([alias, m]) => [alias, measure(m, g.rows)])]) as Record<string, unknown>,
  }));
  const having = d.having ? compileQuery({ filters: d.having as DataviewFilter[], semantics: d.semantics }) : undefined;
  const passing = outputs.filter(o => !having || having.matches(o.row));
  const order: Array<{ field: string; direction?: string }> = d.orderBy ?? [];
  const sorted = sortBy(passing.map(p => ({ ...p, keys: order.map(o => p.row[o.field]) })), order.map(o => o.direction === 'desc' ? -1 : 1));
  return { rows: sorted.slice(offset, end).map(s => s.row), total: passing.length, matches: matching.length };
}
