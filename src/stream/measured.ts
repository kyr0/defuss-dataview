import type { DataviewRow } from '../types.js';
import type { RecordSession, ScanRequest } from './types.js';

/** Private handoff: measurements never arrive from a public source's batch. */
export interface MeasuredBatch<T> {
  rows: readonly T[];
  /** Private spans avoid copying references from an already pinned array. */
  offset?: number;
  length?: number;
  /** Scratch may be reused after the next pull; public events never expose it. */
  sizes: ArrayLike<number>;
  /** Internal cache spans store size + 1; zero remains the unmeasured sentinel. */
  sizesOffset?: number;
  sizeBias?: number;
  bytes: number;
}
type MeasuredScan<T extends DataviewRow> = (request: ScanRequest<T>) => AsyncIterable<MeasuredBatch<T>>;
// Weak identity avoids publishing a forgeable "already validated" flag. Keeping
// the original scan method also makes decorated/replaced scans use validation.
const scans = new WeakMap<object, { original: unknown; measured: unknown }>();
export function registerMeasuredScan<T extends DataviewRow>(session: RecordSession<T>, measured: MeasuredScan<T>): RecordSession<T> {
  scans.set(session, { original: session.scan, measured });
  return session;
}
export function measuredScan<T extends DataviewRow>(session: RecordSession<T>): MeasuredScan<T> | undefined {
  const entry = scans.get(session);
  return entry && entry.original === session.scan ? entry.measured as MeasuredScan<T> : undefined;
}
