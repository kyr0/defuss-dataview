import { compileAccessor, fieldParts } from '../fields.js';
import { invalidValue, snapshot } from '../values.js';
import { DATE_PARTS, DATE_RANGE, DATE_UNITS, SPAN_UNITS, WEEKDAYS, add, diff, part, truncate, zoneFor } from './dates.js';
import type { DatePart, DateUnit, SpanUnit, Zone } from './dates.js';
import type { AggregateExpr, ComputeBuilders, Expr } from './types.js';

/**
 * Expressions are frozen declarative nodes, never source text or callbacks: a plan can be validated, explained and
 * shared without eval, and a descriptor received as JSON goes through the same validation as builder output.
 * VERIFIED: src/compute/compute.test.ts rejects malformed, cyclic, unsafe and oversized trees before a source opens.
 */
export const MAX_EXPRESSION_DEPTH = 64;
export const MAX_PLAN_NODES = 10_000;
const UNARY = new Set(['number', 'not', 'isNullish', 'floor', 'ceil', 'round', 'abs', 'epochMs', 'toDate', 'lower', 'upper', 'trim', 'length',
  'typeOf', 'bitNot', 'sqrt', 'ln', 'exp', 'toText', 'parseNumber', 'get', 'dateTrunc', 'datePart', 'substring']);
const BINARY = new Set(['add', 'sub', 'mul', 'div', 'mod', 'pow', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'endsWith',
  'split', 'indexOf', 'dateAdd', 'dateDiff']);
const TERNARY = new Set(['cond', 'replaceAll']);
const VARIADIC = new Set(['coalesce', 'and', 'or', 'concat', 'bitAnd', 'bitOr', 'bitXor', 'least', 'greatest']);
/** Elements of nested some()/every() are numbered by nesting level, so one bit per level marks a node's free elements. */
const MAX_QUANTIFIER_LEVEL = 30;
const MEASURES = new Set(['count', 'sum', 'avg', 'min', 'max', 'sumBigInt', 'countDistinct', 'distinct', 'percentile', 'median', 'varPop', 'varSamp', 'stdDevPop', 'stdDevSamp']);
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

const node = (op: string, extra: object) => Object.freeze({ v: 1 as const, op, ...extra });
// The nesting level of the predicateFn running now. One counter for every builder set, so a predicate built with
// another forRows() instance still gets its own level. Building is synchronous: try/finally restores the level.
let nesting = 0;
export function createBuilders<T>(): ComputeBuilders<T> {
  const expr = <V>(op: string, extra: object) => node(op, extra) as Expr<V>;
  const args = (list: readonly Expr<unknown>[]) => Object.freeze([...list]);
  const measure = <V>(op: string, arg: Expr<unknown> | undefined, options?: { where?: Expr<boolean> }, extra?: object) =>
    node(op, { ...(arg !== undefined ? { arg } : {}), ...extra, ...(options?.where !== undefined ? { where: options.where } : {}) }) as AggregateExpr<V>;
  const zone = (options?: { timeZone?: string }) => options?.timeZone !== undefined ? { timeZone: options.timeZone } : {};
  const pick = (options: object | undefined, keys: string[]) => Object.fromEntries(keys.flatMap(k => options && (options as Record<string, unknown>)[k] !== undefined ? [[k, (options as Record<string, unknown>)[k]]] : []));
  // predicateFn runs once, now: it receives the element as an expression and returns a Boolean expression, so the
  // descriptor stays plain data that workers, partial() and plan signatures can copy and compare.
  const quantifier = <V>(op: 'some' | 'every', list: Expr<unknown>, predicateFn: (element: Expr<V>) => Expr<boolean>) => {
    if (typeof predicateFn !== 'function') throw new TypeError(`${op}() takes a list and a predicateFn, element => Boolean expression.`);
    const level = nesting++;
    try { return expr<boolean>(op, { args: args([list, predicateFn(expr<V>('element', { level }))]), level }); } finally { nesting--; }
  };
  return Object.freeze({
    field: key => expr('field', { key }),
    path: path => expr('path', { path }),
    get: (a, path) => expr('get', { args: args([a]), path }),
    literal: value => expr('literal', { value }),
    number: a => expr('number', { args: args([a]) }),
    add: (a, b) => expr('add', { args: args([a, b]) }),
    sub: (a, b) => expr('sub', { args: args([a, b]) }),
    mul: (a, b) => expr('mul', { args: args([a, b]) }),
    div: (a, b) => expr('div', { args: args([a, b]) }),
    mod: (a, b) => expr('mod', { args: args([a, b]) }),
    pow: (a, b) => expr('pow', { args: args([a, b]) }),
    sqrt: a => expr('sqrt', { args: args([a]) }),
    ln: a => expr('ln', { args: args([a]) }),
    exp: a => expr('exp', { args: args([a]) }),
    bitAnd: (...list) => expr('bitAnd', { args: args(list) }),
    bitOr: (...list) => expr('bitOr', { args: args(list) }),
    bitXor: (...list) => expr('bitXor', { args: args(list) }),
    bitNot: a => expr('bitNot', { args: args([a]) }),
    least: (...list) => expr('least', { args: args(list) }),
    greatest: (...list) => expr('greatest', { args: args(list) }),
    coalesce: (...list) => expr('coalesce', { args: args(list) }),
    eq: (a, b) => expr('eq', { args: args([a, b]) }),
    neq: (a, b) => expr('neq', { args: args([a, b]) }),
    gt: (a, b) => expr('gt', { args: args([a, b]) }),
    gte: (a, b) => expr('gte', { args: args([a, b]) }),
    lt: (a, b) => expr('lt', { args: args([a, b]) }),
    lte: (a, b) => expr('lte', { args: args([a, b]) }),
    in: (a, list) => expr('in', { args: args([a, list]) }),
    contains: (a, b) => expr('contains', { args: args([a, b]) }),
    startsWith: (a, b) => expr('startsWith', { args: args([a, b]) }),
    endsWith: (a, b) => expr('endsWith', { args: args([a, b]) }),
    some: (list, predicateFn) => quantifier('some', list, predicateFn),
    every: (list, predicateFn) => quantifier('every', list, predicateFn),
    typeOf: a => expr('typeOf', { args: args([a]) }),
    isNullish: a => expr('isNullish', { args: args([a]) }),
    and: (...list) => expr('and', { args: args(list) }),
    or: (...list) => expr('or', { args: args(list) }),
    not: a => expr('not', { args: args([a]) }),
    cond: (test, then, otherwise) => expr('cond', { args: args([test, then, otherwise]) }),
    floor: a => expr('floor', { args: args([a]) }),
    ceil: a => expr('ceil', { args: args([a]) }),
    round: a => expr('round', { args: args([a]) }),
    abs: a => expr('abs', { args: args([a]) }),
    epochMs: a => expr('epochMs', { args: args([a]) }),
    toDate: a => expr('toDate', { args: args([a]) }),
    dateTrunc: (a, unit, options) => expr('dateTrunc', { args: args([a]), unit, ...pick(options, ['timeZone', 'binSize', 'startOfWeek']) }),
    datePart: (a, which, options) => expr('datePart', { args: args([a]), part: which, ...zone(options) }),
    dateAdd: (a, unit, amount, options) => expr('dateAdd', { args: args([a, amount]), unit, ...zone(options) }),
    dateDiff: (start, end, unit, options) => expr('dateDiff', { args: args([start, end]), unit, ...pick(options, ['timeZone', 'startOfWeek']) }),
    lower: a => expr('lower', { args: args([a]) }),
    upper: a => expr('upper', { args: args([a]) }),
    trim: a => expr('trim', { args: args([a]) }),
    substring: (a, start, length) => expr('substring', { args: args([a]), start, ...(length !== undefined ? { length } : {}) }),
    concat: (...list) => expr('concat', { args: args(list) }),
    length: a => expr('length', { args: args([a]) }),
    split: (a, separator) => expr('split', { args: args([a, separator]) }),
    replaceAll: (a, find, replacement) => expr('replaceAll', { args: args([a, find, replacement]) }),
    indexOf: (a, search) => expr('indexOf', { args: args([a, search]) }),
    toText: a => expr('toText', { args: args([a]) }),
    parseNumber: a => expr('parseNumber', { args: args([a]) }),
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
    varPop: (arg, options) => measure('varPop', arg, options),
    varSamp: (arg, options) => measure('varSamp', arg, options),
    stdDevPop: (arg, options) => measure('stdDevPop', arg, options),
    stdDevSamp: (arg, options) => measure('stdDevSamp', arg, options),
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
  /** dateTrunc's, dateAdd's or dateDiff's unit or datePart's part, their zone, dateTrunc's bin size and week start (0 = Monday). */
  readonly unit?: string;
  readonly zone?: Zone;
  readonly binSize?: number;
  readonly weekStart?: number;
  /** substring's start and length in code points. */
  readonly start?: number;
  readonly length?: number;
  /** get()'s dot path. */
  readonly path?: string;
  /** The nesting level of some()/every() and of their element. */
  readonly level?: number;
  /** Bit per level of the elements this node reads and does not bind itself: such a node changes per element. */
  readonly free: number;
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
    return this.visit(raw, where, 0, new Set(), 0);
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
  /** `scope` has one bit per level of some()/every() whose predicate encloses this node. */
  private visit(raw: unknown, where: string, depth: number, path: Set<object>, scope: number): number {
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
    const quantified = op === 'some' || op === 'every';
    if (op === 'element' || quantified) {
      allowKeys(raw, quantified ? ['v', 'op', 'args', 'level'] : ['v', 'op', 'level'], where);
      const level = raw.level;
      if (!Number.isSafeInteger(level) || (level as number) < 0 || (level as number) > MAX_QUANTIFIER_LEVEL) throw new RangeError(`${where}: some() and every() nest at most ${MAX_QUANTIFIER_LEVEL + 1} deep.`);
      const bit = 1 << (level as number);
      if (op === 'element') {
        if (!(scope & bit)) throw new TypeError(`${where}: an element of some() or every() is used outside that predicate.`);
        return this.intern(`e:${level}`, { op, args: [], level: level as number });
      }
      if (!Array.isArray(raw.args) || raw.args.length !== 2) throw new TypeError(`${where}: ${op} takes a list and a predicate.`);
      path.add(raw);
      const ids = [this.visit(raw.args[0], `${where}.${op}[0]`, depth + 1, path, scope), this.visit(raw.args[1], `${where}.${op}[1]`, depth + 1, path, scope | bit)];
      path.delete(raw);
      for (const id of ids) this.nodes[id].refs++;
      return this.intern(`${op}:${level}(${ids.join(',')})`, { op, args: ids, level: level as number });
    }
    const options = OPTIONS[op];
    const arity = UNARY.has(op) ? 1 : BINARY.has(op) ? 2 : TERNARY.has(op) ? 3 : VARIADIC.has(op) ? -1 : 0;
    if (!arity) throw new TypeError(`${where}: unknown expression operator ${JSON.stringify(op)}.`);
    allowKeys(raw, ['v', 'op', 'args', ...(options ?? [])], where);
    const extra = options ? optionsOf(raw, where) : undefined;
    const list = raw.args;
    if (!Array.isArray(list) || (arity > 0 ? list.length !== arity : list.length === 0)) throw new TypeError(`${where}: ${op} takes ${arity > 0 ? arity : 'one or more'} operand${arity === 1 ? '' : 's'}.`);
    path.add(raw);
    const ids = list.map((child, i) => this.visit(child, `${where}.${op}[${i}]`, depth + 1, path, scope));
    path.delete(raw);
    for (const id of ids) this.nodes[id].refs++;
    const tag = extra ? `:${JSON.stringify({ ...extra, zone: extra.zone?.name })}` : '';
    return this.intern(`${op}${tag}(${ids.join(',')})`, { op, args: ids, ...extra });
  }
  private intern(key: string, spec: Omit<PlanNode, 'id' | 'refs' | 'free'>): number {
    let id = this.interned.get(key);
    if (id === undefined) { id = this.push(spec); this.interned.set(key, id); }
    return id;
  }
  private push(spec: Omit<PlanNode, 'id' | 'refs' | 'free'>): number {
    const id = this.nodes.length;
    let free = 0;
    for (const arg of spec.args) free |= this.nodes[arg].free;
    if (spec.op === 'element') free = 1 << spec.level!;
    else if (spec.op === 'some' || spec.op === 'every') free &= ~(1 << spec.level!);
    this.nodes.push({ id, refs: 0, free, ...spec });
    return id;
  }
  /** Source fields and paths a plan reads, for leases and explain(). */
  fields(): string[] { return [...new Set(this.nodes.flatMap(n => n.field !== undefined ? [n.field] : []))]; }
}
/** Operators with options beside their operands. */
const OPTIONS: Partial<Record<string, string[]>> = {
  dateTrunc: ['unit', 'timeZone', 'binSize', 'startOfWeek'], datePart: ['part', 'timeZone'], dateAdd: ['unit', 'timeZone'], dateDiff: ['unit', 'timeZone', 'startOfWeek'],
  substring: ['start', 'length'], get: ['path'],
};
const natural = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
type Options = Pick<PlanNode, 'unit' | 'zone' | 'binSize' | 'weekStart' | 'start' | 'length' | 'path'>;
function optionsOf(raw: RawNode, where: string): Options {
  if (raw.op === 'substring') {
    if (!natural(raw.start) || (raw.length !== undefined && !natural(raw.length))) throw new TypeError(`${where}: substring takes a start and an optional length, nonnegative integers.`);
    return { start: raw.start as number, ...(raw.length !== undefined ? { length: raw.length as number } : {}) };
  }
  if (raw.op === 'get') {
    if (typeof raw.path !== 'string') throw new TypeError(`${where}: get() takes a dot path string.`);
    fieldParts(raw.path);
    return { path: raw.path };
  }
  const unit = raw.op === 'datePart' ? raw.part : raw.unit, names = raw.op === 'dateTrunc' ? DATE_UNITS : raw.op === 'datePart' ? DATE_PARTS : SPAN_UNITS;
  if (typeof unit !== 'string' || !names.has(unit)) throw new TypeError(`${where}: ${raw.op} takes one of ${[...names].join(', ')}.`);
  const out: Options = { unit, zone: zoneFor(raw.timeZone, where) };
  if (raw.binSize !== undefined) {
    if (!Number.isSafeInteger(raw.binSize) || (raw.binSize as number) < 1) throw new TypeError(`${where}: dateTrunc binSize must be a positive integer.`);
    if (raw.binSize !== 1) Object.assign(out, { binSize: raw.binSize as number });
  }
  if (raw.startOfWeek !== undefined) {
    const day = typeof raw.startOfWeek === 'string' ? WEEKDAYS.indexOf(raw.startOfWeek as never) : -1;
    if (day < 0) throw new TypeError(`${where}: startOfWeek takes one of ${WEEKDAYS.join(', ')}.`);
    if (day) Object.assign(out, { weekStart: day });
  }
  return out;
}
interface RawNode { v: 1; op: string; [key: string]: unknown }
function isNode(raw: unknown): raw is RawNode {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as RawNode).v === 1 && typeof (raw as RawNode).op === 'string';
}
function allowKeys(raw: object, keys: string[], where: string): void {
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new TypeError(`${where}: unexpected property ${JSON.stringify(key)}.`);
}
/** Same by-value/identity capture as query operands: value mode copies Dates, visible binary bytes and arrays. */
const capture = (value: unknown, byValue: boolean): unknown => snapshot(value, byValue);
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
  return typeof value === 'object' ? (value instanceof Date ? 'a Date' : Array.isArray(value) ? 'an array' : 'an object') : typeof value;
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
/** A bitwise operand: a safe integer or a BigInt; nullish gives null, anything else the invalid-number policy. */
function integer(value: unknown, policy: NumericPolicy, what: string): number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint' || Number.isSafeInteger(value)) return value as number | bigint;
  if (policy.invalidNumbers === 'skip') return null;
  throw new TypeError(`${what} needs safe integers or BigInts; got ${describe(value)}.`);
}
/**
 * Bitwise operations on safe integers as 64-bit two's complement, as MongoDB computes them on longs. A safe integer's
 * bits 53 to 63 all equal its sign bit, and AND, OR, XOR and NOT keep that true, so the result is exact; int32 operands
 * take JavaScript's 32-bit operators, which agree there. BigInts compute at their full width.
 */
function bitwise(op: string, a: number | bigint, b: number | bigint): number | bigint {
  if (typeof a === 'bigint') { const y = b as bigint; return op === 'bitAnd' ? a & y : op === 'bitOr' ? a | y : a ^ y; }
  const y = b as number;
  if ((a | 0) === a && (y | 0) === y) return op === 'bitAnd' ? a & y : op === 'bitOr' ? a | y : a ^ y;
  const x = BigInt(a), z = BigInt(y);
  return Number(op === 'bitAnd' ? x & z : op === 'bitOr' ? x | z : x ^ z);
}
/** typeOf(): the value families of DataView's order, plus JavaScript's names for functions and symbols. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object') return type;
  if (value instanceof Date) return 'date';
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return 'binary';
  return Array.isArray(value) ? 'array' : 'object';
}
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * Closures for one execution. Nothing here lives in the prepared plan, so concurrent executions never share state.
 * Nodes referenced more than once are memoized per row epoch; each is still evaluated only when first demanded, so
 * sharing never evaluates an expression on a row where the plan as written would not.
 */
export function instantiate(nodes: readonly PlanNode[], ctx: RowContext, ops: ValueOps, policy: NumericPolicy, columns: Columns | undefined, reads: { count: number } | undefined): Array<() => unknown> {
  const evals: Array<() => unknown> = Array.from({ length: nodes.length });
  const stamp = new Float64Array(nodes.length).fill(-1), memo: unknown[] = Array.from({ length: nodes.length });
  /** The current element of each some()/every() level. */
  const elements: unknown[] = [];
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
      case 'element': { const level = spec.level!; f = () => elements[level]; break; }
      case 'some': case 'every': {
        // some(): true at the first element that passes; every(): false at the first that fails. A value that is no
        // array gives false for both; an empty array gives false and true. The element slot is restored afterwards,
        // so a predicate built elsewhere at the same level shadows an outer element only inside itself.
        const level = spec.level!, all = spec.op === 'every', what = `${spec.op}() predicate`;
        f = () => {
          const list = x();
          if (!Array.isArray(list)) return false;
          const outer = elements[level];
          try {
            for (let i = 0; i < list.length; i++) { elements[level] = list[i]; if (boolean(y(), what) !== all) return !all; }
            return all;
          } finally { elements[level] = outer; }
        };
        break;
      }
      case 'get': { const get = compileAccessor(spec.path!); f = () => get(x()); break; }
      case 'number': f = () => numeric(x(), policy, 'number()'); break;
      case 'mod': f = () => {
        // Two BigInts take BigInt's remainder, as MongoDB's $mod takes a long's; otherwise both are numbers.
        const lv = x(), rv = y();
        if (typeof lv === 'bigint' && typeof rv === 'bigint') { if (rv === 0n) throw new RangeError('mod by zero.'); return lv % rv; }
        const l = numeric(lv, policy, 'mod operand'); if (l === null) return null;
        const r = numeric(rv, policy, 'mod operand'); if (r === null) return null;
        if (r === 0) throw new RangeError('mod by zero.');
        return l % r;
      }; break;
      case 'add': case 'sub': case 'mul': case 'div': case 'pow': {
        const op = spec.op;
        f = () => {
          const l = numeric(x(), policy, `${op} operand`); if (l === null) return null;
          const r = numeric(y(), policy, `${op} operand`); if (r === null) return null;
          if (op === 'div' && r === 0) throw new RangeError('div by zero.');
          if (op === 'pow') { const v = l ** r; if (Number.isNaN(v)) throw new RangeError(`pow(${l}, ${r}) is not a real number.`); return finite(v, op); }
          return finite(op === 'add' ? l + r : op === 'sub' ? l - r : op === 'mul' ? l * r : l / r, op);
        };
        break;
      }
      case 'sqrt': case 'ln': case 'exp': {
        const op = spec.op;
        f = () => {
          const n = numeric(x(), policy, `${op} operand`); if (n === null) return null;
          if (op === 'sqrt') { if (n < 0) throw new RangeError('sqrt() of a negative number.'); return Math.sqrt(n); }
          if (op === 'ln') { if (n <= 0) throw new RangeError('ln() needs a positive number.'); return Math.log(n); }
          return finite(Math.exp(n), op);
        };
        break;
      }
      case 'bitAnd': case 'bitOr': case 'bitXor': {
        const op = spec.op;
        f = () => {
          let acc: number | bigint | null = null;
          for (const g of a) {
            const v = integer(g(), policy, `${op}()`); if (v === null) return null;
            if (acc === null) { acc = v; continue; }
            if (typeof acc !== typeof v) { if (policy.invalidNumbers === 'skip') return null; throw new TypeError(`${op}() needs all numbers or all BigInts.`); }
            acc = bitwise(op, acc, v);
          }
          return acc;
        };
        break;
      }
      case 'bitNot': f = () => { const v = integer(x(), policy, 'bitNot()'); return v === null ? null : typeof v === 'bigint' ? ~v : (v | 0) === v ? ~v : -v - 1; }; break;
      case 'least': case 'greatest': {
        const sign = spec.op === 'least' ? -1 : 1;
        // Nullish and invalid operands are skipped, as min and max skip them; ties keep the first.
        f = () => { let best: unknown = null, seen = false; for (const g of a) { const v = g(); if (invalidValue(v)) continue; if (!seen || ops.compare(v, best) * sign > 0) { best = v; seen = true; } } return best; };
        break;
      }
      case 'coalesce': f = () => { let value: unknown; for (const g of a) { value = g(); if (value !== null && value !== undefined) return value; } return value; }; break;
      case 'eq': f = () => ops.equal(x(), y()); break;
      case 'in': {
        // A literal list of more than 16 primitives becomes a Set, as the in filter does: SameValueZero is their equality.
        const listed = nodes[spec.args[1]].value;
        const set = nodes[spec.args[1]].op === 'literal' && Array.isArray(listed) && listed.length > 16 && listed.every(v => v === null || typeof v !== 'object') ? new Set(listed) : undefined;
        f = set ? () => set.has(x()) : () => { const v = x(), list = y(); return Array.isArray(list) && list.some(item => ops.equal(v, item)); };
        break;
      }
      case 'contains': f = () => { const v = x(), w = y(); return typeof v === 'string' && typeof w === 'string' ? v.includes(w) : Array.isArray(v) && v.some(item => ops.equal(item, w)); }; break;
      case 'startsWith': f = () => { const v = x(), w = y(); return typeof v === 'string' && typeof w === 'string' && v.startsWith(w); }; break;
      case 'endsWith': f = () => { const v = x(), w = y(); return typeof v === 'string' && typeof w === 'string' && v.endsWith(w); }; break;
      case 'typeOf': f = () => typeName(x()); break;
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
      case 'epochMs': f = () => instant(x(), policy, 'epochMs()'); break;
      case 'toDate': f = () => { const t = instant(x(), policy, 'toDate()'); return t === null ? null : new Date(t); }; break;
      case 'dateTrunc': case 'datePart': {
        const op = spec.op, unit = spec.unit!, zone = spec.zone!, bin = spec.binSize ?? 1, weekStart = spec.weekStart ?? 0;
        f = op === 'dateTrunc'
          ? () => {
            const t = instant(x(), policy, 'dateTrunc()'); if (t === null) return null;
            // The start of a period can lie before the first valid Date.
            const start = truncate(t, unit as DateUnit, zone, bin, weekStart);
            return Math.abs(start) <= DATE_RANGE ? new Date(start) : null;
          }
          : () => { const t = instant(x(), policy, 'datePart()'); return t === null ? null : part(t, unit as DatePart, zone); };
        break;
      }
      case 'dateAdd': {
        const unit = spec.unit as SpanUnit, zone = spec.zone!;
        f = () => {
          const t = instant(x(), policy, 'dateAdd()'); if (t === null) return null;
          const n = numeric(y(), policy, 'dateAdd() amount'); if (n === null) return null;
          if (!Number.isSafeInteger(n)) { if (policy.invalidNumbers === 'skip') return null; throw new TypeError(`dateAdd() amount must be an integer; got ${n}.`); }
          const result = add(t, unit, n, zone);
          if (!(Math.abs(result) <= DATE_RANGE)) throw new RangeError('dateAdd() result lies outside the Date range.');
          return new Date(result);
        };
        break;
      }
      case 'dateDiff': {
        const unit = spec.unit as SpanUnit, zone = spec.zone!, weekStart = spec.weekStart ?? 0;
        f = () => {
          const s = instant(x(), policy, 'dateDiff() start'); if (s === null) return null;
          const e = instant(y(), policy, 'dateDiff() end'); if (e === null) return null;
          return diff(s, e, unit, zone, weekStart);
        };
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
      case 'split': f = () => {
        const v = text(x(), 'split()'); if (v === null) return null;
        const separator = text(y(), 'split() separator'); if (separator === null) return null;
        if (!separator) throw new TypeError('split() needs a nonempty separator.');
        return v.split(separator);
      }; break;
      case 'replaceAll': { const z = a[2]; f = () => {
        const v = text(x(), 'replaceAll()'); if (v === null) return null;
        const find = text(y(), 'replaceAll() find'); if (find === null) return null;
        const replacement = text(z(), 'replaceAll() replacement'); if (replacement === null) return null;
        if (!find) throw new TypeError('replaceAll() needs a nonempty find string.');
        // split and join, not String.prototype.replaceAll, which would read $& and $1 in the replacement as patterns.
        return v.split(find).join(replacement);
      }; break; }
      case 'indexOf': f = () => {
        const v = text(x(), 'indexOf()'); if (v === null) return null;
        const search = text(y(), 'indexOf() search'); if (search === null) return null;
        const at = v.indexOf(search);
        return at < 0 ? -1 : codePoints(v.slice(0, at));
      }; break;
      case 'toText': f = () => {
        const v = x();
        if (v === null || v === undefined) return null;
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
        throw new TypeError(`toText() needs a string, number, BigInt, Boolean or Date; got ${describe(v)}.`);
      }; break;
      case 'parseNumber': f = () => {
        const v = x();
        if (v === null || v === undefined) return null;
        if (typeof v === 'string') { const s = v.trim(); if (DECIMAL.test(s)) { const n = Number(s); if (Number.isFinite(n)) return n; } }
        else if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (policy.invalidNumbers === 'skip') return null;
        throw new TypeError(`parseNumber() needs a decimal number or a numeric string; got ${typeof v === 'string' ? JSON.stringify(v) : describe(v)}.`);
      }; break;
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
    // A node that reads an element changes within one row, so only element-free nodes are memoized per row.
    evals[id] = spec.refs > 1 && spec.op !== 'literal' && !spec.free ? () => {
      if (stamp[id] === ctx.epoch) return memo[id];
      const value = f(); memo[id] = value; stamp[id] = ctx.epoch; return value;
    } : f;
  }
  return evals;
}
export { boolean as requireBoolean };
