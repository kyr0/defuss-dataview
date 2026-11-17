import { compileAccessor, fieldParts } from '../fields.js';
import { bytesOf, invalidValue } from '../values.js';
import type { AggregateExpr, ComputeBuilders, Expr } from './types.js';

/**
 * Expressions are frozen declarative nodes, never source text or callbacks: a plan can be validated, explained and
 * shared without eval, and a descriptor received as JSON goes through the same validation as builder output.
 * VERIFIED: src/compute/compute.test.ts rejects malformed, cyclic, unsafe and oversized trees before a source opens.
 */
export const MAX_EXPRESSION_DEPTH = 64;
export const MAX_PLAN_NODES = 10_000;
const UNARY = new Set(['number', 'not', 'isNullish']);
const BINARY = new Set(['add', 'sub', 'mul', 'div', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const VARIADIC = new Set(['coalesce', 'and', 'or']);
const MEASURES = new Set(['count', 'sum', 'avg', 'min', 'max', 'sumBigInt']);
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

const node = (op: string, extra: object) => Object.freeze({ v: 1 as const, op, ...extra });
export function createBuilders<T>(): ComputeBuilders<T> {
  const expr = <V>(op: string, extra: object) => node(op, extra) as Expr<V>;
  const args = (list: readonly Expr<unknown>[]) => Object.freeze([...list]);
  const measure = <V>(op: string, arg: Expr<unknown> | undefined, options?: { where?: Expr<boolean> }) =>
    node(op, { ...(arg !== undefined ? { arg } : {}), ...(options?.where !== undefined ? { where: options.where } : {}) }) as AggregateExpr<V>;
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
    count: (arg, options) => measure('count', arg, options),
    sum: (arg, options) => measure('sum', arg, options),
    avg: (arg, options) => measure('avg', arg, options),
    min: (arg, options) => measure('min', arg, options),
    max: (arg, options) => measure('max', arg, options),
    sumBigInt: (arg, options) => measure('sumBigInt', arg, options),
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
  refs: number;
}
export interface PlanMeasure { readonly op: string; readonly arg: number | undefined; readonly where: number | undefined }

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
    allowKeys(raw, ['v', 'op', 'arg', 'where'], where);
    const hasArg = Object.hasOwn(raw, 'arg');
    if (raw.op !== 'count' && !hasArg) throw new TypeError(`${where}: ${raw.op} needs an operand.`);
    if (hasArg && raw.arg === undefined) throw new TypeError(`${where}: use count(literal(undefined)) to count an undefined-valued expression.`);
    const arg = hasArg ? this.add(raw.arg, `${where}.arg`) : undefined;
    const predicate = Object.hasOwn(raw, 'where') ? this.add(raw.where, `${where}.where`) : undefined;
    if (arg !== undefined) this.nodes[arg].refs++;
    if (predicate !== undefined) this.nodes[predicate].refs++;
    return { op: raw.op, arg, where: predicate };
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
    const arity = UNARY.has(op) ? 1 : BINARY.has(op) ? 2 : VARIADIC.has(op) ? -1 : 0;
    if (!arity) throw new TypeError(`${where}: unknown expression operator ${JSON.stringify(op)}.`);
    allowKeys(raw, ['v', 'op', 'args'], where);
    const list = raw.args;
    if (!Array.isArray(list) || (arity > 0 ? list.length !== arity : list.length === 0)) throw new TypeError(`${where}: ${op} takes ${arity > 0 ? arity : 'one or more'} operand${arity === 1 ? '' : 's'}.`);
    path.add(raw);
    const ids = list.map((child, i) => this.visit(child, `${where}.${op}[${i}]`, depth + 1, path));
    path.delete(raw);
    for (const id of ids) this.nodes[id].refs++;
    return this.intern(`${op}(${ids.join(',')})`, { op, args: ids });
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
