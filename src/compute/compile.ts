import { compileQuery } from '../query.js';
import type { CompiledQuery, QueryOrdering } from '../query.js';
import type { DataviewFilter } from '../types.js';
import { createValueOperations } from '../values.js';
import { ExpressionTable } from './expressions.js';
import type { PlanNode } from './expressions.js';
import type { MeasureSpec, StateKind, StateSpec } from './aggregate.js';
import { fingerprint } from './partial.js';
import type { ComputeStrategy, Explain, NumberMode } from './types.js';

export type PlanKind = 'rows' | 'aggregate' | 'view';
/** The immutable, source-independent result of preparing a descriptor; executions only read it. */
export interface Plan {
  readonly kind: PlanKind;
  readonly nodes: readonly PlanNode[];
  readonly fields: readonly string[];
  readonly ops: ReturnType<typeof createValueOperations>;
  readonly byValue: boolean;
  readonly numberMode: NumberMode;
  /** Aggregate plans whose every state merges exactly: no float sum outside numberMode 'exact'. */
  readonly mergeable: boolean;
  /** Descriptor fingerprint that partials carry, so merge() rejects a partial of another plan. */
  readonly signature: string;
  readonly policy: { invalidNumbers: 'error' | 'skip' };
  /** Legacy filters, compiled once with the plan's semantics. */
  readonly filters: CompiledQuery | undefined;
  readonly where: number | undefined;
  readonly select: readonly { alias: string; id: number }[];
  readonly rowOrder: readonly { id: number; sign: number }[];
  /** Set when every row sort key is a plain field: a source ordering that satisfies it lets the scan stop early. */
  readonly rowOrdering: QueryOrdering | undefined;
  readonly groupBy: readonly { alias: string; id: number }[];
  /** Field names of a groupBy made only of plain fields, for the ordered-groups certificate. */
  readonly groupFields: readonly string[] | undefined;
  readonly states: readonly StateSpec[];
  readonly measures: readonly MeasureSpec[];
  readonly having: CompiledQuery | undefined;
  readonly outputOrder: readonly { alias: string; sign: number }[];
  readonly explain: Explain;
}
const SAFE_ALIAS = /^[^.]+$/;
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const KEYS: Record<PlanKind, string[]> = {
  rows: ['select', 'orderBy', 'filters', 'where', 'semantics', 'numberMode', 'invalidNumbers'],
  aggregate: ['groupBy', 'measures', 'having', 'orderBy', 'filters', 'where', 'semantics', 'numberMode', 'invalidNumbers'],
  view: ['select', 'totals', 'orderBy', 'filters', 'where', 'semantics', 'numberMode', 'invalidNumbers'],
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object of aliases.`);
  const proto = Object.getPrototypeOf(value);
  // A literal `{ __proto__: expr }` sets the prototype instead of naming an alias; only plain objects are accepted.
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${name} must be a plain object of aliases.`);
  const entries = Object.entries(value);
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${name} aliases must be strings.`);
  for (const [alias] of entries) if (!alias || !SAFE_ALIAS.test(alias) || UNSAFE.has(alias)) throw new TypeError(`${name}: alias ${JSON.stringify(alias)} must be nonempty, without dots, and not __proto__, prototype or constructor.`);
  return value as Record<string, unknown>;
}

/**
 * Validate and freeze a descriptor once, before any source opens. A per-execution compile would repeat the work and
 * report malformed descriptors mid-scan; a frozen plan instead runs on several sources at once without shared state.
 * VERIFIED: compute.test.ts 'runs one prepared plan concurrently' and the rejection cases, which never open a source.
 */
export function compilePlan(kind: PlanKind, descriptor: unknown): Plan {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) throw new TypeError(`A ${kind} descriptor must be an object.`);
  const d = descriptor as Record<string, unknown>;
  for (const key of Object.keys(d)) if (!KEYS[kind].includes(key)) throw new TypeError(`Unexpected ${kind} descriptor property ${JSON.stringify(key)}.`);
  if (d.numberMode !== undefined && d.numberMode !== 'compensated' && d.numberMode !== 'sequential' && d.numberMode !== 'exact') throw new TypeError('numberMode must be compensated, sequential or exact.');
  const numberMode = (d.numberMode ?? 'compensated') as NumberMode;
  if (d.invalidNumbers !== undefined && d.invalidNumbers !== 'error' && d.invalidNumbers !== 'skip') throw new TypeError('invalidNumbers must be error or skip.');
  const semantics = (d.semantics ?? {}) as object;
  const ops = createValueOperations(semantics);
  const table = new ExpressionTable(ops.equality === 'value');
  const filters = d.filters === undefined ? undefined : compileQuery({ filters: d.filters as DataviewFilter[], semantics });
  const where = d.where === undefined ? undefined : table.add(d.where, 'where');
  if (where !== undefined) table.nodes[where].refs++;
  const named = (value: unknown, name: string) => Object.entries(record(value, name)).map(([alias, raw]) => {
    const id = table.add(raw, `${name}.${alias}`); table.nodes[id].refs++; return { alias, id };
  });
  const select = kind === 'aggregate' ? [] : named(d.select, 'select');
  const groupBy = kind === 'aggregate' && d.groupBy !== undefined ? named(d.groupBy, 'groupBy') : [];
  const rowOrder: { id: number; sign: number; field?: string }[] = [];
  const outputOrder: { alias: string; sign: number }[] = [];
  if (d.orderBy !== undefined) {
    if (!Array.isArray(d.orderBy)) throw new TypeError('orderBy must be an array.');
    d.orderBy.forEach((order: unknown, i) => {
      if (typeof order !== 'object' || order === null) throw new TypeError(`orderBy[${i}] must be an object.`);
      const { direction = 'asc' } = order as { direction?: unknown };
      if (direction !== 'asc' && direction !== 'desc') throw new TypeError(`orderBy[${i}].direction must be asc or desc.`);
      const sign = direction === 'desc' ? -1 : 1;
      if (kind === 'aggregate') {
        const { field } = order as { field?: unknown };
        if (typeof field !== 'string') throw new TypeError(`orderBy[${i}].field must name an output alias.`);
        outputOrder.push({ alias: field, sign });
      } else {
        const id = table.add((order as { expr?: unknown }).expr, `orderBy[${i}].expr`); table.nodes[id].refs++;
        rowOrder.push({ id, sign, field: table.nodes[id].field });
      }
    });
  }
  // States: count(), count(x), sum/avg(x) shared, min, max, sumBigInt; deduplicated by kind, operand and predicate.
  const states: StateSpec[] = [], measures: MeasureSpec[] = [];
  const stateIds = new Map<string, number>();
  const measureSource = kind === 'aggregate' ? d.measures : kind === 'view' ? d.totals : undefined;
  if (measureSource !== undefined) for (const [alias, raw] of Object.entries(record(measureSource, kind === 'view' ? 'totals' : 'measures'))) {
    const m = table.measure(raw, `${kind === 'view' ? 'totals' : 'measures'}.${alias}`);
    const stateKind: StateKind = m.op === 'count' ? (m.arg === undefined ? 'rows' : 'count') : m.op === 'avg' ? 'sum' : m.op as StateKind;
    const key = `${stateKind}:${m.arg ?? ''}:${m.where ?? ''}`;
    let state = stateIds.get(key);
    if (state === undefined) { state = states.length; states.push({ kind: stateKind, arg: m.arg, where: m.where }); stateIds.set(key, state); }
    measures.push({ alias, op: m.op, state });
  }
  if (kind === 'aggregate' && !measures.length && !groupBy.length) throw new TypeError('A global aggregate needs at least one measure.');
  if (kind === 'view' && !measures.length) throw new TypeError('A view needs at least one total.');
  const outputs = new Set<string>();
  for (const alias of [...groupBy.map(g => g.alias), ...(kind === 'aggregate' ? measures.map(m => m.alias) : [])]) {
    if (outputs.has(alias)) throw new TypeError(`Group and measure aliases must differ; ${JSON.stringify(alias)} is used twice.`);
    outputs.add(alias);
  }
  let having: CompiledQuery | undefined;
  if (d.having !== undefined) {
    if (kind !== 'aggregate') throw new TypeError('having applies to aggregate plans.');
    if (!Array.isArray(d.having)) throw new TypeError('having must be an array of filters.');
    for (const filter of d.having as DataviewFilter[]) if (!outputs.has(filter?.field)) throw new TypeError(`having refers to ${JSON.stringify(filter?.field)}, which is not an output alias.`);
    having = compileQuery({ filters: d.having as DataviewFilter[], semantics });
  }
  for (const order of outputOrder) if (!outputs.has(order.alias)) throw new TypeError(`orderBy refers to ${JSON.stringify(order.alias)}, which is not an output alias.`);
  const plainOrder = rowOrder.length && rowOrder.every(o => o.field !== undefined && table.nodes[o.id].op !== 'literal')
    ? compileQuery({ sorters: rowOrder.map(o => ({ field: o.field!, direction: o.sign < 0 ? 'desc' : 'asc' as const })), semantics }).ordering : undefined;
  const groupFields = groupBy.length && groupBy.every(g => table.nodes[g.id].field !== undefined) ? groupBy.map(g => table.nodes[g.id].field!) : undefined;
  const fields = table.fields();
  const mergeable = kind === 'aggregate' && (numberMode === 'exact' || states.every(s => s.kind !== 'sum'));
  const strategies: ComputeStrategy[] = kind === 'rows' || kind === 'view'
    ? (rowOrder.length ? ['top-k', 'sort', ...(plainOrder ? ['ordered' as const] : [])] : ['scan'])
    : groupBy.length ? ['hash', ...(groupFields ? ['ordered-groups' as const] : []), ...(!measures.length && !having && !outputOrder.length ? ['first-seen' as const] : [])] : ['scalar'];
  if (mergeable) strategies.push('merge');
  const notes = [
    'Field reads come from rows, or from source columns that are already built; compute never builds a column.',
    numberMode === 'exact' ? 'Floating-point sums are exact until one final rounding, so they do not depend on order or partitioning.'
      : 'Floating-point sums update in source order; partial sums are never merged.',
    ...(kind === 'aggregate' ? [mergeable ? 'partial() and merge() accept this plan.' : "partial() and merge() need numberMode: 'exact' for sum and avg."] : []),
    ...(kind === 'view' ? ['Totals cover every input match, not only the returned page.'] : []),
    ...(kind === 'aggregate' && groupBy.length ? ['Ordered groups need a source ordering on the group fields and prepared homogeneous columns; otherwise hash grouping runs.'] : []),
  ];
  const explain: Explain = Object.freeze({
    kind, requiredFields: Object.freeze([...fields]),
    operators: Object.freeze([
      'source', ...(filters ? ['filters'] : []), ...(where !== undefined ? ['where'] : []),
      ...(kind === 'aggregate' ? [groupBy.length ? 'group' : 'global', ...(having ? ['having'] : []), ...(outputOrder.length ? ['order'] : []), 'page', 'output']
        : [...(kind === 'view' ? ['totals'] : []), ...(rowOrder.length ? ['order'] : []), 'page', 'project']),
    ]),
    measures: Object.freeze(measures.map(m => Object.freeze({ alias: m.alias, op: m.op, state: m.state }))),
    states: states.length,
    strategies: Object.freeze(strategies),
    notes: Object.freeze(notes),
  });
  return Object.freeze({
    kind, nodes: Object.freeze(table.nodes.map(n => Object.freeze(n))), fields, ops, byValue: ops.equality === 'value',
    numberMode, mergeable, signature: kind === 'aggregate' ? fingerprint(descriptor) : '', policy: { invalidNumbers: (d.invalidNumbers ?? 'error') as 'error' | 'skip' },
    filters, where, select, rowOrder: rowOrder.map(({ id, sign }) => ({ id, sign })), rowOrdering: plainOrder,
    groupBy, groupFields, states, measures, having, outputOrder, explain,
  });
}
