import type { CompiledQuery, QueryDescriptor } from '../query.js';
import { compileQuery, orderingSatisfies } from '../query.js';
import type { DataviewRow, DataviewState } from '../types.js';
import { measuredScan } from './measured.js';
import type { MeasuredBatch } from './measured.js';
import { TopK } from './heap.js';
import { queryKeys } from './key-capability.js';
import { projectionPlan } from './projection.js';
import { validateSession } from './driver.js';
import type { QueryKeyLease } from './key-cache.js';
import { abort, cleanup, DataviewError, natural, resolveOptions, rowBytes, yieldToHost } from './common.js';
import type { QueryEvent, QuerySummary, RecordSource, StreamOptions, StreamRequest, StreamResult } from './types.js';

/** Convert table state to a stream query. Hierarchy traversal requires an array or graph planner. */
export function toStreamRequest(view: DataviewState): StreamRequest {
  if (view.tree) throw new TypeError('Streaming queries operate on flat records; project the hierarchy first.');
  return { filters: view.filters, sorters: view.sorters, semantics: view.semantics, offset: view.pageSize === undefined ? 0 : view.page * view.pageSize, limit: view.pageSize };
}

/**
 * A lazy, pull-based query. Configuration is compiled now; the snapshot opens on
 * first pull. Batch events are provisional until the complete event, which is
 * emitted only after both the scan and owned session have been closed.
 */
export function streamQuery<T extends DataviewRow>(source: RecordSource<T>, request: StreamRequest = {}, options: StreamOptions<T> = {}): AsyncGenerator<QueryEvent<T>> {
  return executeQuery(source, request, options);
}

// Only the collector receives this private byte handoff. Public batch events carry
// no trusted metadata; external sources always pass independent validation.
function executeQuery<T extends DataviewRow>(source: RecordSource<T>, request: StreamRequest, options: StreamOptions<T>, onBatch?: (bytes: number) => void, compiled?: CompiledQuery): AsyncGenerator<QueryEvent<T>> {
  if ('tree' in request && request.tree !== undefined) throw new TypeError('Streaming hierarchy evaluation is not supported.');
  const query = compiled ?? compileQuery(request), o = resolveOptions(options);
  const offset = natural(request.offset ?? 0, 'offset');
  const limit = request.limit === undefined ? undefined : natural(request.limit, 'limit');
  const end = limit === undefined ? Infinity : natural(offset + limit, 'offset + limit');
  async function* execute(): AsyncGenerator<QueryEvent<T>> {
    abort(o.signal);
    const session = await source.open({ signal: o.signal });
    let iterator: AsyncIterator<readonly T[] | MeasuredBatch<T>> | undefined;
    let failure: { error: unknown } | undefined;
    let summary: QuerySummary | undefined;
    let keys: QueryKeyLease | undefined;
    try {
      abort(o.signal);
      validateSession(session);
      const ordered = orderingSatisfies(session.ordering, query.ordering);
      const sort = query.ordering.sorters.length > 0 && !ordered;
      if (sort && limit !== undefined && end > o.maxBufferedRows) throw new DataviewError('LIMIT_EXCEEDED', 'offset + limit exceeds the top-k row budget.');
      const acquireKeys = (sort && end > 0) || query.hasFilters ? queryKeys(session) : undefined;
      if (acquireKeys) keys = await acquireKeys(query, o.signal, sort && end > 0);
      abort(o.signal);
      type Candidate = { row: T; ordinal: number; size: number };
      const indexedCompare = keys?.compare;
      const compare = indexedCompare ? (a: Candidate, b: Candidate) => indexedCompare(a.ordinal - 1, b.ordinal - 1) || a.ordinal - b.ordinal
        : (a: Candidate, b: Candidate) => query.compare(a.row, b.row) || a.ordinal - b.ordinal;
      const heap = sort ? new TopK<Candidate>(limit === undefined ? Infinity : end, compare) : undefined;
      let retainedBytes = 0, peakRows = 0, peakBytes = 0;
      let scanned = 0, matched = 0, returned = 0, batches = 0, exhausted = false, more = false;
      let output: T[] = [], outputBytes = 0;
      // An exact unfiltered source count can answer totals without draining the scan.
      const knownTotal = !query.hasFilters ? session.count : undefined;
      const mustExhaust = o.count === 'exact' && knownTotal === undefined;
      // A bounded page can run over a session's projection: same predicates and comparator over copies of the queried
      // fields, then the stored rows of the returned page only. Not with a key lease, whose ordinals index the source.
      const projected = end !== Infinity && !keys ? projectionPlan(session)?.(query, end, o) : undefined;
      const measured = projected ? projected.scan.bind(projected) : measuredScan(session);
      iterator = (measured ? measured(o) : session.scan(o))[Symbol.asyncIterator]();
      // Returned rows are the stored ones: re-measured and re-split under the same output budgets. VERIFIED: the DBSONL
      // projection tests split 900-byte stored rows behind 30-byte copies into several batches under maxBatchBytes.
      const emit = async function* (rows: T[], bytes: number): AsyncGenerator<QueryEvent<T>> {
        if (!projected) { onBatch?.(bytes); yield { type: 'batch', rows }; return; }
        const stored = await projected.materialize(rows, o.signal);
        abort(o.signal);
        if (!Array.isArray(stored) || stored.length !== rows.length) throw new DataviewError('SOURCE_CONTRACT', 'A projection returned the wrong number of stored rows.');
        let batch: T[] = [], size = 0;
        for (const row of stored) {
          const rowSize = rowBytes(row, o);
          if (batch.length && size + rowSize > o.maxBatchBytes) { onBatch?.(size); yield { type: 'batch', rows: batch }; batch = []; size = 0; abort(o.signal); }
          batch.push(row); size += rowSize;
        }
        onBatch?.(size); yield { type: 'batch', rows: batch };
      };
      // Reused only for external batches; never retained after a batch is processed.
      const validatedSizes: number[] = [];
      scan: for (;;) {
        if (batches > 0 && o.yieldEveryBatches > 0 && batches % o.yieldEveryBatches === 0) await yieldToHost();
        abort(o.signal);
        const next = await iterator.next();
        abort(o.signal);
        if (next.done) { exhausted = true; break; }
        const batch = measured ? (next.value as MeasuredBatch<T>).rows : next.value as readonly T[]; batches++;
        if (!Array.isArray(batch)) throw new DataviewError('SOURCE_CONTRACT', 'Source emitted an invalid batch.');
        const start = measured ? (next.value as MeasuredBatch<T>).offset ?? 0 : 0;
        const length = measured ? (next.value as MeasuredBatch<T>).length ?? batch.length : batch.length;
        if (!Array.isArray(batch) || length === 0 || length > o.batchSize || start < 0 || start + length > batch.length) throw new DataviewError('SOURCE_CONTRACT', 'Source emitted an empty, invalid or oversized batch.');
        // Validate the whole retained input batch, even when pagination stops mid-batch.
        let sizes: ArrayLike<number>;
        if (measured) sizes = (next.value as MeasuredBatch<T>).sizes;
        else {
          let batchBytes = 0;
          for (let i = 0; i < length; i++) {
            const size = rowBytes(batch[i], o);
            validatedSizes[i] = size; batchBytes += size;
          }
          if (batchBytes > o.maxBatchBytes) throw new DataviewError('SOURCE_CONTRACT', 'Source exceeded its batch byte budget.');
          sizes = validatedSizes;
        }
        if (keys?.canSkip?.(scanned, length)) {
          const scanLimit = o.maxScannedRows ?? Infinity, sourceLimit = session.count ?? Infinity;
          if (scanned + length > Math.min(scanLimit, sourceLimit)) {
            if (scanLimit <= sourceLimit) throw new DataviewError('LIMIT_EXCEEDED', 'Query scan budget exhausted.');
            throw new DataviewError('SOURCE_CONTRACT', 'Source emitted more rows than its exact count.');
          }
          natural(scanned += length, 'scanned rows'); keys.skipped(length);
          continue;
        }
        const sizesOffset = measured ? (next.value as MeasuredBatch<T>).sizesOffset ?? 0 : 0;
        const sizeBias = measured ? (next.value as MeasuredBatch<T>).sizeBias ?? 0 : 0;
        for (let i = 0; i < length; i++) {
          abort(o.signal);
          if (o.maxScannedRows !== undefined && scanned >= o.maxScannedRows) throw new DataviewError('LIMIT_EXCEEDED', 'Query scan budget exhausted.');
          const row = batch[start + i], size = sizes[sizesOffset + i] - sizeBias;
          natural(++scanned, 'scanned rows');
          if (session.count !== undefined && scanned > session.count) throw new DataviewError('SOURCE_CONTRACT', 'Source emitted more rows than its exact count.');
          if (!query.matches(row)) continue;
          matched++;
          if (sort) {
            // Later equal rows lose the stable tie: compare raw rows before
            // allocating a candidate, then admit it exactly once.
            if (heap!.capacity > 0 && (heap!.items.length < heap!.capacity || (indexedCompare ? indexedCompare(scanned - 1, heap!.items[0].ordinal - 1) : query.compare(row, heap!.items[0].row)) < 0)) {
              const candidateSize = size + 32;
              const evicted = heap!.items.length === heap!.capacity ? heap!.items[0] : undefined;
              // Subtract before adding: an intermediate sum above MAX_SAFE_INTEGER
              // can round down even when both old and new totals are exact integers.
              const nextBytes = retainedBytes - (evicted?.size ?? 0) + candidateSize;
              const nextRows = heap!.items.length + (evicted ? 0 : 1);
              if (nextRows > o.maxBufferedRows || nextBytes > o.maxBufferedBytes) throw new DataviewError('LIMIT_EXCEEDED', 'Sorted candidates exceed the retention budget.');
              // Recycle only after admission: rejection must not mutate retained
              // rows or erase the evicted size needed for safe-integer accounting.
              const candidate = evicted ?? { row, ordinal: scanned, size: candidateSize };
              if (evicted) { candidate.row = row; candidate.ordinal = scanned; candidate.size = candidateSize; }
              heap!.addAccepted(candidate); retainedBytes = nextBytes;
              peakRows = Math.max(peakRows, nextRows); peakBytes = Math.max(peakBytes, nextBytes);
            }
          } else if (matched > offset && matched <= end) {
            if (output.length && outputBytes + size > o.maxBatchBytes) {
              yield* emit(output, outputBytes); output = []; outputBytes = 0; abort(o.signal);
            }
            output.push(row); outputBytes += size; returned++;
            peakRows = Math.max(peakRows, output.length); peakBytes = Math.max(peakBytes, outputBytes);
            if (output.length === o.batchSize) { yield* emit(output, outputBytes); output = []; outputBytes = 0; }
          } else if (matched > end) {
            more = true;
            if (!mustExhaust) break scan;
          }
        }
        // With a trusted exact count and no predicates, no lookahead is necessary.
        if (!sort && knownTotal !== undefined && matched >= end) { more = knownTotal > end; break; }
      }
      if (exhausted && session.count !== undefined && scanned !== session.count) throw new DataviewError('SOURCE_CONTRACT', 'Source ended before its exact count.');
      if (sort) {
        const candidates = heap!.items;
        candidates.sort(compare);
        more = matched > end;
        for (let i = offset; i < Math.min(end, candidates.length); i++) {
          abort(o.signal);
          const { row, size } = candidates[i];
          const payloadSize = size - 32;
          if (output.length && (output.length === o.batchSize || outputBytes + payloadSize > o.maxBatchBytes)) {
            yield* emit(output, outputBytes); output = []; outputBytes = 0; abort(o.signal);
          }
          output.push(row); outputBytes += payloadSize; returned++;
        }
      }
      if (output.length) { yield* emit(output, outputBytes); abort(o.signal); }
      summary = {
        revision: session.revision, sourceRows: session.count ?? (exhausted ? scanned : null),
        totalMatches: exhausted ? matched : knownTotal ?? null,
        scannedRows: scanned, observedMatches: matched, returnedRows: returned,
        sourceExhausted: exhausted, hasMore: more,
        strategy: sort ? limit === undefined ? 'sort' : 'top-k' : query.ordering.sorters.length ? 'ordered' : 'scan',
        peakBufferedRows: peakRows, peakBufferedBytes: peakBytes,
      };
    } catch (error) { failure = { error }; throw error; }
    finally {
      await cleanup([async () => { keys?.release(); }, async () => iterator?.return?.(), () => session.close()], failure);
    }
    abort(o.signal);
    yield { type: 'complete', summary: summary! };
  }
  return execute();
}

/** Collect a bounded result. Use streamQuery when the output itself may exceed memory. */
export async function evaluateStream<T extends DataviewRow>(source: RecordSource<T>, request: StreamRequest = {}, options: StreamOptions<T> = {}): Promise<StreamResult<T>> {
  return collectQuery(source, request, options);
}

async function collectQuery<T extends DataviewRow>(source: RecordSource<T>, request: StreamRequest, options: StreamOptions<T>, compiled?: CompiledQuery): Promise<StreamResult<T>> {
  const o = resolveOptions(options), rows: T[] = [];
  let batchBytes = 0;
  const iterator = executeQuery(source, request, o, measured => { batchBytes = measured; }, compiled);
  let bytes = 0, summary: QuerySummary | undefined;
  let failure: { error: unknown } | undefined;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (event.type === 'complete') summary = event.summary;
      else {
        if (rows.length + event.rows.length > o.maxBufferedRows || bytes + batchBytes > o.maxBufferedBytes) throw new DataviewError('LIMIT_EXCEEDED', 'Collected output exceeds the retention budget. Use streamQuery.');
        for (const row of event.rows) rows.push(row);
        bytes += batchBytes;
      }
    }
    if (!summary) throw new DataviewError('SOURCE_CONTRACT', 'Query ended without a completion summary.');
    return { rows, summary };
  } catch (error) { failure = { error }; throw error; }
  finally {
    // Explicit IteratorClose preserves cleanup failures alongside collector errors;
    // for-await's implicit close can suppress a return() error when its body throws.
    await cleanup([() => iterator.return(undefined)], failure);
  }
}

export interface PreparedStreamQuery<T extends DataviewRow> {
  readonly ordering: CompiledQuery['ordering'];
  stream(source: RecordSource<T>, page?: { offset?: number; limit?: number }, options?: StreamOptions<T>): AsyncGenerator<QueryEvent<T>>;
  evaluate(source: RecordSource<T>, page?: { offset?: number; limit?: number }, options?: StreamOptions<T>): Promise<StreamResult<T>>;
}
/** Capture typed operands/accessors once. Pagination and source lifetime remain per execution. */
export function prepareStreamQuery<T extends DataviewRow>(descriptor: QueryDescriptor = {}): PreparedStreamQuery<T> {
  const query = compileQuery(descriptor);
  return Object.freeze({
    ordering: query.ordering,
    stream: (source: RecordSource<T>, page = {}, options = {}) => executeQuery(source, page, options, undefined, query),
    evaluate: (source: RecordSource<T>, page = {}, options = {}) => collectQuery(source, page, options, query),
  });
}
