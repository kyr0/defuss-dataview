import type { DataviewRow } from '../types.js';
import type { QueryDescriptor, QueryOrdering } from '../query.js';
/** Structural AbortSignal subset; public declarations do not require DOM libraries. */
export interface CancellationSignal { readonly aborted: boolean; readonly reason?: unknown }
export interface StreamRequest extends QueryDescriptor {
  offset?: number;
  /** Omit for all matches. Unordered sorting still obeys retention budgets. */
  limit?: number;
}
export interface ScanRequest<T extends DataviewRow> {
  readonly batchSize: number;
  readonly maxBatchBytes: number;
  readonly maxRowBytes: number;
  readonly sizeOf: (row: T) => number;
  readonly signal?: CancellationSignal;
}
/** Query owns the returned session and always closes it, including after early return. */
export interface RecordSource<T extends DataviewRow> {
  open(options?: { signal?: CancellationSignal }): Promise<RecordSession<T>>;
}
export interface RecordSession<T extends DataviewRow> {
  readonly consistency: 'snapshot';
  readonly revision: string | number | bigint;
  /** Exact count within this source's scope, not its containing database. */
  readonly count?: number;
  readonly ordering?: QueryOrdering;
  /** Fresh nonempty batches; stable values, no buffer reuse or hidden prefetch. */
  scan(request: ScanRequest<T>): AsyncIterable<readonly T[]>;
  /** Idempotent. Must drain active reads and release every owned resource. */
  close(): Promise<void>;
}
export interface StreamOptions<T extends DataviewRow> {
  count?: 'none' | 'exact';
  /** Yield to the host event loop after this many input batches; 0 disables fairness yields. */
  yieldEveryBatches?: number;
  batchSize?: number;
  maxBatchBytes?: number;
  maxRowBytes?: number;
  maxBufferedRows?: number;
  maxBufferedBytes?: number;
  /** Exceeding a work budget fails; partial output never receives a success summary. */
  maxScannedRows?: number;
  /** Pure, stable accounting of retained bytes. Invocation counts are not an API guarantee. */
  sizeOf?: (row: T) => number;
  signal?: CancellationSignal;
}
export interface QuerySummary {
  revision: string | number | bigint;
  sourceRows: number | null;
  totalMatches: number | null;
  scannedRows: number;
  observedMatches: number;
  returnedRows: number;
  /** True only after observing iterator completion, not merely reaching the page limit. */
  sourceExhausted: boolean;
  hasMore: boolean;
  strategy: 'scan' | 'ordered' | 'top-k' | 'sort';
  peakBufferedRows: number;
  peakBufferedBytes: number;
}
export type QueryEvent<T> = { type: 'batch'; rows: readonly T[] } | { type: 'complete'; summary: QuerySummary };
export interface StreamResult<T> { rows: T[]; summary: QuerySummary }
