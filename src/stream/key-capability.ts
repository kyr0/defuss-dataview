import type { CompiledQuery } from '../query.js';
import type { CancellationSignal, RecordSession } from './types.js';
import type { QueryKeyLease } from './key-cache.js';
type Acquire = (query: CompiledQuery, signal: CancellationSignal | undefined, sort: boolean) => Promise<QueryKeyLease>;
const capabilities = new WeakMap<object, { scan: unknown; acquire: Acquire }>();
/** Same trust boundary as measured scans: public flags cannot install capabilities. */
export function registerQueryKeys<T extends object>(session: RecordSession<T>, acquire: Acquire): void { capabilities.set(session, { scan: session.scan, acquire }); }
export function queryKeys<T extends object>(session: RecordSession<T>): Acquire | undefined {
  const capability = capabilities.get(session);
  return capability?.scan === session.scan ? capability.acquire : undefined;
}
