import { orderingSatisfies } from '../query.js';
import { abort, cleanup, DataviewError, estimateRowBytes, natural, resolveOptions, yieldToHost } from '../stream/common.js';
import { readBatches, validateSession } from '../stream/driver.js';
import type { BatchReader } from '../stream/driver.js';
import { fieldColumns } from '../stream/field-capability.js';
import type { FieldLease } from '../stream/key-cache.js';
import { TopK } from '../stream/heap.js';
import type { RecordSession, RecordSource, StreamOptions } from '../stream/types.js';
import { DistinctValues, Ledger, retainedBytes, StateColumns } from './aggregate.js';
import type { Plan } from './compile.js';
import { instantiate, requireBoolean } from './expressions.js';
import type { RowContext } from './expressions.js';
import { GroupTable, MAX_GROUP_ID } from './group-table.js';
import { absorb, exportPartial, MergeInput, requireMergeable } from './partial.js';
import type { ComputeOptions, ComputeStrategy, ComputeSummary, Page, PartialAggregate, PartialOptions } from './types.js';

type Event = { type: 'batch'; rows: readonly object[] } | { type: 'complete'; summary: ComputeSummary; totals?: object; partial?: PartialAggregate };
const MiB = 1024 * 1024;

export function resolveCompute<T extends object>(options: ComputeOptions<T>) {
  if (typeof options !== 'object' || options === null) throw new TypeError('options must be an object.');
  const base = resolveOptions(options as StreamOptions<T>);
  const o = {
    ...base,
    maxWorkingBytes: natural(options.maxWorkingBytes ?? 64 * MiB, 'maxWorkingBytes'),
    maxGroups: natural(options.maxGroups ?? 100_000, 'maxGroups'),
    maxOutputRows: natural(options.maxOutputRows ?? 100_000, 'maxOutputRows'),
    maxOutputBytes: natural(options.maxOutputBytes ?? 64 * MiB, 'maxOutputBytes'),
    sizeOfOutput: options.sizeOfOutput ?? estimateRowBytes,
    profile: options.profile ?? false,
  };
  if (o.maxGroups > MAX_GROUP_ID) throw new RangeError(`maxGroups must be at most ${MAX_GROUP_ID}.`);
  if (typeof o.sizeOfOutput !== 'function') throw new TypeError('sizeOfOutput must be a function.');
  if (typeof o.profile !== 'boolean') throw new TypeError('profile must be boolean.');
  return o;
}

/**
 * Run a prepared plan once: one snapshot, one validated scan, one cleanup. The generator is created synchronously,
 * so option and page errors surface before a source opens; nothing is shared with other executions of the plan.
 * Two stage modes reuse the same state and output code: `partial` scans into groups and states and completes with
 * their export instead of output, and a MergeInput replaces the scan by folding partials into fresh groups and states.
 * VERIFIED: src/compute/compute.test.ts and src/compute/oracle.test.ts cover the three plan kinds against an independent
 * oracle; src/compute/partial.test.ts and oracle.test.ts cover partial and merge.
 */
export function execute<T extends object>(plan: Plan, input: RecordSource<T> | MergeInput, page: Page = {}, options: ComputeOptions<T> = {}, onBatch?: (bytes: number) => void, partial = false): AsyncGenerator<Event> {
  if (typeof page !== 'object' || page === null) throw new TypeError('page must be an object.');
  const o = resolveCompute(options);
  const offset = natural(page.offset ?? 0, 'offset');
  const limit = page.limit === undefined ? undefined : natural(page.limit, 'limit');
  const end = limit === undefined ? Infinity : natural(offset + limit, 'offset + limit');
  const merging = input instanceof MergeInput ? input as MergeInput : undefined;
  return run();

  async function* run(): AsyncGenerator<Event> {
    abort(o.signal);
    const session = merging ? undefined : await (input as RecordSource<T>).open({ signal: o.signal }) as RecordSession<T>;
    let reader: BatchReader<T> | undefined, lease: FieldLease | undefined;
    let failure: { error: unknown } | undefined, summary: ComputeSummary | undefined, totals: object | undefined, exported: PartialAggregate | undefined;
    const ledger = new Ledger(o.maxWorkingBytes);
    try {
      abort(o.signal);
      if (session) validateSession(session);
      lease = session && plan.fields.length ? fieldColumns(session)?.(plan.fields, o.signal) : undefined;
      const reads = o.profile ? { count: 0 } : undefined;
      const ctx: RowContext = { row: {}, ordinal: 0, epoch: 0 };
      const leased = lease;
      const evals = instantiate(plan.nodes, ctx, plan.ops, plan.policy, leased?.columns.size ? { begin: leased.begin, get: f => leased.columns.get(f)?.values } : undefined, reads);
      const where = plan.where === undefined ? undefined : evals[plan.where];
      const filters = plan.filters;
      const states = plan.states.map(spec => new StateColumns(spec, ledger, plan.numberMode, plan.byValue));
      const updates = states.map(column => {
        const { kind, arg: argId, where: predId } = column.spec;
        const arg = argId === undefined ? undefined : evals[argId], pred = predId === undefined ? undefined : evals[predId];
        const { policy, ops } = plan;
        const step: (gid: number) => void = kind === 'rows' ? gid => column.countRow(gid)
          : kind === 'count' ? gid => column.countValue(gid, arg!())
          : kind === 'sum' ? gid => column.addNumber(gid, arg!(), policy)
          : kind === 'sumBigInt' ? gid => column.addBigInt(gid, arg!(), policy)
          : kind === 'distinct' ? gid => column.addDistinct(gid, arg!())
          : kind === 'values' ? gid => column.addValue(gid, arg!(), policy)
          : gid => column.addOrdered(gid, arg!(), ops);
        // Unconditional measures skip the predicate wrapper entirely.
        return pred ? (gid: number) => { if (requireBoolean(pred(), 'measure where')) step(gid); } : step;
      });
      const [only] = updates;
      const update = updates.length === 1 ? only : (gid: number) => { for (let i = 0; i < updates.length; i++) updates[i](gid); };
      const ensure = (gid: number) => { for (let i = 0; i < states.length; i++) states[i].ensure(gid); };

      // Output batches: sized by sizeOfOutput, split by batchSize and maxBatchBytes.
      let out: object[] = [], outBytes = 0, peakOutputBytes = 0, returned = 0;
      const flush = function* (): Generator<Event> {
        if (!out.length) return;
        peakOutputBytes = Math.max(peakOutputBytes, outBytes);
        onBatch?.(outBytes);
        const rows = out; out = []; outBytes = 0;
        yield { type: 'batch', rows };
      };
      const emit = function* (row: object): Generator<Event> {
        const size = natural(o.sizeOfOutput(row), 'sizeOfOutput(row)');
        if (size > o.maxBatchBytes) throw new DataviewError('LIMIT_EXCEEDED', 'An output row exceeds maxBatchBytes.');
        if (out.length && outBytes + size > o.maxBatchBytes) yield* flush();
        out.push(row); outBytes += size; returned++;
        if (out.length === o.batchSize) yield* flush();
      };
      const project = (): object => {
        const row: Record<string, unknown> = {};
        for (const { alias, id } of plan.select) row[alias] = evals[id]();
        return row;
      };

      // Strategy, chosen per execution from the session's capabilities.
      const rowsLike = plan.kind !== 'aggregate';
      const sortRows = rowsLike && plan.rowOrder.length > 0 && !(plan.rowOrdering && orderingSatisfies(session!.ordering, plan.rowOrdering));
      const columnsFor = plan.groupFields?.map(field => lease?.columns.get(field));
      // A partial keeps every group for the merge, so it never runs the one-live-group strategy.
      const orderedGroups = !partial && plan.kind === 'aggregate' && !!plan.groupFields && !!columnsFor?.every(c => c && c.domain !== 'mixed')
        && session?.ordering?.comparisonId === 'dataview-order-v1:code-unit'
        && sameFields(session.ordering.sorters.slice(0, plan.groupFields.length).map(s => s.field), plan.groupFields);
      const firstSeen = !merging && plan.kind === 'aggregate' && plan.groupBy.length > 0 && !plan.measures.length && !plan.having && !plan.outputOrder.length && o.count !== 'exact' && limit !== undefined;
      const strategy: ComputeStrategy = rowsLike ? (sortRows ? (limit === undefined ? 'sort' : 'top-k') : plan.rowOrder.length ? 'ordered' : 'scan')
        : merging ? 'merge' : !plan.groupBy.length ? 'scalar' : orderedGroups ? 'ordered-groups' : firstSeen ? 'first-seen' : 'hash';

      // Row candidates for sorted row/view plans: source reference, ordinal, sort keys, accounted size.
      type Candidate = { row: object; ordinal: number; keys: unknown[]; size: number };
      const signs = plan.rowOrder.map(r => r.sign), keyEvals = plan.rowOrder.map(r => evals[r.id]);
      const compareKeys = (a: readonly unknown[], b: readonly unknown[]) => {
        for (let k = 0; k < signs.length; k++) { const c = plan.ops.compare(a[k], b[k]); if (c) return c * signs[k]; }
        return 0;
      };
      const compareCandidates = (a: Candidate, b: Candidate) => compareKeys(a.keys, b.keys) || a.ordinal - b.ordinal;
      const heap = sortRows ? new TopK<Candidate>(end, compareCandidates) : undefined;
      const scratchKeys: unknown[] = Array.from({ length: signs.length });

      // Groups.
      const groupEvals = plan.groupBy.map(g => evals[g.id]);
      const tuple: unknown[] = Array.from({ length: groupEvals.length });
      const table = plan.kind === 'aggregate' && plan.groupBy.length && !orderedGroups ? new GroupTable(groupEvals.length, plan.byValue, ledger, o.maxGroups) : undefined;
      const aliases = [...plan.groupBy.map(g => g.alias), ...plan.measures.map(m => m.alias)];
      const finalize = (gid: number, keys: (k: number) => unknown): unknown[] => {
        const values = Array.from({ length: aliases.length });
        for (let k = 0; k < plan.groupBy.length; k++) values[k] = keys(k);
        plan.measures.forEach((m, i) => { values[plan.groupBy.length + i] = states[m.state].final(gid, m.op, m.p); });
        return values;
      };
      const scratch: Record<string, unknown> = {};
      const passes = (values: readonly unknown[]) => {
        if (!plan.having) return true;
        for (let i = 0; i < aliases.length; i++) scratch[aliases[i]] = values[i];
        return plan.having.matches(scratch);
      };
      const orderIndexes = plan.outputOrder.map(order => ({ index: aliases.indexOf(order.alias), sign: order.sign }));
      type Group = { seq: number; values: unknown[]; bytes: number };
      const compareGroups = (a: Group, b: Group) => {
        for (const { index, sign } of orderIndexes) { const c = plan.ops.compare(a.values[index], b.values[index]); if (c) return c * sign; }
        return a.seq - b.seq;
      };
      // Ordered groups: one live group in slot 0, finalized when the certified key tuple changes.
      const selection = orderIndexes.length ? new TopK<Group>(end, compareGroups) : undefined;
      const kept: Group[] = [];
      let passing = 0, sequence = 0, live = false;
      const current: unknown[] = Array.from({ length: groupEvals.length });
      const retain = (values: unknown[]) => {
        if (!passes(values)) return;
        const index = passing++;
        if (selection) {
          if (!selection.capacity) return;
          const group: Group = { seq: sequence - 1, values, bytes: 32 + values.reduce<number>((sum, value) => sum + retainedBytes(value), 0) };
          if (selection.items.length >= selection.capacity && compareGroups(group, selection.items[0]) >= 0) return;
          ledger.reserve(group.bytes);
          const evicted = selection.addAccepted(group);
          if (evicted) ledger.release(evicted.bytes);
        } else if (index >= offset && index < end) {
          const group: Group = { seq: index, values, bytes: 32 + values.reduce<number>((sum, value) => sum + retainedBytes(value), 0) };
          ledger.reserve(group.bytes); kept.push(group);
        }
      };
      const closeGroup = () => {
        if (!live) return;
        retain(finalize(0, k => current[k]));
        for (const s of states) s.reset(0);
      };
      if (plan.kind !== 'rows' && (!plan.groupBy.length || orderedGroups)) ensure(0);

      const mustExhaust = plan.kind !== 'rows' || o.count === 'exact';
      let scanned = 0, matched = 0, exhausted = false, more = false;
      const count = session?.count;
      // One comparison per row enforces the scan budget, the exact source count and the safe-integer counter.
      const bound = Math.min(o.maxScannedRows ?? Infinity, count ?? Infinity, Number.MAX_SAFE_INTEGER);
      const overrun = () => {
        if (o.maxScannedRows !== undefined && scanned >= o.maxScannedRows) return new DataviewError('LIMIT_EXCEEDED', 'Query scan budget exhausted.');
        if (count !== undefined) return new DataviewError('SOURCE_CONTRACT', 'Source emitted more rows than its exact count.');
        return new RangeError('scanned rows exceeds Number.MAX_SAFE_INTEGER.');
      };
      const signal = o.signal, pending: object[] = [];
      const groupWidth = groupEvals.length, grouped = groupWidth > 0, view = plan.kind === 'view';
      // each() keys: the row joins the group of every combination of their distinct elements, in element order.
      // Duplicates within one array are dropped under the group equality; that transient set is not working memory.
      const unwind = plan.unwind, elements: unknown[][] = unwind.map(() => []), scratchLedger = new Ledger(Infinity);
      const place = (): boolean => {
        const before = table!.size, gid = table!.find(tuple);
        if (gid === before) {
          if (firstSeen && table!.size > end) { more = true; return false; }
          ensure(gid);
        }
        update(gid);
        return true;
      };
      const fanOut = (u: number): boolean => {
        if (u === unwind.length) return place();
        const k = unwind[u];
        if (u === 0) for (let w = 0; w < unwind.length; w++) {
          const value = tuple[unwind[w]];
          if (!Array.isArray(value)) elements[w] = [value];
          else if (value.length < 2) elements[w] = value;
          else {
            const seen = new DistinctValues(plan.byValue);
            for (const item of value) seen.add(item, scratchLedger);
            scratchLedger.release(seen.bytes - DistinctValues.BYTES);
            elements[w] = seen.items;
          }
        }
        for (const item of elements[u]) { tuple[k] = item; if (!fanOut(u + 1)) return false; }
        return true;
      };
      // The per-batch kernel is a plain synchronous function, so the engine optimizes it apart from the async
      // generator around it. Unsorted row output is queued in `pending` (at most one input batch) and emitted after.
      const consume = (rows: readonly object[], start: number, length: number, size: (index: number) => number): boolean => {
        for (let i = 0; i < length; i++) {
          if (signal?.aborted) abort(signal);
          if (scanned >= bound) throw overrun();
          const row = rows[start + i];
          scanned++;
          if (filters && !filters.matches(row)) continue;
          ctx.row = row; ctx.ordinal = scanned - 1; ctx.epoch++;
          if (where && !requireBoolean(where(), 'where')) continue;
          matched++;
          if (view) update(0);
          if (rowsLike) {
            if (heap) {
              if (!heap.capacity) continue;
              for (let k = 0; k < keyEvals.length; k++) scratchKeys[k] = keyEvals[k]();
              if (heap.items.length >= heap.capacity && (compareKeys(scratchKeys, heap.items[0].keys) || 1) > 0) continue;
              const bytes = size(i) + 32 + 8 * scratchKeys.length;
              ledger.reserve(bytes);
              const evicted = heap.addAccepted({ row, ordinal: scanned - 1, keys: scratchKeys.slice(), size: bytes });
              if (evicted) ledger.release(evicted.size);
            } else if (matched > offset && matched <= end) pending.push(project());
            else if (matched > end) { more = true; if (!mustExhaust) return false; }
            continue;
          }
          if (!grouped) { update(0); continue; }
          for (let k = 0; k < groupWidth; k++) tuple[k] = groupEvals[k]();
          if (orderedGroups) {
            let same = live;
            for (let k = 0; same && k < groupWidth; k++) same = plan.ops.equal(tuple[k], current[k]);
            if (!same) {
              closeGroup();
              for (let k = 0; k < groupWidth; k++) current[k] = tuple[k];
              live = true; sequence++;
            }
            update(0);
            continue;
          }
          if (unwind.length) { if (!fanOut(0)) return false; continue; }
          const before = table!.size, gid = table!.find(tuple);
          if (gid === before) {
            if (firstSeen && table!.size > end) { more = true; return false; }
            ensure(gid);
          }
          update(gid);
        }
        return true;
      };
      if (merging) { ({ scanned, matched } = await absorb(merging, plan, table, states, ensure, o.signal)); exhausted = true; }
      else reader = readBatches(session!, o);
      while (reader) {
        const span = await reader.next();
        if (!span) { exhausted = true; break; }
        const proceed = consume(span.rows, span.start, span.length, span.size);
        if (pending.length) { const queued = pending.splice(0); for (const row of queued) yield* emit(row); }
        if (!proceed) break;
      }
      if (exhausted && count !== undefined && scanned !== count) throw new DataviewError('SOURCE_CONTRACT', 'Source ended before its exact count.');

      let totalResultRows: number | null = null, peakGroups = 0;
      if (rowsLike) {
        if (heap) {
          const winners = heap.items.sort(compareCandidates);
          more = matched > end;
          for (let i = offset; i < Math.min(end, winners.length); i++) {
            abort(o.signal);
            const { row, ordinal } = winners[i];
            ctx.row = row; ctx.ordinal = ordinal; ctx.epoch++;
            yield* emit(project());
          }
        }
        if (exhausted) totalResultRows = matched;
        if (plan.kind === 'view') totals = Object.fromEntries(plan.measures.map(m => [m.alias, states[m.state].final(0, m.op, m.p)]));
      } else if (partial) {
        exported = exportPartial(plan, session!.revision, scanned, matched, table, states, ledger);
      } else {
        if (orderedGroups) { closeGroup(); peakGroups = sequence ? 1 : 0; }
        else {
          const groups = table ? table.size : 1;
          peakGroups = table ? groups : 1;
          for (let gid = 0; gid < groups; gid++) {
            if (gid && gid % 4096 === 0) { abort(o.signal); if (gid % 65536 === 0) await yieldToHost(); }
            sequence = gid + 1;
            retain(finalize(gid, k => table!.keys[k][gid]));
            if (firstSeen && passing >= end) break;
          }
        }
        const chosen = selection ? selection.items.sort(compareGroups).slice(offset) : kept;
        totalResultRows = firstSeen && more ? null : passing;
        more = more || passing > end;
        for (const group of chosen) {
          abort(o.signal);
          const output: Record<string, unknown> = {};
          for (let i = 0; i < aliases.length; i++) output[aliases[i]] = group.values[i];
          yield* emit(output);
        }
      }
      yield* flush();
      summary = {
        revision: session ? session.revision : merging!.revision, sourceRows: count ?? (exhausted ? scanned : null), scannedRows: scanned,
        observedInputMatches: matched, totalInputMatches: exhausted ? matched : null, totalResultRows, returnedRows: returned,
        hasMore: more, sourceExhausted: exhausted, strategy, executionComplete: true,
        peakWorkingBytes: ledger.peak, peakOutputBytes, peakGroups, cacheBytesPinned: lease?.pinnedBytes ?? 0, cacheBuilds: 0, prunedRows: 0,
        fieldReads: reads ? reads.count : null,
      };
    } catch (error) { failure = { error }; throw error; }
    finally {
      await cleanup([async () => { lease?.release(); }, async () => reader?.close(), async () => session?.close()], failure);
    }
    abort(o.signal);
    yield plan.kind === 'view' ? { type: 'complete', summary: summary!, totals: totals! } : exported ? { type: 'complete', summary: summary!, partial: exported } : { type: 'complete', summary: summary! };
  }
}

function sameFields(prefix: readonly string[], fields: readonly string[]): boolean {
  return prefix.length === fields.length && fields.every(f => prefix.includes(f)) && new Set(fields).size === fields.length;
}

/** One partial scan: the whole source part, no page, completed with the exported groups and states. */
export async function partialOf<T extends object>(plan: Plan, source: RecordSource<T>, options: PartialOptions<T> = {}): Promise<PartialAggregate> {
  requireMergeable(plan);
  let exported: PartialAggregate | undefined;
  for await (const event of execute(plan, source, {}, options, undefined, true)) if (event.type === 'complete') exported = event.partial;
  return exported!;
}

/** Collect under maxOutputRows/maxOutputBytes; streaming consumers bound output themselves. */
export async function collect<T extends object>(plan: Plan, source: RecordSource<T> | MergeInput, page: Page = {}, options: ComputeOptions<T> = {}): Promise<{ rows: object[]; totals?: object; summary: ComputeSummary }> {
  const o = resolveCompute(options);
  let batchBytes = 0, bytes = 0;
  const rows: object[] = [];
  const iterator = execute(plan, source, page, options, measured => { batchBytes = measured; });
  let failure: { error: unknown } | undefined, done: { summary: ComputeSummary; totals?: object } | undefined;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (event.type === 'complete') { done = event; continue; }
      if (rows.length + event.rows.length > o.maxOutputRows || bytes + batchBytes > o.maxOutputBytes) throw new DataviewError('LIMIT_EXCEEDED', 'Collected output exceeds maxOutputRows or maxOutputBytes. Use stream().');
      for (const row of event.rows) rows.push(row);
      bytes += batchBytes;
    }
    if (!done) throw new DataviewError('SOURCE_CONTRACT', 'Compute ended without a completion summary.');
    const summary = { ...done.summary, peakOutputBytes: bytes };
    return done.totals === undefined ? { rows, summary } : { rows, totals: done.totals, summary };
  } catch (error) { failure = { error }; throw error; }
  finally { await cleanup([() => iterator.return(undefined)], failure); }
}
