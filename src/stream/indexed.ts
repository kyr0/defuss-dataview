import { compileQuery } from '../query.js';
import type { QueryDescriptor } from '../query.js';
import type { RecordSource, StreamOptions, StreamResult, CancellationSignal } from './types.js';
import { abort, DataviewError, natural } from './common.js';
import { AccountingCache, prepareCache } from './accounting-cache.js';
import { arraySession } from './array.js';
import { prepareStreamQuery } from './executor.js';
import { keySorter } from './sort-keys.js';

/** Process-local opaque token. Copying/serializing its fields does not copy authority. */
export interface IndexCursor { readonly revision: bigint; readonly position: number }
export interface IndexedArrayOptions {
  /** Retained row references; row values and native sort scratch are separate. */
  maxIndexRows?: number;
  maxIndexBytes?: number;
  maxCachedBytes?: number;
  /** Opt in only when all sort accessors are pure and stable. Default false. */
  cacheSortKeys?: boolean;
  /** Separate transient build accounting cap; default 16 MiB. 0 disables it. */
  maxSortKeyBytes?: number;
}
export interface IndexedPage<T extends object> extends StreamResult<T> {
  /** Exact complete materialized-index size; summary counts describe the suffix source. */
  indexRows: number;
  nextCursor?: IndexCursor;
}
export interface IndexedArraySource<T extends object> extends RecordSource<T> {
  readonly revision: bigint;
  readonly count: number;
  readonly inputRows: number;
  readonly cachedBytes: number;
  /** Transient projection bytes used for the current build, released before return. */
  readonly sortKeyBytes: number;
  replace(rows: readonly T[]): bigint;
  prepare(options?: { signal?: CancellationSignal }): Promise<{ revision: bigint; cachedRows: number; cachedBytes: number }>;
  readPage(page?: { after?: IndexCursor; limit?: number }, options?: StreamOptions<T>): Promise<IndexedPage<T>>;
}
/**
 * Materialize one immutable filter/order scope. Build costs O(n + m log m);
 * revision-bound cursor positioning is O(1), without rescanning an offset prefix.
 * All reachable row values and identity-based query operands must stay immutable.
 */
export function createIndexedArraySource<T extends object>(rows: readonly T[], descriptor: QueryDescriptor = {}, options: IndexedArrayOptions = {}): IndexedArraySource<T> {
  const query = compileQuery(descriptor), plan = prepareStreamQuery<T>();
  const maxRows = natural(options.maxIndexRows ?? 1_000_000, 'maxIndexRows');
  const maxBytes = natural(options.maxIndexBytes ?? 64 * 1024 * 1024, 'maxIndexBytes');
  const cacheBytes = natural(options.maxCachedBytes ?? 64 * 1024 * 1024, 'maxCachedBytes');
  const keyBytes = natural(options.maxSortKeyBytes ?? 16 * 1024 * 1024, 'maxSortKeyBytes');
  if (options.cacheSortKeys !== undefined && typeof options.cacheSortKeys !== 'boolean') throw new TypeError('cacheSortKeys must be boolean.');
  const keys = options.cacheSortKeys && query.ordering.sorters.length ? keySorter<T>(descriptor, query.ordering) : undefined;
  const tokens = new WeakSet<IndexCursor>();
  function build(input: readonly T[], revision: bigint) {
    let selected: T[] = [];
    for (const row of input) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new DataviewError('SOURCE_CONTRACT', 'An index row must be a record object.');
      if (!query.matches(row)) continue;
      if (selected.length >= maxRows || (selected.length + 1) * 8 > maxBytes) throw new DataviewError('LIMIT_EXCEEDED', 'Materialized index exceeds its reference budget.');
      selected.push(row);
    }
    let sortKeyBytes = 0;
    // Projection is all-or-nothing, avoiding a mixed comparator and cache misses.
    // Exceeding this optional scratch cap selects the fully general comparator.
    if (keys && keys.bytes(selected.length) <= keyBytes) {
      sortKeyBytes = keys.bytes(selected.length);
      selected = keys.sort(selected);
    } else if (query.ordering.sorters.length) selected.sort(query.compare);
    return { rows: selected, revision, inputRows: input.length, sortKeyBytes, cache: new AccountingCache(selected, cacheBytes) };
  }
  let state = build(rows, 0n);
  return {
    get revision() { return state.revision; },
    get count() { return state.rows.length; },
    get inputRows() { return state.inputRows; },
    get cachedBytes() { return state.cache.bytes; },
    get sortKeyBytes() { return state.sortKeyBytes; },
    replace(next) { const nextState = build(next, state.revision + 1n); state = nextState; return state.revision; },
    prepare({ signal } = {}) { return prepareCache(state.cache, state.revision, signal); },
    async open({ signal } = {}) { abort(signal); return arraySession(state.rows, state.revision, query.ordering, state.cache); },
    async readPage(page = {}, options = {}) {
      const pinned = state;
      const cursor = page.after;
      if (cursor !== undefined && (!tokens.has(cursor) || cursor.revision !== pinned.revision)) throw new RangeError('Invalid, foreign or stale index cursor.');
      const start = cursor?.position ?? 0;
      const source: RecordSource<T> = { async open({ signal } = {}) {
        abort(signal); return arraySession(pinned.rows, pinned.revision, query.ordering, pinned.cache, start);
      } };
      const result = await plan.evaluate(source, { limit: page.limit ?? 50 }, options);
      let nextCursor: IndexCursor | undefined;
      if (result.summary.hasMore) {
        nextCursor = Object.freeze({ revision: pinned.revision, position: start + result.rows.length });
        tokens.add(nextCursor);
      }
      return { ...result, indexRows: pinned.rows.length, nextCursor };
    },
  };
}
