import type { DataviewRow } from '../types.js';
import type { CancellationSignal, ScanRequest, StreamOptions } from './types.js';
export class DataviewError extends Error {
  constructor(readonly code: 'ABORTED' | 'LIMIT_EXCEEDED' | 'SOURCE_CONTRACT' | 'CLOSED', message: string, options?: { cause?: unknown }) {
    super(message, options); this.name = 'DataviewError';
  }
}
export function abort(signal?: CancellationSignal): void {
  if (signal?.aborted) throw new DataviewError('ABORTED', 'Query cancelled.', { cause: signal.reason });
}
export function natural(n: number, name: string, min = 0): number {
  if (!Number.isSafeInteger(n) || n < min) throw new RangeError(`${name} must be a safe integer >= ${min}.`);
  return n;
}
export const DEFAULT_STREAM_LIMITS = Object.freeze({ yieldEveryBatches: 32, batchSize: 256, maxBatchBytes: 4 * 1024 * 1024, maxRowBytes: 1024 * 1024, maxBufferedRows: 100_000, maxBufferedBytes: 64 * 1024 * 1024 });
function primitiveBytes(value: unknown): number {
  return typeof value === 'string' ? 16 + value.length * 2
    : typeof value === 'bigint' ? 16 + Math.ceil(value.toString(16).replace('-', '').length / 2) : 8;
}
/**
 * Deterministic accounting, not a measurement of VM heap size. Cycles are counted
 * once per row; binary backing stores are charged in full because views retain them.
 * Own data properties only: getters are rejected rather than invoked by accounting.
 */
export function estimateRowBytes(value: unknown): number {
  // Flat scalar records need neither a graph worklist nor a visited set. Allocate
  // these lazily at the first edge, preserving object traversal order for aliasing.
  let seen: Set<object> | undefined, pending: unknown[] | undefined;
  let bytes = 0, v = value;
  for (;;) {
    if (v === null || typeof v !== 'object') bytes += primitiveBytes(v);
    else if (!seen?.has(v)) {
      seen?.add(v); bytes += 32;
      if (v instanceof ArrayBuffer) bytes += v.byteLength;
      else if (ArrayBuffer.isView(v)) {
        const buffer = v.buffer;
        if (!seen?.has(buffer)) { seen?.add(buffer); bytes += buffer.byteLength; }
      } else if (v instanceof Date) bytes += 8;
      else if (v instanceof Map) {
        seen ??= new Set([v]); pending ??= [];
        for (const [k, item] of v) { bytes += 16; pending.push(k, item); }
      } else if (v instanceof Set) {
        seen ??= new Set([v]); pending ??= [];
        for (const item of v) { bytes += 8; pending.push(item); }
      } else for (const key of Reflect.ownKeys(v)) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in descriptor)) throw new TypeError('Row accounting requires data properties or an explicit sizeOf function.');
        bytes += 16 + (typeof key === 'string' ? key.length * 2 : 8);
        const child: unknown = descriptor.value;
        if (child !== null && typeof child === 'object') {
          seen ??= new Set([v]); (pending ??= []).push(child);
        } else bytes += primitiveBytes(child);
      }
    }
    if (!Number.isSafeInteger(bytes)) throw new DataviewError('LIMIT_EXCEEDED', 'Row byte accounting overflow.');
    if (!pending?.length) return bytes;
    v = pending.pop();
  }
}
export function resolveOptions<T extends DataviewRow>(input: StreamOptions<T>) {
  const o = { ...input, yieldEveryBatches: input.yieldEveryBatches ?? DEFAULT_STREAM_LIMITS.yieldEveryBatches, count: input.count ?? 'none', sizeOf: input.sizeOf ?? estimateRowBytes,
    batchSize: input.batchSize ?? DEFAULT_STREAM_LIMITS.batchSize, maxBatchBytes: input.maxBatchBytes ?? DEFAULT_STREAM_LIMITS.maxBatchBytes,
    maxRowBytes: input.maxRowBytes ?? DEFAULT_STREAM_LIMITS.maxRowBytes, maxBufferedRows: input.maxBufferedRows ?? DEFAULT_STREAM_LIMITS.maxBufferedRows,
    maxBufferedBytes: input.maxBufferedBytes ?? DEFAULT_STREAM_LIMITS.maxBufferedBytes };
  if (!['none', 'exact'].includes(o.count)) throw new TypeError('count must be none or exact.');
  for (const key of ['batchSize', 'maxBatchBytes', 'maxRowBytes', 'maxBufferedRows', 'maxBufferedBytes'] as const) natural(o[key], key, 1);
  natural(o.yieldEveryBatches, 'yieldEveryBatches');
  if (o.maxScannedRows !== undefined) natural(o.maxScannedRows, 'maxScannedRows');
  if (typeof o.sizeOf !== 'function') throw new TypeError('sizeOf must be a function.');
  return o;
}
export function rowBytes<T extends DataviewRow>(row: T, options: ScanRequest<T>): number {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new DataviewError('SOURCE_CONTRACT', 'A source row must be a record object.');
  const size = natural(options.sizeOf(row), 'sizeOf(row)');
  if (size > options.maxRowBytes || size > options.maxBatchBytes) throw new DataviewError('LIMIT_EXCEEDED', 'A row exceeds the row or batch byte budget.');
  return size;
}
/** Run every cleanup even if one fails; retain the original query failure as first cause. */
export async function cleanup(actions: Array<() => Promise<unknown>>, failure: { error: unknown } | undefined): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
  if (errors.length) {
    if (failure) errors.unshift(failure.error);
    throw new AggregateError(errors, 'Query resource cleanup failed.');
  }
}

/** A host task boundary, or undefined in a runtime without setImmediate, scheduler.postTask or setTimeout.
 * Resolved promises yield only microtasks; host timers/messages need a task boundary. */
export function hostTask(): Promise<void> | undefined {
  const host = globalThis as unknown as {
    setImmediate?: (callback: () => void) => unknown;
    scheduler?: { postTask?: (callback: () => void, options: { priority: 'background' }) => Promise<void> };
    setTimeout?: (callback: () => void, delay: number) => unknown;
  };
  // Node's zero-delay timers impose a 1 ms delay. Immediate callbacks still
  // cross an event-loop boundary, permitting pending I/O and cancellation.
  if (host.setImmediate) return new Promise(resolve => host.setImmediate!(resolve));
  // A background task also admits timer/message cancellation. scheduler.yield's
  // boosted continuation can repeatedly run ahead of those lower-priority tasks.
  if (host.scheduler?.postTask) return host.scheduler.postTask(() => {}, { priority: 'background' });
  return host.setTimeout ? new Promise(resolve => host.setTimeout!(resolve, 0)) : undefined;
}

/** The executor's fairness yield: an explicit option, so a timerless runtime must turn it off (yieldEveryBatches: 0).
 * VERIFIED: src/stream/key-cache.test.ts 'timerless runtimes' asserts this error and that caches still build there. */
export function yieldToHost(): Promise<void> {
  const task = hostTask();
  if (!task) throw new TypeError('Fair streaming requires a host setTimeout; set yieldEveryBatches to 0 in timerless runtimes.');
  return task;
}
