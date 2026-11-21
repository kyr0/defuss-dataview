/**
 * Calendar truncation and parts for dateTrunc() and datePart(), in UTC or an IANA time zone. Time zones go through
 * Intl.DateTimeFormat, which every supported runtime has; Temporal would be simpler, but Node.js 20 to 24 lack it. Results follow Temporal: a day, week, month, quarter or year starts at the first instant of its
 * first local day, and an hour or minute keeps the instant's own offset when the truncated wall time has it.
 * VERIFIED: src/compute/dates.test.ts compares every unit and part with Temporal in zones with DST gaps and repeated
 * hours at midnight, a 30-minute DST shift and a 45-minute offset.
 */
export type DateUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute';
export type DatePart = 'year' | 'quarter' | 'month' | 'day' | 'weekday' | 'hour' | 'minute';
export const DATE_UNITS: ReadonlySet<string> = new Set<DateUnit>(['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute']);
export const DATE_PARTS: ReadonlySet<string> = new Set<DatePart>(['year', 'quarter', 'month', 'day', 'weekday', 'hour', 'minute']);

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** The largest distance of a valid Date from the epoch, in milliseconds. */
export const DATE_RANGE = 8.64e15;
const mod = (a: number, b: number) => ((a % b) + b) % b;

// Proleptic Gregorian dates of day numbers (days since 1970-01-01) in integer arithmetic, as Date counts them: Howard
// Hinnant's days_from_civil and civil_from_days. A row allocates no Date until its result. civil() writes Y, M and D
// instead of returning a tuple; evaluation is synchronous, so nothing interleaves.
let Y = 0, M = 0, D = 0;
function civil(days: number): void {
  const z = days + 719_468, era = Math.floor(z / 146_097), doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
  D = doy - Math.floor((153 * mp + 2) / 5) + 1;
  M = mp < 10 ? mp + 3 : mp - 9;
  Y = yoe + era * 400 + (M <= 2 ? 1 : 0);
}
/** Day number of a date; month 1 to 12. */
function days(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year, era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}

export interface Zone {
  readonly name: string;
  /** Milliseconds to add to an instant to get its local wall-clock time. */
  offset(t: number): number;
  /** The first instant of local day number `day`. */
  dayStart(day: number): number;
}
const UTC: Zone = Object.freeze({ name: 'UTC', offset: () => 0, dayStart: (day: number) => day * DAY });
const UTC_NAMES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT']);

/**
 * Offsets of one named zone. A day's offset is cached when it is the same at the start of that UTC day and the next:
 * then no transition lies between them, because no zone has two transitions less than a day apart.
 * VERIFIED: Temporal's getTimeZoneTransition over every zone of Intl.supportedValuesOf('timeZone'), 1850 to 2100,
 * Node.js 26.13.1, 2026-11-21: the closest two transitions of one zone were 167 hours apart (America/Boa_Vista, 2000).
 */
class NamedZone implements Zone {
  private readonly offsets = new Map<number, number>();
  private readonly starts = new Map<number, number>();
  constructor(readonly name: string, private readonly format: Intl.DateTimeFormat) {}
  offset(t: number): number {
    const d = Math.floor(t / DAY), a = this.at(d);
    return a === this.at(d + 1) ? a : this.exact(t);
  }
  dayStart(day: number): number {
    let start = this.starts.get(day);
    if (start === undefined) {
      if (this.starts.size >= 65_536) this.starts.clear();
      start = startOfDay(this, day * DAY);
      this.starts.set(day, start);
    }
    return start;
  }
  private at(d: number): number {
    let offset = this.offsets.get(d);
    if (offset === undefined) {
      // Bounded: about 180 years of days. A clear costs one Intl call per day touched again.
      if (this.offsets.size >= 65_536) this.offsets.clear();
      offset = this.exact(d * DAY);
      this.offsets.set(d, offset);
    }
    return offset;
  }
  /**
   * The offset at `t` from the wall clock Intl formats, in whole seconds as time zone data has them. Probes a day
   * beyond the Date range read the offset at its end, where Intl would throw.
   */
  private exact(t: number): number {
    const clamped = Math.max(-DATE_RANGE, Math.min(DATE_RANGE, t)), seconds = clamped - mod(clamped, 1000);
    let year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0, bc = false;
    for (const { type, value } of this.format.formatToParts(seconds)) {
      if (type === 'year') year = Number(value);
      else if (type === 'month') month = Number(value);
      else if (type === 'day') day = Number(value);
      else if (type === 'hour') hour = Number(value);
      else if (type === 'minute') minute = Number(value);
      else if (type === 'second') second = Number(value);
      else if (type === 'era') bc = value === 'BC' || value === 'B';
    }
    return days(bc ? 1 - year : year, month, day) * DAY + hour * HOUR + minute * MINUTE + second * 1000 - seconds;
  }
}

const zones = new Map<string, Zone>();
/** The zone for a descriptor's timeZone option; undefined means UTC. Throws a TypeError for an unknown name. */
export function zoneFor(name: unknown, where: string): Zone {
  if (name === undefined) return UTC;
  if (typeof name !== 'string' || !name) throw new TypeError(`${where}: timeZone must be an IANA time zone name such as "Europe/Berlin".`);
  let zone = zones.get(name);
  if (zone) return zone;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch {
    throw new TypeError(`${where}: unknown time zone ${JSON.stringify(name)}.`);
  }
  const resolved = format.resolvedOptions().timeZone;
  zone = UTC_NAMES.has(resolved) ? UTC : new NamedZone(resolved, format);
  if (zones.size >= 64) zones.clear();
  zones.set(name, zone);
  return zone;
}

/** Instants whose local wall time is `w` in `zone`: none in a gap, two in a repeated hour. */
function instants(zone: Zone, w: number): number[] {
  const before = zone.offset(w - DAY), after = zone.offset(w + DAY), found: number[] = [];
  for (const offset of before === after ? [before] : [before, after]) {
    const t = w - offset;
    if (zone.offset(t) === offset && !found.includes(t)) found.push(t);
  }
  return found.sort((a, b) => a - b);
}
/** The first instant of a local day that starts at wall time `w`: in a gap, the transition that skips midnight. */
function startOfDay(zone: Zone, w: number): number {
  const found = instants(zone, w);
  if (found.length) return found[0];
  // The transition T lies in (w - after, w - before]; offsets are whole seconds, so bisect seconds.
  const before = zone.offset(w - DAY);
  let lo = Math.floor((w - zone.offset(w + DAY)) / 1000), hi = Math.floor((w - before) / 1000);
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (zone.offset(mid * 1000) === before) lo = mid; else hi = mid; }
  return hi * 1000;
}

/** Wall time `w` as an instant, preferring `offset`, else Temporal's compatible choice: the earlier, or past a gap. */
function resolve(zone: Zone, w: number, offset: number): number {
  if (zone.offset(w - offset) === offset) return w - offset;
  const found = instants(zone, w);
  return found.length ? found[0] : w - zone.offset(w - DAY);
}

export function truncate(t: number, unit: DateUnit, zone: Zone): number {
  const offset = zone.offset(t), local = t + offset;
  if (unit === 'minute' || unit === 'hour') {
    const size = unit === 'minute' ? MINUTE : HOUR, w = local - mod(local, size);
    return zone === UTC ? w : resolve(zone, w, offset);
  }
  let day = Math.floor(local / DAY);
  // Day 0 (1970-01-01) was a Thursday: ISO weekday index 3, Monday 0.
  if (unit === 'week') day -= mod(day + 3, 7);
  else if (unit !== 'day') { civil(day); day = days(Y, unit === 'year' ? 1 : unit === 'quarter' ? M - (M - 1) % 3 : M, 1); }
  return zone.dayStart(day);
}

export function part(t: number, which: DatePart, zone: Zone): number {
  const local = t + zone.offset(t), day = Math.floor(local / DAY);
  switch (which) {
    case 'weekday': return mod(day + 3, 7) + 1;
    case 'hour': return Math.floor(mod(local, DAY) / HOUR);
    case 'minute': return Math.floor(mod(local, HOUR) / MINUTE);
  }
  civil(day);
  return which === 'year' ? Y : which === 'month' ? M : which === 'day' ? D : Math.floor((M - 1) / 3) + 1;
}
