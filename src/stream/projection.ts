import type { CompiledQuery } from '../query.js';
import type { DataviewRow } from '../types.js';
import type { MeasuredBatch } from './measured.js';
import type { CancellationSignal, RecordSession, ScanRequest } from './types.js';

/**
 * A session can answer some queries from a smaller copy of its rows that holds only the fields those queries read.
 * The executor filters, sorts and counts the copies, then asks for the full stored rows of the ones it returns.
 * Like measured scans, the registry is private and bound to the session's original scan method, so a public source
 * cannot install it and a decorated session loses it.
 * VERIFIED: src/adapters/dbsonl-projection.test.ts shows a warm query returning the full scan's rows and summary
 * without a native scan, on DBSONL memory and file storage.
 */
export interface Projection<T extends DataviewRow> {
  scan(request: ScanRequest<T>): AsyncIterable<MeasuredBatch<T>>;
  /** The stored rows for these projected rows, in the same order, read from the session's snapshot. */
  materialize(rows: readonly T[], signal?: CancellationSignal): Promise<readonly T[]>;
}
/** Undefined when this query cannot be answered from the projection; the executor then scans normally. */
export type ProjectionPlan<T extends DataviewRow> = (query: CompiledQuery, end: number, request: ScanRequest<T>) => Projection<T> | undefined;

const plans = new WeakMap<object, { scan: unknown; plan: unknown }>();
export function registerProjection<T extends DataviewRow>(session: RecordSession<T>, plan: ProjectionPlan<T>): void {
  plans.set(session, { scan: session.scan, plan });
}
export function projectionPlan<T extends DataviewRow>(session: RecordSession<T>): ProjectionPlan<T> | undefined {
  const entry = plans.get(session);
  return entry && entry.scan === session.scan ? entry.plan as ProjectionPlan<T> : undefined;
}
