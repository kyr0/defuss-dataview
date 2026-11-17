import type { DataviewRow } from '../types.js';
import type { ScanRequest } from './types.js';
import { abort, cleanup, rowBytes } from './common.js';
import type { MeasuredBatch } from './measured.js';
/** Pull at most one row ahead when the byte threshold splits a batch. */
export async function* batchRows<T extends DataviewRow>(rows: AsyncIterable<T> | Iterable<T>, options: ScanRequest<T>): AsyncGenerator<readonly T[]> {
  yield* batches(rows, options, false);
}
/** Internal source path; never used to trust batches supplied by an external source. */
export function measuredRows<T extends DataviewRow>(rows: AsyncIterable<T> | Iterable<T>, options: ScanRequest<T>): AsyncGenerator<MeasuredBatch<T>> {
  return batches(rows, options, true);
}
async function* batches<T extends DataviewRow, M extends boolean>(rows: AsyncIterable<T> | Iterable<T>, options: ScanRequest<T>, measured: M): AsyncGenerator<M extends true ? MeasuredBatch<T> : readonly T[]> {
  const asynchronous = Symbol.asyncIterator in rows;
  const iterator = asynchronous ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]();
  let batch: T[] = [], sizes: number[] = [], bytes = 0;
  const result = () => (measured ? { rows: batch, sizes, bytes } : batch) as unknown as M extends true ? MeasuredBatch<T> : readonly T[];
  let failure: { error: unknown } | undefined;
  try {
    for (;;) {
      abort(options.signal);
      const next = asynchronous ? await iterator.next() : (iterator as Iterator<T>).next();
      abort(options.signal);
      if (next.done) break;
      const size = rowBytes(next.value, options);
      if (batch.length && bytes + size > options.maxBatchBytes) { yield result(); batch = []; sizes = []; bytes = 0; abort(options.signal); }
      batch.push(next.value); bytes += size;
      if (measured) sizes.push(size);
      if (batch.length === options.batchSize) { yield result(); batch = []; sizes = []; bytes = 0; }
    }
    if (batch.length) yield result();
  } catch (error) { failure = { error }; throw error; }
  finally { await cleanup([async () => iterator.return?.()], failure); }
}
