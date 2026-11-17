import type { DataviewRow } from '../types.js';
import type { QueryOrdering } from '../query.js';
import type { RecordSession, RecordSource, ScanRequest } from './types.js';
import { abort, DataviewError, rowBytes, estimateRowBytes, natural } from './common.js';
import { batchRows } from './batches.js';
import { registerMeasuredScan } from './measured.js';
import { AccountingCache, prepareCache } from './accounting-cache.js';
import { KeyCache } from './key-cache.js';
import type { KeyCacheOptions, KeyCacheStats, KeyRevision } from './key-cache.js';
import { registerQueryKeys } from './key-capability.js';
import { registerFieldColumns } from './field-capability.js';
import type { CancellationSignal } from './types.js';
import type { MeasuredBatch } from './measured.js';
export interface ArraySourceOptions {
  /** clone snapshots values at open; immutable trusts caller-owned immutable rows. */
  isolation?: 'clone' | 'immutable';
  revision?: string | number | bigint;
  ordering?: QueryOrdering;
}

/** One session implementation serves copied and version-pinned membership. */
export function arraySession<T extends DataviewRow>(snapshot: readonly T[], revision: string | number | bigint, ordering?: QueryOrdering, cache?: AccountingCache<T>, begin = 0, keys?: { cache: KeyCache; revision: KeyRevision }): RecordSession<T> {
  let closed = false;
  function check() { if (closed) throw new DataviewError('CLOSED', 'Array snapshot is closed.'); }
  function* values() {
    for (let i = begin; i < snapshot.length; i++) { check(); yield snapshot[i]; }
    // A byte split may have retained the final row while the consumer paused.
    check();
  }
  async function* measured(request: ScanRequest<T>): AsyncGenerator<MeasuredBatch<T>> {
    // Only this private channel reuses scratch; public scans still emit fresh arrays.
    let sizes: Float64Array | undefined;
    const useCache = cache && request.sizeOf === estimateRowBytes;
    let start = begin, count = 0, bytes = 0;
    for (let i = begin; i < snapshot.length; i++) {
      check(); abort(request.signal);
      // Warm immutable pages lend their numeric buffer directly. The entire
      // emitted span still passes current row/batch limits before any predicate.
      const block = useCache && count === 0 ? cache.block(i, request.batchSize) : undefined;
      if (block) {
        let length = 0, total = 0;
        for (; length < block.length; length++) {
          check(); abort(request.signal);
          const size = block.values[block.offset + length] - 1;
          if (size > request.maxRowBytes || size > request.maxBatchBytes) throw new DataviewError('LIMIT_EXCEEDED', 'A row exceeds the row or batch byte budget.');
          if (length && total + size > request.maxBatchBytes) break;
          total += size;
        }
        yield { rows: snapshot, offset: i, length, sizes: block.values, sizesOffset: block.offset, sizeBias: 1, bytes: total };
        i += length - 1; start = i + 1;
        continue;
      }
      sizes ??= new Float64Array(Math.min(request.batchSize, snapshot.length - begin));
      const size = useCache ? cache.size(i) : rowBytes(snapshot[i], request);
      if (useCache && (size > request.maxRowBytes || size > request.maxBatchBytes)) throw new DataviewError('LIMIT_EXCEEDED', 'A row exceeds the row or batch byte budget.');
      if (count && bytes + size > request.maxBatchBytes) {
        yield { rows: snapshot, offset: start, length: count, sizes, bytes };
        start = i; count = 0; bytes = 0; check(); abort(request.signal);
      }
      sizes[count++] = size; bytes += size;
      if (count === request.batchSize) {
        yield { rows: snapshot, offset: start, length: count, sizes, bytes };
        start = i + 1; count = 0; bytes = 0;
      }
    }
    check(); abort(request.signal);
    if (count) yield { rows: snapshot, offset: start, length: count, sizes: sizes!, bytes };
  }
  const session: RecordSession<T> = {
    consistency: 'snapshot', revision, count: snapshot.length - begin, ordering,
    scan(request) { check(); return batchRows(values(), request); },
    async close() { closed = true; },
  };
  if (keys) {
    registerQueryKeys(session, (query, signal, sort) => keys.cache.query(keys.revision, query, begin, signal, sort));
    // Compute plans may read already-built columns of this revision; the lease never builds one, so a plan's cost
    // never includes a hidden cache build. VERIFIED: grouping.test.ts 'never builds a column' (builds stay 0).
    registerFieldColumns(session, (fields, signal) => keys.cache.columns(keys.revision, fields, begin, signal));
  }
  return registerMeasuredScan(session, measured);
}

/** In-memory reference source. Clone mode requires structured-cloneable data. */
export function createArraySource<T extends DataviewRow>(rows: readonly T[], options: ArraySourceOptions = {}): RecordSource<T> {
  if (options.isolation !== undefined && !['clone', 'immutable'].includes(options.isolation)) throw new TypeError('Invalid array isolation.');
  const { isolation = 'clone', revision = 0, ordering } = options;
  return {
    async open({ signal } = {}) {
      abort(signal);
      // Copy membership even in immutable mode. Only clone mode owns row values.
      const runtime = globalThis as unknown as { structuredClone?: <V>(value: V) => V };
      if (isolation === 'clone' && !runtime.structuredClone) throw new TypeError('Array clone isolation requires structuredClone.');
      const snapshot = isolation === 'clone' ? runtime.structuredClone!(rows) : rows.slice();
      return arraySession(snapshot, revision, ordering);
    },
  };
}

export interface ImmutableArraySource<T extends DataviewRow> extends RecordSource<T> {
  /** Source-scoped columns, pins and reservations; absent when caching is disabled. */
  readonly keyCacheStats: KeyCacheStats | undefined;
  /** Best-effort explicit admission under the configured cap; does not enable a cache. */
  prepareKeys(fields: readonly string[], options?: { signal?: CancellationSignal }): Promise<KeyCacheStats | undefined>;
  /** Retire entries immediately; pinned/building entries release when safe. */
  clearKeyCache(): void;
  readonly revision: bigint;
  readonly count: number;
  /** Atomically publish copied membership; existing sessions retain their revision. */
  replace(rows: readonly T[]): bigint;
  /** Current revision's allocated numeric cache payload; source-scoped, not query retention. */
  readonly cachedBytes: number;
  /** Eagerly fill the bounded prefix; normal queries otherwise populate it lazily. */
  prepare(options?: { signal?: CancellationSignal }): Promise<{ revision: bigint; cachedRows: number; cachedBytes: number }>;
}
export interface ImmutableArraySourceOptions {
  /** Opt-in: sort/filter accessors and reachable values must be pure and immutable. */
  keyCache?: KeyCacheOptions;
  ordering?: QueryOrdering;
  /** Numeric cache payload cap per revision. 0 disables caching; default 64 MiB. */
  maxCachedBytes?: number;
}
/**
 * Read-heavy source: O(n) membership copy at creation/replacement, O(1) open.
 * Every row and reachable value MUST remain immutable, including returned rows.
 * This explicit contract avoids deep cloning/freezing or hidden identity caches.
 */
export function createImmutableArraySource<T extends DataviewRow>(rows: readonly T[], options: ImmutableArraySourceOptions = {}): ImmutableArraySource<T> {
  let snapshot = rows.slice(), revision = 0n;
  const ordering = options.ordering;
  const maxCachedBytes = natural(options.maxCachedBytes ?? 64 * 1024 * 1024, 'maxCachedBytes');
  let cache = new AccountingCache(snapshot, maxCachedBytes);
  const keyCache = options.keyCache === undefined ? undefined : new KeyCache(options.keyCache);
  let keyRevision = keyCache?.revision(snapshot);
  return {
    get keyCacheStats() { return keyCache?.stats(); },
    prepareKeys(fields, { signal } = {}) {
      if (!Array.isArray(fields)) throw new TypeError('Key fields must be an array.');
      abort(signal);
      return keyCache ? keyCache.prepare(keyRevision!, fields, signal) : Promise.resolve(undefined);
    },
    clearKeyCache() { keyCache?.clear(); },
    get revision() { return revision; },
    get count() { return snapshot.length; },
    get cachedBytes() { return cache.bytes; },
    replace(next) {
      const membership = next.slice(), nextCache = new AccountingCache(membership, maxCachedBytes);
      snapshot = membership; cache = nextCache; keyRevision = keyCache?.revision(membership); return ++revision;
    },
    prepare({ signal } = {}) { return prepareCache(cache, revision, signal); },
    async open({ signal } = {}) {
      abort(signal);
      return arraySession(snapshot, revision, ordering, cache, 0, keyCache ? { cache: keyCache, revision: keyRevision! } : undefined);
    },
  };
}
