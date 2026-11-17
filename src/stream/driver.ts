import type { DataviewRow } from '../types.js';
import { measuredScan } from './measured.js';
import type { MeasuredBatch } from './measured.js';
import { abort, DataviewError, natural, rowBytes, yieldToHost } from './common.js';
import type { RecordSession, ScanRequest } from './types.js';

export function validateSession<T extends DataviewRow>(session: RecordSession<T>): void {
  if (session.consistency !== 'snapshot') throw new DataviewError('SOURCE_CONTRACT', 'A stable snapshot is required.');
  if (!['number', 'string', 'bigint'].includes(typeof session.revision) || typeof session.revision === 'number' && !Number.isSafeInteger(session.revision)) throw new DataviewError('SOURCE_CONTRACT', 'Invalid source revision.');
  if (session.count !== undefined) natural(session.count, 'source count');
}

/** One admitted input batch: rows[start .. start + length), each with its validated size. */
export interface ValidatedSpan<T> {
  readonly rows: readonly T[];
  readonly start: number;
  readonly length: number;
  size(index: number): number;
}
/**
 * The batch half of the row executor's loop, for operators that consume a whole span per call: fairness yields,
 * cancellation around every pull, batch shape checks and complete-batch byte validation before any row is used.
 * Built-in sessions supply trusted sizes through the private measured scan; every other batch is measured here.
 * Row-level scan budgets stay with the caller, which knows how many rows it actually consumed.
 * It returns next()/close() rather than being a generator: a generator's finally would close the iterator itself, and
 * a close failure there would replace the caller's original error instead of joining it in cleanup().
 * VERIFIED: src/compute/compute.test.ts feeds invalid, oversized and decorated batches through compute plans.
 */
export interface BatchReader<T> {
  /** The next admitted span, or undefined once the source is exhausted. */
  next(): Promise<ValidatedSpan<T> | undefined>;
  /** Closes the source iterator; the caller aggregates its failure with the session's (see cleanup()). */
  close(): Promise<void>;
}
export function readBatches<T extends DataviewRow>(session: RecordSession<T>, o: ScanRequest<T> & { yieldEveryBatches: number }): BatchReader<T> {
  const measured = measuredScan(session);
  const iterator = (measured ? measured(o) : session.scan(o))[Symbol.asyncIterator]();
  const validated: number[] = [];
  let batches = 0;
  return {
    async next() {
      if (batches > 0 && o.yieldEveryBatches > 0 && batches % o.yieldEveryBatches === 0) await yieldToHost();
      abort(o.signal);
      const next = await iterator.next();
      abort(o.signal);
      if (next.done) return undefined;
      batches++;
      const value = next.value as readonly T[] | MeasuredBatch<T>;
      const rows = measured ? (value as MeasuredBatch<T>).rows : value as readonly T[];
      if (!Array.isArray(rows)) throw new DataviewError('SOURCE_CONTRACT', 'Source emitted an invalid batch.');
      const start = measured ? (value as MeasuredBatch<T>).offset ?? 0 : 0;
      const length = measured ? (value as MeasuredBatch<T>).length ?? rows.length : rows.length;
      if (length === 0 || length > o.batchSize || start < 0 || start + length > rows.length) throw new DataviewError('SOURCE_CONTRACT', 'Source emitted an empty, invalid or oversized batch.');
      let size: (index: number) => number;
      if (measured) {
        const { sizes, sizesOffset = 0, sizeBias = 0 } = value as MeasuredBatch<T>;
        size = index => sizes[sizesOffset + index] - sizeBias;
      } else {
        // Validate the whole retained batch before any row is used, even when the consumer stops mid-batch.
        let bytes = 0;
        for (let i = 0; i < length; i++) { validated[i] = rowBytes(rows[i], o); bytes += validated[i]; }
        if (bytes > o.maxBatchBytes) throw new DataviewError('SOURCE_CONTRACT', 'Source exceeded its batch byte budget.');
        size = index => validated[index];
      }
      return { rows, start, length, size };
    },
    async close() { await iterator.return?.(); },
  };
}
