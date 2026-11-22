import { compileAccessor, fieldParts } from '../fields.js';
import { queryDetails } from '../query-internals.js';
import type { CompiledQuery } from '../query.js';
import type { CancellationSignal } from './types.js';
import { abort, DataviewError, hostTask, natural } from './common.js';
import { FrequencyAdmission, hashText, SecondTouch } from './admission.js';
import { BlockSummary, KEY_BLOCK_ROWS, summaryBytes, compileBlockFilter } from './block-summary.js';

export interface KeyCacheOptions {
  /** Accounted columns/entries/build reservations. Default 32 MiB; 0 disables. */
  maxBytes?: number;
  /** Both resist first touches; TinyLFU additionally compares popularity at eviction. */
  policy?: 'slru' | 'tiny-lfu';
  /** Build min/max and scalar-equality Bloom summaries. Default false. */
  blockIndex?: boolean;
}
export interface KeyCacheStats {
  readonly bytes: number;
  readonly peakBytes: number;
  readonly maxBytes: number;
  /** Bounded policy metadata, separate from column accounting and physical VM heap. */
  readonly metadataBytes: number;
  readonly entries: number;
  readonly pinnedEntries: number;
  readonly buildingEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly builds: number;
  readonly evictions: number;
  readonly rejected: number;
  readonly prunedRows: number;
}
interface Entry {
  revision: KeyRevision;
  field: string;
  hash: number;
  bytes: number;
  pins: number;
  building: boolean;
  retired: boolean;
  failed: boolean;
  promote: boolean;
  error?: unknown;
  ready: Promise<void>;
  values: unknown[];
  blocks?: BlockSummary[];
  /** Domain of every value, computed on first request and kept with the immutable column; 'mixed' unless all share one kind. */
  domain?: ColumnDomain;
}
/** Non-nullish homogeneous domains in which comparator ties coincide with value equality under code-unit order. */
export type ColumnDomain = 'boolean' | 'number' | 'bigint' | 'string' | 'mixed';
const DOMAINS = new Set(['boolean', 'number', 'bigint', 'string']);
/**
 * Only the ordered-groups certificate reads a domain, so it is derived lazily instead of during every build.
 * VERIFIED: tracking it inside build() made prepareKeys 9.5% slower in three paired fresh-process runs (2026-11-17).
 */
function domainOf(values: readonly unknown[]): ColumnDomain {
  if (!values.length) return 'mixed';
  const kind = typeof values[0];
  if (!DOMAINS.has(kind)) return 'mixed';
  for (const value of values) if (typeof value !== kind || (kind === 'number' && !Number.isFinite(value))) return 'mixed';
  return kind as ColumnDomain;
}
/** Existing columns only, pinned for one execution; release is idempotent. */
export interface FieldLease {
  readonly begin: number;
  readonly columns: ReadonlyMap<string, { readonly values: readonly unknown[]; readonly domain: ColumnDomain }>;
  readonly pinnedBytes: number;
  release(): void;
}
export interface KeyRevision { rows: readonly object[]; current: boolean; entries: Map<string, Entry> }
export interface QueryKeyLease {
  compare?: (a: number, b: number) => number;
  canSkip?: (start: number, length: number) => boolean;
  skipped(length: number): void;
  release(): void;
}
/** Source-owned SLRU with private pinned leases and shared, independently cancellable builds. */
export class KeyCache {
  private readonly all = new Set<Entry>();
  private readonly probation = new Map<Entry, true>();
  private readonly protected = new Map<Entry, true>();
  private protectedBytes = 0;
  private current?: KeyRevision;
  private readonly policy: SecondTouch | FrequencyAdmission;
  private readonly tiny: boolean;
  readonly blockIndex: boolean;
  readonly maxBytes: number;
  private bytes = 0;
  private peakBytes = 0;
  private hits = 0;
  private misses = 0;
  private builds = 0;
  private evictions = 0;
  private rejected = 0;
  private prunedRows = 0;
  constructor(options: KeyCacheOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('keyCache must be an options object.');
    this.maxBytes = natural(options.maxBytes ?? 32 * 1024 * 1024, 'keyCache.maxBytes');
    if (options.policy !== undefined && options.policy !== 'slru' && options.policy !== 'tiny-lfu') throw new TypeError('Invalid key-cache policy.');
    if (options.blockIndex !== undefined && typeof options.blockIndex !== 'boolean') throw new TypeError('blockIndex must be boolean.');
    this.tiny = options.policy === 'tiny-lfu';
    this.policy = this.tiny && this.maxBytes ? new FrequencyAdmission() : new SecondTouch();
    this.blockIndex = options.blockIndex ?? false;
  }
  revision(rows: readonly object[]): KeyRevision {
    if (this.current) this.current.current = false;
    this.clear();
    return this.current = { rows, current: true, entries: new Map() };
  }
  stats(): KeyCacheStats {
    let pinnedEntries = 0, buildingEntries = 0;
    for (const entry of this.all) { if (entry.pins) pinnedEntries++; if (entry.building) buildingEntries++; }
    return { bytes: this.bytes, peakBytes: this.peakBytes, maxBytes: this.maxBytes, metadataBytes: this.maxBytes ? this.policy.metadataBytes : 0,
      entries: this.all.size, pinnedEntries, buildingEntries, hits: this.hits, misses: this.misses, builds: this.builds, evictions: this.evictions, rejected: this.rejected, prunedRows: this.prunedRows };
  }
  clear(): void { for (const entry of this.all) this.retire(entry); }
  private removeQueues(entry: Entry): void {
    this.probation.delete(entry);
    if (this.protected.delete(entry)) this.protectedBytes -= entry.bytes;
  }
  private discard(entry: Entry): void {
    if (entry.pins || entry.building || !this.all.delete(entry)) return;
    this.removeQueues(entry);
    if (entry.revision.entries.get(entry.field) === entry) entry.revision.entries.delete(entry.field);
    this.bytes -= entry.bytes;
    entry.values = []; entry.blocks = undefined;
  }
  private retire(entry: Entry): void {
    entry.retired = true; this.removeQueues(entry);
    if (entry.revision.entries.get(entry.field) === entry) entry.revision.entries.delete(entry.field);
    this.discard(entry);
  }
  private release(entry: Entry): void {
    entry.pins--;
    if (!entry.pins && entry.building) this.retire(entry);
    else if (entry.retired) this.discard(entry);
  }
  private touch(entry: Entry): void {
    if (entry.retired) return;
    this.removeQueues(entry); this.protected.set(entry, true); this.protectedBytes += entry.bytes;
    // Keep room for probationary fields; large/pinned entries can be demoted
    // without evicting their live values. Admission alone decides eviction.
    while (this.protectedBytes > this.maxBytes * 0.8 && this.protected.size) {
      const first = this.protected.keys().next().value!;
      this.protected.delete(first); this.protectedBytes -= first.bytes; this.probation.set(first, true);
    }
  }
  private reserve(bytes: number, hash: number, force: boolean): boolean {
    if (bytes > this.maxBytes) return false;
    // Plan every victim before mutation. Failed admission must not evict a
    // useful prefix, especially when a pinned entry prevents the final fit.
    const victims: Entry[] = []; let available = this.maxBytes - this.bytes;
    for (const queue of [this.probation, this.protected]) {
      for (const entry of queue.keys()) {
        if (available >= bytes) break;
        if (entry.pins || entry.building) continue;
        if (!force && this.tiny && this.policy.estimate(hash) < this.policy.estimate(entry.hash)) return false;
        victims.push(entry); available += entry.bytes;
      }
      if (available >= bytes) break;
    }
    if (available < bytes) return false;
    for (const victim of victims) { this.retire(victim); this.evictions++; }
    this.bytes += bytes; this.peakBytes = Math.max(this.peakBytes, this.bytes); return true;
  }
  private async build(entry: Entry): Promise<void> {
    try {
      const get = compileAccessor(entry.field), rows = entry.revision.rows;
      if (this.blockIndex) entry.blocks = [];
      for (let i = 0; i < rows.length; i++) {
        // Builds yield where the host can; a timerless runtime builds without task boundaries.
        // VERIFIED: key-cache.test.ts 'timerless runtimes' builds and shares columns with every host scheduler removed.
        if (i && i % 16384 === 0) { await hostTask(); if (!entry.pins) throw new DataviewError('ABORTED', 'Unobserved key build cancelled.'); }
        const row = rows[i];
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new DataviewError('SOURCE_CONTRACT', 'A source row must be a record object.');
        const value = get(row); entry.values.push(value);
        if (entry.blocks) {
          if (i % KEY_BLOCK_ROWS === 0) entry.blocks.push(new BlockSummary(Math.min(KEY_BLOCK_ROWS, rows.length - i)));
          entry.blocks[entry.blocks.length - 1].add(value);
        }
      }
      this.builds++;
    } catch (error) { entry.failed = true; entry.error = error; entry.retired = true; }
    finally {
      entry.building = false;
      if (!entry.retired) {
        // A second-touch admission already demonstrates reuse. Keeping every
        // newcomer in one probation slot can thrash forever on two new hot fields.
        if (entry.promote) this.touch(entry);
        else if (!this.protected.has(entry)) this.probation.set(entry, true);
      }
      else { if (entry.revision.entries.get(entry.field) === entry) entry.revision.entries.delete(entry.field); this.discard(entry); }
    }
  }
  private async acquire(revision: KeyRevision, fields: readonly string[], signal?: CancellationSignal, force = false): Promise<{ entries: Map<string, Entry>; release(): void }> {
    const pinned = new Map<string, Entry>();
    let released = false;
    const release = () => { if (released) return; released = true; for (const entry of pinned.values()) this.release(entry); pinned.clear(); };
    try {
      abort(signal);
      for (const field of fields) fieldParts(field);
      if (!this.maxBytes || !revision.current) return { entries: pinned, release };
      // Pin existing entries first, so admitting another requested field cannot
      // evict a column this same execution was about to use.
      const unique = [...new Set(fields)], missing: Array<{ field: string; hash: number; frequency: number }> = [];
      for (const field of unique) {
        fieldParts(field);
        const hash = hashText(field), frequency = this.policy.record(hash), entry = revision.entries.get(field);
        if (entry && !entry.retired) { entry.pins++; pinned.set(field, entry); this.hits++; this.touch(entry); }
        else { this.misses++; missing.push({ field, hash, frequency }); }
      }
      for (const { field, hash, frequency } of missing) {
        if (!revision.current || !this.maxBytes || (!force && frequency < 2)) { this.rejected++; continue; }
        const bytes = 64 + field.length * 2 + revision.rows.length * 8 + (this.blockIndex ? summaryBytes(revision.rows.length) : 0);
        if (!Number.isSafeInteger(bytes) || !this.reserve(bytes, hash, force)) { this.rejected++; continue; }
        const entry: Entry = { revision, field, hash, bytes, pins: 1, building: true, retired: false, failed: false, promote: frequency >= 2, ready: Promise.resolve(), values: [] };
        this.all.add(entry); revision.entries.set(field, entry); pinned.set(field, entry);
        entry.ready = this.build(entry);
      }
      for (const entry of pinned.values()) {
        // One request's cancellation cannot abort a build needed by another.
        // Host-task polling works with the structural CancellationSignal contract.
        while (entry.building) { abort(signal); const task = hostTask(); await (task ? Promise.race([entry.ready, task]) : entry.ready); }
        abort(signal);
        if (entry.failed) throw entry.error;
      }
      return { entries: pinned, release };
    } catch (error) { release(); throw error; }
  }
  /**
   * Pin columns that are already built for this revision, and never start a build. A cold build reads every row,
   * including rows a query would reject, so a pure but throwing accessor could fail a query that never demands it.
   * Missing, building or disabled columns are simply absent: callers read rows instead. Popularity is not recorded,
   * so these reads do not change admission for ordinary queries.
   */
  columns(revision: KeyRevision, fields: readonly string[], begin: number, signal?: CancellationSignal): FieldLease {
    abort(signal);
    const pinned: Entry[] = [], columns = new Map<string, { values: readonly unknown[]; domain: ColumnDomain }>();
    let released = false, pinnedBytes = 0;
    if (this.maxBytes && revision.current) for (const field of new Set(fields)) {
      fieldParts(field);
      const entry = revision.entries.get(field);
      if (!entry || entry.retired || entry.building || entry.failed) continue;
      entry.pins++; pinned.push(entry); this.hits++; this.touch(entry);
      columns.set(field, { values: entry.values, get domain() { return entry.domain ??= domainOf(entry.values); } }); pinnedBytes += entry.bytes;
    }
    return { begin, columns, pinnedBytes, release: () => { if (released) return; released = true; columns.clear(); for (const entry of pinned) this.release(entry); } };
  }
  async prepare(revision: KeyRevision, fields: readonly string[], signal?: CancellationSignal): Promise<KeyCacheStats> {
    const lease = await this.acquire(revision, fields, signal, true);
    lease.release(); return this.stats();
  }
  async query(revision: KeyRevision, query: CompiledQuery, begin: number, signal?: CancellationSignal, sort = true): Promise<QueryKeyLease> {
    const details = queryDetails(query);
    const sorters = sort ? query.ordering.sorters : [];
    const fields = sorters.map(s => s.field);
    if (this.blockIndex && details) for (const f of details.filters) if (['eq', 'in', 'gt', 'gte', 'lt', 'lte'].includes(f.op)) fields.push(f.field);
    const lease = await this.acquire(revision, fields, signal);
    try {
      const cachedSort = details && sorters.some(s => lease.entries.has(s.field));
      const access = cachedSort ? sorters.map(s => {
        const column = lease.entries.get(s.field)?.values, get = column ? undefined : compileAccessor(s.field);
        return column ? (i: number) => column[begin + i] : (i: number) => get!(revision.rows[begin + i]);
      }) : [];
      const columns = cachedSort ? sorters.map(s => lease.entries.get(s.field)?.values) : [];
      const sign = sorters[0]?.direction === 'desc' ? -1 : 1;
      const secondSign = sorters[1]?.direction === 'desc' ? -1 : 1;
      // Direct two-column reads remove accessor calls and loop dispatch. Keep
      // references behind columns so release() still drops every retained key.
      const compare = cachedSort && sorters.length === 1 ? (a: number, b: number) => details.compareValues(columns[0]![begin + a], columns[0]![begin + b]) * sign
        : cachedSort && sorters.length === 2 && columns[0] && columns[1] ? (a: number, b: number) =>
          details.compareValues(columns[0]![begin + a], columns[0]![begin + b]) * sign || details.compareValues(columns[1]![begin + a], columns[1]![begin + b]) * secondSign
        : cachedSort ? (a: number, b: number) => {
        for (let i = 0; i < sorters.length; i++) { const result = details.compareValues(access[i](a), access[i](b)); if (result) return sorters[i].direction === 'desc' ? -result : result; }
        return 0;
      } : undefined;
      const codeUnit = query.ordering.comparisonId === 'dataview-order-v2:code-unit';
      const indexed = details?.filters.flatMap(filter => {
        const blocks = lease.entries.get(filter.field)?.blocks;
        const test = blocks ? compileBlockFilter(filter, codeUnit) : undefined;
        return blocks && test ? [{ test, blocks }] : [];
      }) ?? [];
      const canSkip = indexed.length ? (start: number, length: number) => {
        const first = Math.floor((begin + start) / KEY_BLOCK_ROWS), last = Math.floor((begin + start + length - 1) / KEY_BLOCK_ROWS);
        for (let block = first; block <= last; block++) {
          if (!indexed.some(({ test, blocks }) => blocks[block] && test(blocks[block]))) return false;
        }
        return true;
      } : undefined;
      return { compare, canSkip, skipped: length => { this.prunedRows += length; }, release() { access.length = 0; columns.length = 0; indexed.length = 0; lease.release(); } };
    } catch (error) { lease.release(); throw error; }
  }
}
