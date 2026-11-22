/**
 * Calendar truncation and parts for dateTrunc() and datePart(), in UTC or an IANA time zone. Time zones go through
 * Intl.DateTimeFormat, which every supported runtime has; Temporal would be simpler, but Node.js 20 to 24 lack it. Results follow Temporal: a day, week, month, quarter or year starts at the first instant of its
 * first local day, and an hour or minute keeps the instant's own offset when the truncated wall time has it.
 * VERIFIED: src/compute/dates.test.ts compares every unit and part with Temporal in zones with DST gaps and repeated
 * hours at midnight, a 30-minute DST shift and a 45-minute offset.
 */
export type DateUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond';
export type DatePart = 'year' | 'quarter' | 'month' | 'day' | 'weekday' | 'hour' | 'minute' | 'second' | 'millisecond' | 'dayOfYear' | 'isoWeek' | 'isoWeekYear';
/** dateAdd() and dateDiff() take the units of dateTrunc(). */
export type SpanUnit = DateUnit;
export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export const DATE_UNITS: ReadonlySet<string> = new Set<DateUnit>(['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond']);
/** dateAdd() and dateDiff() take the units of dateTrunc(). */
export const SPAN_UNITS = DATE_UNITS;
export const DATE_PARTS: ReadonlySet<string> = new Set<DatePart>(['year', 'quarter', 'month', 'day', 'weekday', 'hour', 'minute', 'second', 'millisecond', 'dayOfYear', 'isoWeek', 'isoWeekYear']);
/** Index 0 is Monday, the default start of a week. */
export const WEEKDAYS: readonly Weekday[] = Object.freeze(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** Milliseconds of the units below a day; days and longer follow the local calendar instead. */
const SIZE: Partial<Record<string, number>> = { millisecond: 1, second: 1000, minute: MINUTE, hour: HOUR };
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

/** Day number of 2000-01-01, where MongoDB starts counting bins. */
const REF_DAY = days(2000, 1, 1);
/** Weekday index of a day number, 0 = Monday: day 0 (1970-01-01) was a Thursday. */
const weekday = (day: number) => mod(day + 3, 7);

/**
 * The start of the unit containing `t`. A bin of `bin` units counts from 2000-01-01 as MongoDB's $dateTrunc does:
 * units below a day in elapsed time from that day's local midnight, days and weeks in local days (weeks from the
 * first `weekStart` day on or after it), months, quarters and years in local months from January 2000.
 * VERIFIED: MongoDB 9.0.8 on this host, 2026-11-22, for every unit with and without binSize in UTC, Europe/Berlin
 * (also on DST days), Asia/Kolkata, America/Caracas and Asia/Kathmandu; src/compute/calendar.test.ts replays them.
 * A single unit below a day stays the wall-clock unit of 0.8.0, which agrees with MongoDB except in zones whose
 * offset differs from their offset of 2000-01-01 by part of the unit (Australia/Lord_Howe in winter).
 */
export function truncate(t: number, unit: DateUnit, zone: Zone, bin = 1, weekStart = 0): number {
  const size = SIZE[unit];
  if (size !== undefined && bin > 1) {
    const ref = zone.dayStart(REF_DAY), span = size * bin;
    return ref + Math.floor((t - ref) / span) * span;
  }
  if (unit === 'millisecond') return t;
  // Offsets are whole seconds, so local seconds start where UTC seconds do.
  if (unit === 'second') return t - mod(t, 1000);
  const offset = zone.offset(t), local = t + offset;
  if (unit === 'minute' || unit === 'hour') {
    const w = local - mod(local, size!);
    return zone === UTC ? w : resolve(zone, w, offset);
  }
  let day = Math.floor(local / DAY);
  if (unit === 'day') { if (bin > 1) day = REF_DAY + Math.floor((day - REF_DAY) / bin) * bin; }
  else if (unit === 'week') {
    day -= mod(weekday(day) - weekStart, 7);
    if (bin > 1) { const ref = REF_DAY + mod(weekStart - weekday(REF_DAY), 7), span = 7 * bin; day = ref + Math.floor((day - ref) / span) * span; }
  } else {
    civil(day);
    const span = (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1) * bin, index = Math.floor(((Y - 2000) * 12 + M - 1) / span) * span;
    day = days(2000 + Math.floor(index / 12), mod(index, 12) + 1, 1);
  }
  return zone.dayStart(day);
}

const monthDays = (year: number, month: number) => (month === 12 ? days(year + 1, 1, 1) : days(year, month + 1, 1)) - days(year, month, 1);
/**
 * `t` plus `n` units, as MongoDB's $dateAdd: units below a day add elapsed time; days and weeks keep the local wall
 * clock; months, quarters and years keep it too and clamp the day to the end of a shorter month (Jan 31 + 1 month is
 * Feb 28 or 29). A wall time keeps the offset `t` had when it can, else takes the earlier instant, or the time past a
 * gap. VERIFIED: MongoDB 9.0.8, 2026-11-22: in Europe/Berlin adding a day from 02:30 CEST into the repeated hour gave
 * 02:30 CEST and from 02:30 CET gave 02:30 CET; into the spring gap it gave 03:30 CEST.
 */
export function add(t: number, unit: DateUnit, n: number, zone: Zone): number {
  const size = SIZE[unit];
  if (size !== undefined) return t + n * size;
  const offset = zone.offset(t), local = t + offset, day = Math.floor(local / DAY), time = local - day * DAY;
  let target: number;
  if (unit === 'day' || unit === 'week') target = day + n * (unit === 'week' ? 7 : 1);
  else {
    civil(day);
    const index = Y * 12 + M - 1 + n * (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1), year = Math.floor(index / 12), month = mod(index, 12) + 1;
    target = days(year, month, Math.min(D, monthDays(year, month)));
  }
  const w = target * DAY + time;
  return zone === UTC ? w : resolve(zone, w, offset);
}

/**
 * Units from `s` to `e`, negative when `e` is earlier, as MongoDB's $dateDiff counts them: boundaries crossed, not
 * whole units elapsed. Days and longer compare local calendar dates (weeks from `weekStart`); smaller units compare
 * local wall times less the whole units of an offset change, so a repeated hour still counts.
 * VERIFIED: MongoDB 9.0.8, 2026-11-22: Jan 31 23:00 to Feb 1 00:00 is 1 month and 1 day; 02:30 CEST to 02:30 CET in
 * Europe/Berlin is 1 hour; in Australia/Lord_Howe, whose offset changes by 30 minutes, 01:50 (+11) to 01:40 (+10:30)
 * is 0 hours and 01:50 (+10:30) to 02:40 (+11) is 1.
 */
export function diff(s: number, e: number, unit: DateUnit, zone: Zone, weekStart = 0): number {
  const size = SIZE[unit];
  if (size === 1) return e - s;
  const os = zone.offset(s), oe = zone.offset(e);
  if (size !== undefined) return Math.floor((e + oe) / size) - Math.floor((s + os) / size) - Math.trunc((oe - os) / size);
  const ds = Math.floor((s + os) / DAY), de = Math.floor((e + oe) / DAY);
  if (unit === 'day') return de - ds;
  if (unit === 'week') return (de - mod(weekday(de) - weekStart, 7) - (ds - mod(weekday(ds) - weekStart, 7))) / 7;
  civil(ds); const is = Y * 12 + M - 1;
  civil(de); const ie = Y * 12 + M - 1;
  const span = unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1;
  return Math.floor(ie / span) - Math.floor(is / span);
}

export function part(t: number, which: DatePart, zone: Zone): number {
  const local = t + zone.offset(t), day = Math.floor(local / DAY);
  switch (which) {
    case 'weekday': return weekday(day) + 1;
    case 'hour': return Math.floor(mod(local, DAY) / HOUR);
    case 'minute': return Math.floor(mod(local, HOUR) / MINUTE);
    case 'second': return Math.floor(mod(local, MINUTE) / 1000);
    case 'millisecond': return mod(local, 1000);
    case 'isoWeek': case 'isoWeekYear': {
      // An ISO week belongs to the year of its Thursday; week 1 holds the year's first Thursday.
      const thursday = day - weekday(day) + 3;
      civil(thursday);
      return which === 'isoWeekYear' ? Y : Math.floor((thursday - days(Y, 1, 1)) / 7) + 1;
    }
  }
  civil(day);
  if (which === 'dayOfYear') return day - days(Y, 1, 1) + 1;
  return which === 'year' ? Y : which === 'month' ? M : which === 'day' ? D : Math.floor((M - 1) / 3) + 1;
}
