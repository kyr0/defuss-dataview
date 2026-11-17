import { abort, DataviewError, estimateRowBytes, hostTask, natural } from './common.js';
import type { CancellationSignal } from './types.js';

const PAGE_ROWS = 4096;
/** Revision-local, lazy pages. The explicit cap bounds typed-array payload bytes. */
export class AccountingCache<T extends object> {
  private readonly pages = new Map<number, { values: Float64Array; filled: number }>();
  private lastPage = -1;
  private last: { values: Float64Array; filled: number } | undefined;
  private readonly capacity: number;
  bytes = 0;
  measuredRows = 0;
  constructor(readonly rows: readonly T[], maxBytes: number) {
    natural(maxBytes, 'maxCachedBytes');
    this.capacity = Math.min(rows.length, Math.floor(maxBytes / 8));
  }
  get cacheableRows(): number { return this.capacity; }
  /** Only fully measured pages can lend a span without revalidating row shapes. */
  block(index: number, limit: number): { values: Float64Array; offset: number; length: number } | undefined {
    const page = this.pages.get(Math.floor(index / PAGE_ROWS));
    if (!page || page.filled !== page.values.length) return undefined;
    const values = page.values;
    const offset = index % PAGE_ROWS;
    if (offset >= values.length) return undefined;
    return { values, offset, length: Math.min(limit, values.length - offset) };
  }
  size(index: number): number {
    const row = this.rows[index];
    if (index >= this.capacity) return measure(row);
    const page = Math.floor(index / PAGE_ROWS), slot = index % PAGE_ROWS;
    if (page !== this.lastPage) {
      let values = this.pages.get(page);
      if (!values) {
        values = { values: new Float64Array(Math.min(PAGE_ROWS, this.capacity - page * PAGE_ROWS)), filled: 0 };
        this.pages.set(page, values); this.bytes += values.values.byteLength;
      }
      this.lastPage = page; this.last = values;
    }
    const stored = this.last!.values[slot];
    if (stored) return stored - 1;
    const size = measure(row);
    // size is a safe integer; size + 1 can be 2^53, which Float64 stores exactly.
    this.last!.values[slot] = size + 1; this.measuredRows++;
    this.last!.filled++;
    return size;
  }
}
function measure(row: object): number {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new DataviewError('SOURCE_CONTRACT', 'A source row must be a record object.');
  return estimateRowBytes(row);
}
export async function prepareCache(cache: AccountingCache<object>, revision: bigint, signal?: CancellationSignal) {
  abort(signal);
  for (let i = 0; i < cache.cacheableRows; i++) {
    if (i > 0 && i % 16384 === 0) { await hostTask(); abort(signal); }
    cache.size(i);
  }
  abort(signal);
  return { revision, cachedRows: cache.measuredRows, cachedBytes: cache.bytes };
}
