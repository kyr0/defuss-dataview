import { compileQuery } from '../query.js';
import type { CompiledQuery } from '../query.js';
import { queryDetails } from '../query-internals.js';
import { fieldParts } from '../fields.js';
import { batchRows, measuredRows } from '../stream/batches.js';
import { abort, cleanup, DataviewError, estimateRowBytes, natural, resolveOptions, rowBytes } from '../stream/common.js';
import { measuredScan, registerMeasuredScan } from '../stream/measured.js';
import type { MeasuredBatch } from '../stream/measured.js';
import { registerProjection } from '../stream/projection.js';
import type { CancellationSignal, RecordSession, RecordSource, ScanRequest } from '../stream/types.js';
/** Structural interface: no import of DBSONL or any platform backend. */
export type DbsonlRecord<T> = { key: string; value: T; revision: number };
export interface DbsonlSnapshot<T> {
  readonly revision: number;
  readonly count: number;
  scan(options?: { gte?: string; lt?: string; signal?: CancellationSignal }): AsyncIterable<DbsonlRecord<T>>;
  /** Optional native capability; row-only providers retain the streaming fallback. */
  scanBatches?(options?: { gte?: string; lt?: string; limit?: number; signal?: CancellationSignal; batchSize?: number; maxBatchBytes?: number }): AsyncIterable<readonly DbsonlRecord<T>[]>;
  /** Optional point read at the snapshot's revision; a projection needs it to return stored rows. */
  get?(key: string): Promise<{ found: boolean; value?: T; revision?: number }>;
  close(): Promise<void>;
}
/** `at` is the head of a snapshot that is still open, such as defuss-dbsonl's `ReadSession.head`, possibly from another thread. */
export interface DbsonlDatabase<T> { beginRead(options?: { at?: object }): Promise<DbsonlSnapshot<T>> }
export interface DbsonlProjectionOptions {
  /** Field paths to keep, such as `value.score`; key and revision are always kept. Queries reading other fields scan. */
  fields: readonly string[];
  /** Cap on the estimated bytes of the kept copies; a larger scope keeps none. Default 64 MiB. */
  maxBytes?: number;
}
export interface DbsonlSourceOptions {
  gte?: string;
  lt?: string;
  /**
   * Pin every execution to this snapshot head instead of the latest one, so sources in several workers read one
   * snapshot and their partial aggregates merge. The provider rejects a head it no longer holds.
   */
  at?: object;
  /** Opt-in: keep the queried fields of one revision to answer later small pages without decoding every document. */
  projection?: DbsonlProjectionOptions;
}
export interface DbsonlProjectionStats { revision: number; rows: number; bytes: number }
export interface DbsonlSource<T> extends RecordSource<DbsonlRecord<T>> {
  /** The revision the projection holds, or undefined before a complete scan or when it did not fit. */
  readonly projected: DbsonlProjectionStats | undefined;
  /** Scan the current revision into the projection unless it already holds it. Undefined without a projection. */
  prepare(options?: { signal?: CancellationSignal }): Promise<DbsonlProjectionStats | undefined>;
}
type Projected<T> = { revision: number; rows: DbsonlRecord<T>[]; sizes: Float64Array; bytes: number };
// VERIFIED: a point read took 20 to 42 µs against 2.5 to 3 µs per scanned row (100,000 documents, memory and file,
// 2026-11-17), so fetching more than 1/16 of the scope row by row would cost about as much as scanning it.
const MATERIALIZE_FRACTION = 16;
const ordering = compileQuery({ sorters: [{ field: 'key', direction: 'asc' }] }).ordering;
/**
 * Own a fresh database snapshot per execution. Query value.* for document fields;
 * key and revision remain separate even for primitive/undefined stored values.
 */
export function createDbsonlSource<T>(database: DbsonlDatabase<T>, options: DbsonlSourceOptions = {}): DbsonlSource<T> {
  const { gte, lt, at } = options;
  if (at !== undefined && (typeof at !== 'object' || at === null)) throw new TypeError('at must be the head object of an open snapshot.');
  for (const bound of [gte, lt]) if (bound !== undefined && (typeof bound !== 'string' || bound.length > 4096)) throw new TypeError('Range bounds must be strings of at most 4096 code units.');
  if (gte !== undefined && lt !== undefined && gte > lt) throw new RangeError('gte must not exceed lt.');
  const projection = options.projection === undefined ? undefined : projector(options.projection);
  let kept: Projected<T> | undefined;
  const source: DbsonlSource<T> = {
    get projected() { return kept && { revision: kept.revision, rows: kept.rows.length, bytes: kept.bytes }; },
    async prepare({ signal } = {}) {
      if (!projection) return undefined;
      const session = await source.open({ signal });
      let failure: { error: unknown } | undefined;
      try {
        if (kept?.revision !== session.revision) for await (const _ of measuredScan(session)!(resolveOptions({ signal }))) abort(signal);
      } catch (error) { failure = { error }; throw error; }
      finally { await cleanup([() => session.close()], failure); }
      return source.projected;
    },
    async open({ signal } = {}) {
      abort(signal);
      const snapshot = await (at === undefined ? database.beginRead() : database.beginRead({ at }));
      try { abort(signal); } catch (error) { await cleanup([() => snapshot.close()], { error }); throw error; }
      let closing: Promise<void> | undefined;
      const session: RecordSession<DbsonlRecord<T>> = {
        consistency: 'snapshot', revision: snapshot.revision,
        // DBSONL count describes the full database, not a restricted key range.
        count: gte === undefined && lt === undefined ? snapshot.count : undefined,
        ordering,
        scan(request) {
          if (closing) throw new DataviewError('CLOSED', 'DBSONL source is closed.');
          return batchRows(snapshot.scan({ gte, lt, signal: request.signal }), request);
        },
        close() { return closing ??= snapshot.close(); },
      };
      const projecting = projection && typeof snapshot.get === 'function' ? projection : undefined;
      if (projecting) registerProjection(session, (query, end, request) => {
        const hit = kept?.revision === snapshot.revision ? kept : undefined;
        // The copies were measured with the default estimator; a caller's estimator expects stored rows.
        if (!hit || request.sizeOf !== estimateRowBytes || end * MATERIALIZE_FRACTION > hit.rows.length || !projecting.covers(query)) return undefined;
        return {
          scan: request => projectedBatches(hit, request),
          async materialize(rows) {
            if (closing) throw new DataviewError('CLOSED', 'DBSONL source is closed.');
            const stored = await Promise.all(rows.map(row => snapshot.get!(row.key)));
            return stored.map((lookup, i) => {
              if (!lookup.found) throw new DataviewError('SOURCE_CONTRACT', 'A projected DBSONL key is missing from its snapshot.');
              return { key: rows[i].key, revision: lookup.revision!, value: lookup.value as T };
            });
          },
        };
      });
      return registerMeasuredScan(session, request => {
        if (closing) throw new DataviewError('CLOSED', 'DBSONL source is closed.');
        let batches: AsyncIterable<MeasuredBatch<DbsonlRecord<T>>>;
        if (snapshot.scanBatches) {
          // The byte budget is the adapter's: a provider's own measure, such as encoded bytes, could reject a row the
          // request's sizeOf admits. batchSize still bounds the rows of one pull.
          const options = { lt, signal: request.signal, batchSize: request.batchSize, maxBatchBytes: Number.MAX_SAFE_INTEGER };
          batches = nativeBatches((from, limit) => snapshot.scanBatches!({ ...options, gte: from, limit }), gte, request);
        } else batches = measuredRows(snapshot.scan({ gte, lt, signal: request.signal }), request);
        if (!projecting || kept?.revision === snapshot.revision) return batches;
        return projecting.record(batches, snapshot.revision, next => { if (!kept || next.revision >= kept.revision) kept = next; });
      });
    },
  };
  return source;
}

/**
 * Copies of each row's key, revision and configured fields. A query may read only those fields or paths below them;
 * the copies resolve them to the same values through the same own-property accessor, so predicates and comparisons
 * see what they would see on the stored row. Containers on the way are plain objects, and a leaf keeps the stored
 * value by reference, which the adapter's immutable-row contract covers.
 */
function projector({ fields, maxBytes = 64 * 1024 * 1024 }: DbsonlProjectionOptions) {
  if (!Array.isArray(fields) || !fields.length) throw new TypeError('projection.fields must be a nonempty array of field paths.');
  natural(maxBytes, 'projection.maxBytes');
  const kept = ['key', 'revision'];
  const below = (field: string, base: string) => field === base || field.startsWith(base + '.');
  // A path below another configured path is already inside that path's copied value.
  const roots = [...new Set(fields.map(field => { fieldParts(field); return field; }))].sort()
    .filter((field, _, all) => !kept.some(base => below(field, base)) && !all.some(other => other !== field && below(field, other)));
  const paths = roots.map(fieldParts), covered = [...kept, ...roots];
  const project = <T>(row: DbsonlRecord<T>): DbsonlRecord<T> => {
    const copy: Record<string, unknown> = { key: row.key, revision: row.revision };
    for (const parts of paths) {
      let from: unknown = row, to = copy;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (typeof from !== 'object' || from === null || !Object.hasOwn(from, part)) break;
        from = (from as Record<string, unknown>)[part];
        if (i === parts.length - 1) to[part] = from;
        else to = (Object.hasOwn(to, part) ? to[part] : to[part] = {}) as Record<string, unknown>;
      }
    }
    return copy as DbsonlRecord<T>;
  };
  return {
    covers(query: CompiledQuery): boolean {
      const details = queryDetails(query);
      if (!details) return false;
      return [...details.filters.map(filter => filter.field), ...query.ordering.sorters.map(sorter => sorter.field)]
        .every(field => covered.some(base => below(field, base)));
    },
    /** Copy rows as a complete scan passes; publish only when the scan ends and the copies fit the cap. */
    async *record<T>(batches: AsyncIterable<MeasuredBatch<DbsonlRecord<T>>>, revision: number, publish: (kept: Projected<T>) => void): AsyncGenerator<MeasuredBatch<DbsonlRecord<T>>> {
      let rows: DbsonlRecord<T>[] | undefined = [], sizes: number[] = [], bytes = 0;
      for await (const batch of batches) {
        if (rows) {
          const start = batch.offset ?? 0, end = start + (batch.length ?? batch.rows.length);
          for (let i = start; i < end; i++) {
            const copy = project(batch.rows[i]), size = estimateRowBytes(copy);
            if ((bytes += size) > maxBytes) { rows = undefined; sizes = []; break; }
            rows.push(copy); sizes.push(size);
          }
        }
        yield batch;
      }
      if (rows) publish({ revision, rows, sizes: Float64Array.from(sizes), bytes });
    },
  };
}

/** Spans of the kept copies under the current request's row, batch and byte limits. */
async function* projectedBatches<T>(kept: Projected<T>, request: ScanRequest<DbsonlRecord<T>>): AsyncGenerator<MeasuredBatch<DbsonlRecord<T>>> {
  const { rows, sizes } = kept;
  for (let start = 0; start < rows.length;) {
    abort(request.signal);
    let length = 0, bytes = 0;
    for (; start + length < rows.length && length < request.batchSize; length++) {
      const size = sizes[start + length];
      if (size > request.maxRowBytes || size > request.maxBatchBytes) throw new DataviewError('LIMIT_EXCEEDED', 'A row exceeds the row or batch byte budget.');
      if (length && bytes + size > request.maxBatchBytes) break;
      bytes += size;
    }
    yield { rows, offset: start, length, sizes, sizesOffset: start, bytes };
    start += length;
  }
}

/**
 * Rows a native scan reads in this thread before it continues where the provider may start its worker pool.
 * VERIFIED: starting defuss-dbsonl 0.7.0's pool raised a first page of 50 over 100,000 file rows from 1.5 to 15 ms, the
 * decoding time of about 4,800 rows in this thread (2026-11-20). Reading this many rows first keeps short scans as fast
 * as before and adds at most that time to a long scan.
 */
const PREFIX_ROWS = 4096;

/**
 * Native batches arrive cut by the provider's own sizes: defuss-dbsonl counts encoded bytes unless it is given a sizeOf,
 * and it runs only scans without one in its worker pool, because a function cannot be sent to a worker. The adapter
 * therefore measures every row itself, once, and yields a batch over maxBatchBytes as spans that fit, so the budget
 * holds for every batch the executor reads. A structural provider cannot forge measurements or batch bounds.
 * The first PREFIX_ROWS rows come from a scan with that limit; the rest from a scan at the last key, skipping that row,
 * because the key after it can exceed the provider's key length. A provider that ignores the limit still yields each row once.
 * VERIFIED: over 100,000 rows of file storage, filter + top-50 with an exact count took 147 ms, against 278 ms with the
 * previous adapter, which passed its sizeOf and so never reached the pool (defuss-dbsonl 0.7.0, 2026-11-20).
 */
async function* nativeBatches<T>(scan: (gte: string | undefined, limit?: number) => AsyncIterable<readonly DbsonlRecord<T>[]>, gte: string | undefined, request: ScanRequest<DbsonlRecord<T>>): AsyncGenerator<MeasuredBatch<DbsonlRecord<T>>> {
  let iterator = scan(gte, PREFIX_ROWS)[Symbol.asyncIterator](), prefix = true, read = 0, last: string | undefined, skip: string | undefined;
  let failure: { error: unknown } | undefined;
  try {
    for (;;) {
      abort(request.signal);
      const next = await iterator.next();
      abort(request.signal);
      if (next.done) {
        if (!prefix || read < PREFIX_ROWS) return;
        prefix = false; skip = last;
        iterator = scan(last, undefined)[Symbol.asyncIterator]();
        continue;
      }
      const rows = next.value;
      if (!Array.isArray(rows) || !rows.length || rows.length > request.batchSize) throw new DataviewError('SOURCE_CONTRACT', 'Invalid native database batch.');
      const sizes = new Float64Array(rows.length);
      let start = 0, bytes = 0;
      for (let i = 0; i < rows.length; i++) {
        const size = sizes[i] = rowBytes(rows[i], request);
        if (i === 0 && skip !== undefined && rows[0].key === skip) { start = 1; continue; }
        if (bytes + size > request.maxBatchBytes) { yield { rows, offset: start, length: i - start, sizes, sizesOffset: start, bytes }; start = i; bytes = 0; }
        bytes += size;
      }
      skip = undefined; read += rows.length;
      last = rows[rows.length - 1].key;
      if (typeof last !== 'string') throw new DataviewError('SOURCE_CONTRACT', 'A native database row has no string key.');
      if (start < rows.length) yield { rows, offset: start, length: rows.length - start, sizes, sizesOffset: start, bytes };
    }
  } catch (error) { failure = { error }; throw error; }
  finally { await cleanup([async () => iterator.return?.()], failure); }
}
