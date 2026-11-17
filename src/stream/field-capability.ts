import type { CancellationSignal, RecordSession } from './types.js';
import type { FieldLease } from './key-cache.js';
type Acquire = (fields: readonly string[], signal: CancellationSignal | undefined) => FieldLease;
const capabilities = new WeakMap<object, { scan: unknown; acquire: Acquire }>();
/**
 * Private read access to a session's already-built source columns, bound like query keys to the session's original
 * scan method: a public source cannot install it and a decorated session loses it.
 * VERIFIED: src/compute/compute.test.ts reads leased columns and checks results equal with the cache off, cold and warm.
 */
export function registerFieldColumns(session: RecordSession<object>, acquire: Acquire): void { capabilities.set(session, { scan: session.scan, acquire }); }
export function fieldColumns(session: RecordSession<object>): Acquire | undefined {
  const capability = capabilities.get(session);
  return capability?.scan === session.scan ? capability.acquire : undefined;
}
