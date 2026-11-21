import { compileAccessor, fieldParts } from '../fields.js';
import { bytesOf, invalidValue } from '../values.js';
import { DATE_PARTS, DATE_RANGE, DATE_UNITS, part, truncate, zoneFor } from './dates.js';
import type { DatePart, DateUnit, Zone } from './dates.js';
import type { AggregateExpr, ComputeBuilders, Expr } from './types.js';

/**
 * Expressions are frozen declarative nodes, never source text or callbacks: a plan can be validated, explained and
 * shared without eval, and a descriptor received as JSON goes through the same validation as builder output.
 * VERIFIED: src/compute/compute.test.ts rejects malformed, cyclic, unsafe and oversized trees before a source opens.
 */
export const MAX_EXPRESSION_DEPTH = 64;
export const MAX_PLAN_NODES = 10_000;
const UNARY = new Set(['number', 'not', 'isNullish', 'floor', 'ceil', 'round', 'abs', 'lower', 'upper', 'trim', 'length']);
const BINARY = new Set(['add', 'sub', 'mul', 'div', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const VARIADIC = new Set(['coalesce', 'and', 'or', 'concat']);
const MEASURES = new Set(['count', 'sum', 'avg', 'min', 'max', 'sumBigInt', 'countDistinct', 'distinct', 'percentile', 'median']);
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

const node = (op: string, extra: object) => Object.freeze({ v: 1 as const, op, ...extra });
export function createBuilders<T>(): ComputeBuilders<T> {
  const expr = <V>(op: string, extra: object) => node(op, extra) as Expr<V>;
  const args = (list: readonly Expr<unknown>[]) => Object.freeze([...list]);
  const measure = <V>(op: string, arg: Expr<unknown> | undefined, options?: { where?: Expr<boolean> }, extra?: object) =>
    node(op, { ...(arg !== undefined ? { arg } : {}), ...extra, ...(options?.where !== undefined ? { where: options.where } : {}) }) as AggregateExpr<V>;
  const zone = (options?: { timeZone?: string }) => options?.timeZone !== undefined ? { timeZone: options.timeZone } : {};
  return Object.freeze({
    field: key => expr('field', { key }),
    path: path => expr('path', { path }),
    literal: value => expr('literal', { value }),
    number: a => expr('number', { args: args([a]) }),
    add: (a, b) => expr('add', { args: args([a, b]) }),
    sub: (a, b) => expr('sub', { args: args([a, b]) }),
    mul: (a, b) => expr('mul', { args: args([a, b]) }),
    div: (a, b) => expr('div', { args: args([a, b]) }),
    coalesce: (...list) => expr('coalesce', { args: args(list) }),
    eq: (a, b) => expr('eq', { args: args([a, b]) }),
    neq: (a, b) => expr('neq', { args: args([a, b]) }),
    gt: (a, b) => expr('gt', { args: args([a, b]) }),
    gte: (a, b) => expr('gte', { args: args([a, b]) }),
    lt: (a, b) => expr('lt', { args: args([a, b]) }),
    lte: (a, b) => expr('lte', { args: args([a, b]) }),
    isNullish: a => expr('isNullish', { args: args([a]) }),
    and: (...list) => expr('and', { args: args(list) }),
    or: (...list) => expr('or', { args: args(list) }),
    not: a => expr('not', { args: args([a]) }),
    cond: (test, then, otherwise) => expr('cond', { args: args([test, then, otherwise]) }),
    floor: a => expr('floor', { args: args([a]) }),
    ceil: a => expr('ceil', { args: args([a]) }),
    round: a => expr('round', { args: args([a]) }),
    abs: a => expr('abs', { args: args([a]) }),
    dateTrunc: (a, unit, options) => expr('dateTrunc', { args: args([a]), unit, ...zone(options) }),
    datePart: (a, which, options) => expr('datePart', { args: args([a]), part: which, ...zone(options) }),
    lower: a => expr('lower', { args: args([a]) }),
    upper: a => expr('upper', { args: args([a]) }),
    trim: a => expr('trim', { args: args([a]) }),
    substring: (a, start, length) => expr('substring', { args: args([a]), start, ...(length !== undefined ? { length } : {}) }),
    concat: (...list) => expr('concat', { args: args(list) }),
    length: a => expr('length', { args: args([a]) }),
    each: a => expr('each', { args: args([a]) }),
    count: (arg, options) => measure('count', arg, options),
    sum: (arg, options) => measure('sum', arg, options),
    avg: (arg, options) => measure('avg', arg, options),
    min: (arg, options) => measure('min', arg, options),
    max: (arg, options) => measure('max', arg, options),
    sumBigInt: (arg, options) => measure('sumBigInt', arg, options),
    countDistinct: (arg, options) => measure('countDistinct', arg, options),
    distinct: (arg, options) => measure('distinct', arg, options),
    percentile: (arg, p, options) => measure('percentile', arg, options, { p }),
    median: (arg, options) => measure('median', arg, options),
  } satisfies ComputeBuilders<T>);
}

/** One interned expression. Identical pure nodes share an id, so a row evaluates them at most once. */
export interface PlanNode {
  readonly id: number;
  readonly op: string;
  readonly args: readonly number[];
  /** Field key, or dot path for `path`. */
  readonly field?: string;
  readonly value?: unknown;
  /** dateTrunc's unit or datePart's part, and their zone. */
  readonly unit?: string;
  readonly zone?: Zone;
  /** substring's start and length in code points. */
  readonly start?: number;
  readonly length?: number;
  refs: number;
}
export interface PlanMeasure { readonly op: string; readonly arg: number | undefined; readonly where: number | undefined; readonly p?: number }

/** Validates untrusted node trees and interns them into one node table per plan. */
export class ExpressionTable {
  readonly nodes: PlanNode[] = [];
  private readonly interned = new Map<string, number>();
  private readonly identities = new Map<unknown, number>();
  constructor(private readonly byValue: boolean) {}
  add(raw: unknown, where: string): number {
    return this.visit(raw, where, 0, new Set());
  }
  measure(raw: unknown, where: string): PlanMeasure {
    if (!isNode(raw) || !MEASURES.has(raw.op)) throw new TypeError(`${where} must be a measure such as count() or sum(expr).`);
    allowKeys(raw, raw.op === 'percentile' ? ['v', 'op', 'arg', 'where', 'p'] : ['v', 'op', 'arg', 'where'], where);
    const p = raw.op === 'percentile' ? raw.p : raw.op === 'median' ? 0.5 : undefined;
    if (raw.op === 'percentile' && !(typeof p === 'number' && p >= 0 && p <= 1)) throw new TypeError(`${where}: percentile needs p, a number from 0 to 1.`);
    const hasArg = Object.hasOwn(raw, 'arg');
    if (raw.op !== 'count' && !hasArg) throw new TypeError(`${where}: ${raw.op} needs an operand.`);
    if (hasArg && raw.arg === undefined) throw new TypeError(`${where}: use count(literal(undefined)) to count an undefined-valued expression.`);
    const arg = hasArg ? this.add(raw.arg, `${where}.arg`) : undefined;
    const predicate = Object.hasOwn(raw, 'where') ? this.add(raw.where, `${where}.where`) : undefined;
    if (arg !== undefined) this.nodes[arg].refs++;
    if (predicate !== undefined) this.nodes[predicate].refs++;
    return { op: raw.op, arg, where: predicate, ...(p !== undefined ? { p: p as number } : {}) };
  }
  private visit(raw: unknown, where: string, depth: number, path: Set<object>): number {
    if (depth > MAX_EXPRESSION_DEPTH) throw new RangeError(`${where}: expression nesting exceeds ${MAX_EXPRESSION_DEPTH}.`);
    if (!isNode(raw)) throw new TypeError(`${where} must be an expression built by forRows() (an object with v: 1 and op).`);
    if (path.has(raw)) throw new TypeError(`${where}: expression contains a cycle.`);
    if (this.nodes.length >= MAX_PLAN_NODES) throw new RangeError(`A plan may hold at most ${MAX_PLAN_NODES} expression nodes.`);
    const op = raw.op;
    if (op === 'field') {
      allowKeys(raw, ['v', 'op', 'key'], where);
      if (typeof raw.key !== 'string' || !raw.key || raw.key.includes('.') || UNSAFE.has(raw.key)) throw new TypeError(`${where}: field() takes one safe top-level key; use path() for dot paths.`);
      return this.intern(`f:${raw.key}`, { op, args: [], field: raw.key });
    }
    if (op === 'path') {
      allowKeys(raw, ['v', 'op', 'path'], where);
      if (typeof raw.path !== 'string') throw new TypeError(`${where}: path() takes a dot path string.`);
      fieldParts(raw.path);
      return this.intern(`p:${raw.path}`, { op, args: [], field: raw.path });
    }
    if (op === 'literal') {
      allowKeys(raw, ['v', 'op', 'value'], where);
      if (!Object.hasOwn(raw, 'value')) throw new TypeError(`${where}: literal() needs a value.`);
      const value = capture(raw.value, this.byValue);
      const key = literalKey(value);
      // Objects keep identity: two literals that print alike are still different operands.
      if (key === undefined) { let id = this.identities.get(raw); if (id === undefined) { id = this.push({ op, args: [], value }); this.identities.set(raw, id); } return id; }
      return this.intern(key, { op, args: [], value });
    }
    if (op === 'each') throw new TypeError(`${where}: each() must be a whole groupBy key.`);
    const options = OPTIONS[op];
    const arity = UNARY.has(op) || options ? 1 : BINARY.has(op) ? 2 : op === 'cond' ? 3 : VARIADIC.has(op) ? -1 : 0;
    if (!arity) throw new TypeError(`${where}: unknown expression operator ${JSON.stringify(op)}.`);
    allowKeys(raw, ['v', 'op', 'args', ...(options ?? [])], where);
    const extra = options ? optionsOf(raw, where) : undefined;
    const list = raw.args;
    if (!Array.isArray(list) || (arity > 0 ? list.length !== arity : list.length === 0)) throw new TypeError(`${where}: ${op} takes ${arity > 0 ? arity : 'one or more'} operand${arity === 1 ? '' : 's'}.`);
    path.add(raw);
    const ids = list.map((child, i) => this.visit(child, `${where}.${op}[${i}]`, depth + 1, path));
    path.delete(raw);
    for (const id of ids) this.nodes[id].refs++;
    const tag = extra ? `:${extra.unit ?? ''}:${extra.zone?.name ?? ''}:${extra.start ?? ''}:${extra.length ?? ''}` : '';
    return this.intern(`${op}${tag}(${ids.join(',')})`, { op, args: ids, ...extra });
  }
  private intern(key: string, spec: Omit<PlanNode, 'id' | 'refs'>): number {
    let id = this.interned.get(key);
    if (id === undefined) { id = this.push(spec); this.interned.set(key, id); }
    return id;
  }
  private push(spec: Omit<PlanNode, 'id' | 'refs'>): number {
    const id = this.nodes.length;
    this.nodes.push({ id, refs: 0, ...spec });
    return id;
  }
  /** Source fields and paths a plan reads, for leases and explain(). */
  fields(): string[] { return [...new Set(this.nodes.flatMap(n => n.field !== undefined ? [n.field] : []))]; }
}
/** Operators with options beside their one operand. */
const OPTIONS: Partial<Record<string, string[]>> = { dateTrunc: ['unit', 'timeZone'], datePart: ['part', 'timeZone'], substring: ['start', 'length'] };
const natural = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
function optionsOf(raw: RawNode, where: string): Pick<PlanNode, 'unit' | 'zone' | 'start' | 'length'> {
  if (raw.op === 'substring') {
    if (!natural(raw.start) || (raw.length !== undefined && !natural(raw.length))) throw new TypeError(`${where}: substring takes a start and an optional length, nonnegative integers.`);
    return { start: raw.start as number, ...(raw.length !== undefined ? { length: raw.length as number } : {}) };
  }
  const unit = raw.op === 'dateTrunc' ? raw.unit : raw.part, names = raw.op === 'dateTrunc' ? DATE_UNITS : DATE_PARTS;
  if (typeof unit !== 'string' || !names.has(unit)) throw new TypeError(`${where}: ${raw.op} takes one of ${[...names].join(', ')}.`);
  return { unit, zone: zoneFor(raw.timeZone, where) };
}
interface RawNode { v: 1; op: string; [key: string]: unknown }
function isNode(raw: unknown): raw is RawNode {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as RawNode).v === 1 && typeof (raw as RawNode).op === 'string';
}
function allowKeys(raw: object, keys: string[], where: string): void {
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new TypeError(`${where}: unexpected property ${JSON.stringify(key)}.`);
}
/** Same by-value/identity capture as query operands: value mode copies Dates and visible binary bytes. */
function capture(value: unknown, byValue: boolean): unknown {
  if (!byValue) return value;
  if (value instanceof Date) return new Date(value.getTime());
  const bytes = bytesOf(value);
  return bytes ? bytes.slice() : value;
}
function literalKey(value: unknown): string | undefined {
  switch (typeof value) {
    case 'number': return Object.is(value, -0) ? 'l:n:-0' : `l:n:${value}`;
    case 'string': return `l:s:${value}`;
    case 'bigint': return `l:b:${value}`;
    case 'boolean': return `l:t:${value}`;
    case 'undefined': return 'l:u';
    default: return value === null ? 'l:null' : undefined;
  }
}

/** Per-execution evaluation context: the current row and its ordinal within the session's scan. */
export interface RowContext { row: object; ordinal: number; epoch: number }
export interface NumericPolicy { invalidNumbers: 'error' | 'skip' }
export interface ValueOps { equal(a: unknown, b: unknown): boolean; compare(a: unknown, b: unknown): number }
export interface Columns { begin: number; get(field: string): readonly unknown[] | undefined }

/** Validates a numeric operand: finite number, null for nullish, else the plan's invalid-number policy. */
export function numeric(value: unknown, policy: NumericPolicy, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (policy.invalidNumbers === 'skip') return null;
  throw new TypeError(`${what} must be a finite number or null; got ${describe(value)}.`);
}
function boolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${what} must produce a Boolean; got ${describe(value)}. Compare explicitly or coalesce(expr, literal(false)).`);
  return value;
}
export function describe(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (value === null) return 'null';
  return typeof value === 'object' ? (value instanceof Date ? 'a Date' : 'an object') : typeof value;
}
/**
 * A date operand as epoch milliseconds: a valid Date or a number in the Date range; invalid Dates give null. Other
 * values follow the invalid-number policy, so one switch governs every operand a plan cannot read.
 * VERIFIED: src/compute/operators.test.ts and src/compute/dates.test.ts cover each operator's nullish, invalid and
 * rejected operands; src/compute/oracle.test.ts compares the 'functions' and 'calendar' plans with the oracle.
 */
function instant(value: unknown, policy: NumericPolicy, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) { const t = value.getTime(); return Number.isNaN(t) ? null : t; }
  if (typeof value === 'number' && Math.abs(value) <= DATE_RANGE) return value;
  if (policy.invalidNumbers === 'skip') return null;
  throw new TypeError(`${what} needs a Date or epoch milliseconds; got ${describe(value)}.`);
}
function text(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`${what} needs a string; got ${describe(value)}.`);
  return value;
}
/** The UTF-16 index `points` code points after `from`; a lone surrogate counts as one. */
function advance(s: string, from: number, points: number): number {
  let i = from;
  for (let n = 0; n < points && i < s.length; n++) {
    const c = s.charCodeAt(i++);
    if (c >= 0xd800 && c <= 0xdbff && i < s.length) { const d = s.charCodeAt(i); if (d >= 0xdc00 && d <= 0xdfff) i++; }
  }
  return i;
}
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; n++) i = advance(s, i, 1);
  return n;
}
function finite(value: number, op: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${op} overflowed to ${value}.`);
  return value;
}

/**
 * Closures for one execution. Nothing here lives in the prepared plan, so concurrent executions never share state.
 * Nodes referenced more than once are memoized per row epoch; each is still evaluated only when first demanded, so
 * sharing never evaluates an expression on a row where the plan as written would not.
 */
export function instantiate(nodes: readonly PlanNode[], ctx: RowContext, ops: ValueOps, policy: NumericPolicy, columns: Columns | undefined, reads: { count: number } | undefined): Array<() => unknown> {
  const evals: Array<() => unknown> = Array.from({ length: nodes.length });
  const stamp = new Float64Array(nodes.length).fill(-1), memo: unknown[] = Array.from({ length: nodes.length });
  for (const spec of nodes) {
    // Children are interned before their parents, so their final evaluators already exist.
    const a = spec.args.map(id => evals[id]);
    const [x, y] = a;
    let f: () => unknown;
    switch (spec.op) {
      case 'field': case 'path': {
        const column = columns?.get(spec.field!), begin = columns?.begin ?? 0;
        if (column) f = reads ? () => { reads.count++; return column[begin + ctx.ordinal]; } : () => column[begin + ctx.ordinal];
        else {
          // A top-level read is inlined: validated rows are objects, so only the own-property guard remains.
          const key = spec.field!, get = spec.op === 'path' ? compileAccessor(key) : undefined;
          if (reads) f = get ? () => { reads.count++; return get(ctx.row); } : () => { reads.count++; const row = ctx.row as Record<string, unknown>; return Object.hasOwn(row, key) ? row[key] : undefined; };
          else f = get ? () => get(ctx.row) : () => { const row = ctx.row as Record<string, unknown>; return Object.hasOwn(row, key) ? row[key] : undefined; };
        }
        break;
      }
      case 'literal': { const value = spec.value; f = () => value; break; }
      case 'number': f = () => numeric(x(), policy, 'number()'); break;
      case 'add': case 'sub': case 'mul': case 'div': {
        const op = spec.op;
        f = () => {
          const l = numeric(x(), policy, `${op} operand`); if (l === null) return null;
          const r = numeric(y(), policy, `${op} operand`); if (r === null) return null;
          if (op === 'div' && r === 0) throw new RangeError('div by zero.');
          return finite(op === 'add' ? l + r : op === 'sub' ? l - r : op === 'mul' ? l * r : l / r, op);
        };
        break;
      }
      case 'coalesce': f = () => { let value: unknown; for (const g of a) { value = g(); if (value !== null && value !== undefined) return value; } return value; }; break;
      case 'eq': f = () => ops.equal(x(), y()); break;
      case 'neq': f = () => !ops.equal(x(), y()); break;
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const op = spec.op;
        f = () => {
          const l = x(), r = y();
          if (invalidValue(l) || invalidValue(r)) return false;
          const c = ops.compare(l, r);
          return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0;
        };
        break;
      }
      case 'isNullish': f = () => { const value = x(); return value === null || value === undefined; }; break;
      case 'and': f = () => { for (const g of a) if (!boolean(g(), 'and()')) return false; return true; }; break;
      case 'or': f = () => { for (const g of a) if (boolean(g(), 'or()')) return true; return false; }; break;
      case 'not': f = () => !boolean(x(), 'not()'); break;
      case 'cond': { const z = a[2]; f = () => boolean(x(), 'cond() test') ? y() : z(); break; }
      case 'floor': case 'ceil': case 'round': case 'abs': {
        const op = spec.op, math = op === 'floor' ? Math.floor : op === 'ceil' ? Math.ceil : op === 'abs' ? Math.abs : (n: number) => Math.sign(n) * Math.round(Math.abs(n));
        f = () => { const n = numeric(x(), policy, `${op} operand`); return n === null ? null : math(n); };
        break;
      }
      case 'dateTrunc': case 'datePart': {
        const op = spec.op, unit = spec.unit!, zone = spec.zone!;
        f = op === 'dateTrunc'
          ? () => {
            const t = instant(x(), policy, 'dateTrunc()'); if (t === null) return null;
            // The start of a period can lie before the first valid Date.
            const start = truncate(t, unit as DateUnit, zone);
            return Math.abs(start) <= DATE_RANGE ? new Date(start) : null;
          }
          : () => { const t = instant(x(), policy, 'datePart()'); return t === null ? null : part(t, unit as DatePart, zone); };
        break;
      }
      case 'lower': f = () => text(x(), 'lower()')?.toLowerCase() ?? null; break;
      case 'upper': f = () => text(x(), 'upper()')?.toUpperCase() ?? null; break;
      case 'trim': f = () => text(x(), 'trim()')?.trim() ?? null; break;
      case 'substring': {
        const start = spec.start!, length = spec.length;
        f = () => {
          const s = text(x(), 'substring()'); if (s === null) return null;
          const begin = advance(s, 0, start);
          return s.slice(begin, length === undefined ? s.length : advance(s, begin, length));
        };
        break;
      }
      case 'concat': f = () => { let out = ''; for (const g of a) { const s = text(g(), 'concat()'); if (s === null) return null; out += s; } return out; }; break;
      case 'length': f = () => {
        const value = x();
        if (value === null || value === undefined) return null;
        if (Array.isArray(value)) return value.length;
        if (typeof value !== 'string') throw new TypeError(`length() needs a string or an array; got ${describe(value)}.`);
        return codePoints(value);
      }; break;
      default: throw new TypeError(`Unknown expression operator ${spec.op}.`);
    }
    const id = spec.id;
    evals[id] = spec.refs > 1 && spec.op !== 'literal' ? () => {
      if (stamp[id] === ctx.epoch) return memo[id];
      const value = f(); memo[id] = value; stamp[id] = ctx.epoch; return value;
    } : f;
  }
  return evals;
}
export { boolean as requireBoolean };
