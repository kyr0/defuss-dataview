import { abort, DataviewError, yieldToHost } from '../stream/common.js';
import type { CancellationSignal } from '../stream/types.js';
import { bytesOf } from '../values.js';
import { malformed } from './aggregate.js';
import type { Ledger, StateColumns } from './aggregate.js';
import type { Plan } from './compile.js';
import type { GroupTable } from './group-table.js';
import type { PartialAggregate, PartialState } from './types.js';

/**
 * The partial format: one versioned envelope per part, merged by the final stage of the same plan. A part carries
 * group keys and measure states, never rows, so HAVING, ordering and paging run once over the merged groups; running
 * them per part would drop groups whose total only passes after merging.
 * VERIFIED: src/compute/partial.test.ts merges DBSONL key ranges, also after structuredClone, into the single-pass result.
 */
export const PARTIAL_FORMAT = 1;

/**
 * A 53-bit cyrb53 fingerprint of a descriptor, walked in property order: aliases fix the order of outputs and states,
 * so a reordered descriptor is a different plan. Dates hash by time and binary values by bytes; a cycle hashes as a
 * marker. It detects partials of another plan by accident, not by an adversary.
 */
export function fingerprint(value: unknown): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const mix = (n: number) => { h1 = Math.imul(h1 ^ n, 2654435761); h2 = Math.imul(h2 ^ n, 1597334677); };
  const text = (s: string) => { mix(s.length); for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); };
  const open = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null) return text('null');
    const type = typeof v;
    text(type);
    if (type === 'string') text(v as string);
    else if (type === 'number') text(Object.is(v, -0) ? '-0' : String(v));
    else if (type === 'bigint' || type === 'boolean') text(String(v));
    else if (type === 'object') {
      const object = v as object, bytes = bytesOf(object);
      if (open.has(object)) return text('cycle');
      if (object instanceof Date) text(String(object.getTime()));
      else if (bytes) { text(Object.prototype.toString.call(object)); mix(bytes.length); for (let i = 0; i < bytes.length; i++) mix(bytes[i]); }
      else {
        open.add(object);
        if (Array.isArray(object)) { mix(object.length); for (const item of object) walk(item); }
        else for (const key of Object.keys(object)) { text(key); walk((object as Record<string, unknown>)[key]); }
        open.delete(object);
      }
    }
  };
  walk(value);
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function requireMergeable(plan: Plan): void {
  if (!plan.mergeable) throw new TypeError("Partial aggregation merges sum and avg only under numberMode: 'exact'; compensated and sequential sums depend on source order.");
}

/** A key that groups by object identity, which no copy can keep: plain objects, and every object under identity equality. */
function identityKey(value: unknown, byValue: boolean): boolean {
  return typeof value === 'object' && value !== null && !(byValue && (value instanceof Date || bytesOf(value) !== undefined));
}
const IDENTITY = 'Partial aggregation cannot carry group keys that group by identity: objects other than value-mode Dates and binary values.';

/**
 * A finished partial scan as plain data. The group table's key arrays are handed over, not copied: the execution ends
 * here and nothing else holds them. Identity keys fail here, after the scan, because only the finished table knows
 * every key; checking each new group during the scan would put a branch into the hot loop for an error path.
 */
export function exportPartial(plan: Plan, revision: string | number | bigint, scanned: number, matched: number, table: GroupTable | undefined, states: readonly StateColumns[], ledger: Ledger): PartialAggregate {
  const groups = table ? table.size : 1, keys = table ? table.keys : [];
  for (const column of keys) for (const key of column) if (identityKey(key, plan.byValue)) throw new TypeError(IDENTITY);
  const exported = states.map(state => state.export(groups));
  return { format: PARTIAL_FORMAT, signature: plan.signature, revision, scannedRows: scanned, matchedRows: matched, groups, keys, states: exported, peakWorkingBytes: ledger.peak };
}

/** Partials whose envelopes and column shapes were validated; values are validated while they are merged. */
export class MergeInput {
  constructor(readonly partials: readonly PartialAggregate[], readonly revision: string | number | bigint) {}
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const column = (value: unknown, length: number) => value instanceof Float64Array && value.length === length;

/**
 * Validates envelopes and column shapes of every partial before any state is allocated, so a wrong format, plan or
 * revision fails without work. Per-value checks would cost a second pass here; they run while the values are merged.
 * VERIFIED: src/compute/partial.test.ts 'reject malformed partials' covers each envelope and column check.
 */
export function mergeInput(plan: Plan, partials: unknown): MergeInput {
  requireMergeable(plan);
  if (!Array.isArray(partials) || !partials.length) throw new TypeError('merge() needs a nonempty array of partials.');
  let revision: string | number | bigint | undefined;
  partials.forEach((partial: unknown, i) => {
    const at = `partials[${i}]`;
    if (typeof partial !== 'object' || partial === null) throw malformed(`${at} is not an object`);
    const p = partial as Record<string, unknown>;
    if (p.format !== PARTIAL_FORMAT) throw new TypeError(`${at} has partial format ${typeof p.format === 'number' ? p.format : typeof p.format}; this version reads format ${PARTIAL_FORMAT}.`);
    if (p.signature !== plan.signature) throw new TypeError(`${at} comes from a different plan.`);
    const r = p.revision;
    if (typeof r !== 'string' && typeof r !== 'number' && typeof r !== 'bigint') throw malformed(`${at}.revision`);
    if (i === 0) revision = r;
    else if (r !== revision) throw new DataviewError('SOURCE_CONTRACT', 'Partials come from different snapshot revisions.');
    if (!count(p.scannedRows) || !count(p.matchedRows) || (p.matchedRows as number) > (p.scannedRows as number)) throw malformed(`${at} row counts`);
    const groups = p.groups as number;
    if (!count(groups) || (!plan.groupBy.length && groups !== 1)) throw malformed(`${at}.groups`);
    const keys = p.keys, states = p.states;
    if (!Array.isArray(keys) || keys.length !== plan.groupBy.length || keys.some(k => !Array.isArray(k) || k.length !== groups)) throw malformed(`${at}.keys`);
    if (!Array.isArray(states) || states.length !== plan.states.length) throw malformed(`${at}.states`);
    plan.states.forEach(({ kind }, s) => {
      const state = states[s] as Record<string, unknown> | null;
      if (typeof state !== 'object' || state === null) throw malformed(`${at}.states[${s}]`);
      const ok = kind === 'rows' || kind === 'count' ? column(state.counts, groups)
        : kind === 'sum' ? column(state.counts, groups) && column(state.offsets, groups + 1) && state.terms instanceof Float64Array
          && (state.offsets as Float64Array)[0] === 0 && (state.offsets as Float64Array)[groups] === state.terms.length
        : Array.isArray(state.values) && state.values.length === groups;
      if (!ok) throw malformed(`${at}.states[${s}] does not match a ${kind} state of ${groups} groups`);
    });
  });
  return new MergeInput(partials as PartialAggregate[], revision!);
}

/**
 * Folds validated partials, in the given order, into the merge's group table and state columns. A group gets its id
 * at its first part, so groups keep first-encounter order across parts given in source order.
 */
export async function absorb(input: MergeInput, plan: Plan, table: GroupTable | undefined, states: readonly StateColumns[], ensure: (gid: number) => void, signal: CancellationSignal | undefined): Promise<{ scanned: number; matched: number }> {
  let scanned = 0, matched = 0, work = 0;
  const width = plan.groupBy.length, tuple: unknown[] = Array.from({ length: width });
  for (const part of input.partials) {
    scanned += part.scannedRows; matched += part.matchedRows;
    if (!Number.isSafeInteger(scanned)) throw new RangeError('scanned rows exceeds Number.MAX_SAFE_INTEGER.');
    const parts: readonly PartialState[] = part.states;
    for (let g = 0; g < part.groups; g++) {
      if (++work % 4096 === 0) { abort(signal); if (work % 65536 === 0) await yieldToHost(); }
      let gid = 0;
      if (table) {
        for (let k = 0; k < width; k++) {
          const key = part.keys[k][g];
          if (identityKey(key, plan.byValue)) throw new TypeError(IDENTITY);
          tuple[k] = key;
        }
        const before = table.size;
        gid = table.find(tuple);
        if (gid === before) ensure(gid);
      }
      for (let s = 0; s < states.length; s++) states[s].merge(gid, parts[s], g, plan.ops);
    }
  }
  return { scanned, matched };
}
