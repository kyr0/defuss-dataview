export { streamQuery, evaluateStream, toStreamRequest, prepareStreamQuery } from './stream/executor.js';
export { createArraySource, createImmutableArraySource } from './stream/array.js';
export type { ArraySourceOptions, ImmutableArraySource, ImmutableArraySourceOptions } from './stream/array.js';
export { batchRows } from './stream/batches.js';
export { DataviewError, DEFAULT_STREAM_LIMITS, estimateRowBytes } from './stream/common.js';
export type * from './stream/types.js';
export type { PreparedStreamQuery } from './stream/executor.js';
export { createIndexedArraySource } from './stream/indexed.js';
export type { IndexedArraySource, IndexedArrayOptions, IndexedPage, IndexCursor } from './stream/indexed.js';

export type { KeyCacheOptions, KeyCacheStats } from './stream/key-cache.js';
