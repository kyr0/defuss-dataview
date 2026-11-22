import { describe, expect, it } from 'vitest';
import { forRows } from '../compute.js';
import { createArraySource } from '../stream.js';
import { WEEKDAYS } from './dates.js';
import type { DatePart, DateUnit } from './dates.js';

type Row = { id: number; at?: unknown };
const q = forRows<Row>();
const UNITS: DateUnit[] = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'];
const PARTS: DatePart[] = ['year', 'quarter', 'month', 'day', 'weekday', 'hour', 'minute', 'second', 'millisecond', 'dayOfYear', 'isoWeek', 'isoWeekYear'];
const source = (values: unknown[]) => createArraySource(values.map((at, id) => ({ id, at })), { isolation: 'immutable' });
async function evaluate(values: unknown[], timeZone?: string, invalidNumbers?: 'skip') {
  const at = q.field('at');
  const select = Object.fromEntries([
    ...UNITS.map(unit => [unit, q.dateTrunc(at, unit, { timeZone })]),
    ...PARTS.map(p => [`part:${p}`, q.datePart(at, p, { timeZone })]),
    ['sundayWeek', q.dateTrunc(at, 'week', { timeZone, startOfWeek: 'sunday' })],
  ]);
  return (await q.rows({ select, ...(invalidNumbers ? { invalidNumbers } : {}) }).evaluate(source(values))).rows as Record<string, unknown>[];
}

// Temporal is the reference: Node.js 26 and Bun have it, Node.js 22 and 24 (the CI matrix) do not.
type Zoned = {
  epochMilliseconds: number; year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number;
  dayOfWeek: number; dayOfYear: number; weekOfYear: number; yearOfWeek: number; offset: string;
  round(options: object): Zoned; startOfDay(): Zoned; toPlainDate(): PlainDate; toPlainDateTime(): PlainDateTime;
  getTimeZoneTransition(direction: 'next'): Zoned | null;
};
type Plain = { toZonedDateTime(zone: string): Zoned };
type PlainDate = Plain & { with(fields: object): Plain; subtract(d: object): PlainDate; since(other: PlainDate): { days: number }; dayOfWeek: number };
type PlainDateTime = { add(d: object, options: object): Record<string, number> };
const Temporal = (globalThis as { Temporal?: {
  Instant: { fromEpochMilliseconds(ms: number): { toZonedDateTimeISO(zone: string): Zoned } };
  ZonedDateTime: { from(fields: object, options: object): Zoned };
} }).Temporal;
function expected(t: number, zone: string): Record<string, unknown> {
  const z = Temporal!.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO(zone), date = z.toPlainDate();
  const at = (plain: Plain) => new Date(plain.toZonedDateTime(zone).epochMilliseconds);
  return {
    year: at(date.with({ month: 1, day: 1 })), quarter: at(date.with({ month: z.month - (z.month - 1) % 3, day: 1 })),
    month: at(date.with({ day: 1 })), week: at(date.subtract({ days: z.dayOfWeek - 1 })), day: new Date(z.startOfDay().epochMilliseconds),
    hour: new Date(z.round({ smallestUnit: 'hour', roundingMode: 'floor' }).epochMilliseconds),
    minute: new Date(z.round({ smallestUnit: 'minute', roundingMode: 'floor' }).epochMilliseconds),
    second: new Date(z.round({ smallestUnit: 'second', roundingMode: 'floor' }).epochMilliseconds), millisecond: new Date(t),
    'part:year': z.year, 'part:quarter': Math.floor((z.month - 1) / 3) + 1, 'part:month': z.month, 'part:day': z.day,
    'part:weekday': z.dayOfWeek, 'part:hour': z.hour, 'part:minute': z.minute, 'part:second': z.second, 'part:millisecond': z.millisecond,
    'part:dayOfYear': z.dayOfYear, 'part:isoWeek': z.weekOfYear, 'part:isoWeekYear': z.yearOfWeek,
    sundayWeek: at(date.subtract({ days: z.dayOfWeek % 7 })),
  };
}

const fields = (local: Record<string, number>) => ({ year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute, second: local.second, millisecond: local.millisecond });
// Zones whose transitions skip or repeat midnight, shift by 30 minutes, or sit at 45 minutes past the hour.
const ZONES = ['UTC', 'Europe/Berlin', 'America/New_York', 'America/Sao_Paulo', 'America/Havana', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Apia'];
describe('dateTrunc and datePart', () => {
  it.skipIf(!Temporal)('match Temporal around every transition from 2010 to 2026 and at random instants', async () => {
    let seed = 9;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (const zone of ZONES) {
      const instants: number[] = [];
      let z: Zoned | null = Temporal!.Instant.fromEpochMilliseconds(Date.UTC(2010, 0, 1)).toZonedDateTimeISO(zone);
      while ((z = z.getTimeZoneTransition('next')) && z.epochMilliseconds < Date.UTC(2027, 0, 1)) {
        for (const delta of [-86_400_000, -3_600_001, -1_800_000, -60_000, -1, 0, 1, 59_999, 1_800_000, 3_600_000, 86_400_000]) instants.push(z.epochMilliseconds + delta);
      }
      for (let i = 0; i < 400; i++) instants.push(Math.floor(Date.UTC(1900, 0, 1) + random() * 250 * 365.25 * 86_400_000));
      const rows = await evaluate(instants.map(t => new Date(t)), zone);
      rows.forEach((row, i) => expect(row, `${zone} ${new Date(instants[i]).toISOString()}`).toEqual(expected(instants[i], zone)));
    }
  });

  it.skipIf(!Temporal)('add calendar units and count their boundaries as Temporal does, keeping the offset where it can', async () => {
    // dateAdd: Temporal's PlainDateTime.add (months constrained to the month's end), then the wall time in the zone with
    // offset: 'prefer' (the start's offset where valid, else compatible), the rule MongoDB follows (calendar.test.ts).
    let seed = 5;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const units = ['year', 'quarter', 'month', 'week', 'day'] as const;
    for (const zone of ZONES) {
      const starts: number[] = [];
      let z: Zoned | null = Temporal!.Instant.fromEpochMilliseconds(Date.UTC(2012, 0, 1)).toZonedDateTimeISO(zone);
      while ((z = z.getTimeZoneTransition('next')) && z.epochMilliseconds < Date.UTC(2027, 0, 1)) for (const d of [-3_600_000, -1, 0, 1_800_000]) starts.push(z.epochMilliseconds + d - 86_400_000);
      for (let i = 0; i < 100; i++) starts.push(Math.floor(Date.UTC(1990, 0, 1) + random() * 45 * 365.25 * 86_400_000));
      const cases = starts.map((t, id) => ({ id, at: new Date(t), n: Math.round((random() - 0.5) * 30), unit: units[Math.floor(random() * units.length)], to: new Date(t + (random() - 0.5) * 8e9), w: Math.floor(random() * 7) }));
      for (const unit of units) for (const w of [0, 6]) {
        const subset = cases.filter(c => c.unit === unit);
        const plan = forRows<typeof cases[number]>();
        const rows = (await plan.rows({ select: {
          added: plan.dateAdd(plan.field('at'), unit, plan.field('n'), { timeZone: zone }),
          span: plan.dateDiff(plan.field('at'), plan.field('to'), unit, { timeZone: zone, startOfWeek: WEEKDAYS[w] }),
        } }).evaluate(createArraySource(subset, { isolation: 'immutable' }))).rows;
        subset.forEach((c, i) => {
          const from = Temporal!.Instant.fromEpochMilliseconds(c.at.getTime()).toZonedDateTimeISO(zone), end = Temporal!.Instant.fromEpochMilliseconds(c.to.getTime()).toZonedDateTimeISO(zone);
          const months = unit === 'year' ? 12 * c.n : unit === 'quarter' ? 3 * c.n : unit === 'month' ? c.n : 0;
          const local = from.toPlainDateTime().add(months ? { months } : { days: c.n * (unit === 'week' ? 7 : 1) }, { overflow: 'constrain' });
          const added = Temporal!.ZonedDateTime.from({ ...fields(local), timeZone: zone, offset: from.offset }, { offset: 'prefer', disambiguation: 'compatible' });
          const weekOf = (d: PlainDate) => d.subtract({ days: (d.dayOfWeek - 1 - w + 7) % 7 });
          const index = (x: Zoned) => x.year * 12 + x.month - 1;
          const span = unit === 'day' ? end.toPlainDate().since(from.toPlainDate()).days
            : unit === 'week' ? weekOf(end.toPlainDate()).since(weekOf(from.toPlainDate())).days / 7
              : Math.floor(index(end) / (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1)) - Math.floor(index(from) / (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1));
          expect(rows[i], `${zone} ${c.at.toISOString()} ${c.n} ${unit} / to ${c.to.toISOString()} week from ${WEEKDAYS[w]}`).toEqual({ added: new Date(added.epochMilliseconds), span });
        });
      }
    }
  });

  it('start a local day, week or month at its first instant, also when a transition skips or repeats midnight', async () => {
    // VERIFIED: the expected instants are Temporal's (Node.js 26.13.1), so this test also runs where Temporal is missing.
    const day = async (iso: string, zone: string, unit: DateUnit = 'day') => ((await evaluate([new Date(iso)], zone))[0][unit] as Date).toISOString();
    expect(await day('2018-11-04T12:00:00Z', 'America/Sao_Paulo')).toBe('2018-11-04T03:00:00.000Z');
    expect(await day('2018-11-04T12:00:00Z', 'America/Sao_Paulo', 'week')).toBe('2018-10-29T03:00:00.000Z');
    expect(await day('2018-11-04T12:00:00Z', 'America/Sao_Paulo', 'month')).toBe('2018-11-01T03:00:00.000Z');
    expect(await day('2024-11-03T12:00:00Z', 'America/Havana')).toBe('2024-11-03T04:00:00.000Z');
    expect(await day('2024-03-31T12:00:00Z', 'Europe/Berlin')).toBe('2024-03-30T23:00:00.000Z');
    expect(await day('2024-10-27T12:00:00Z', 'Europe/Berlin', 'hour')).toBe('2024-10-27T12:00:00.000Z');
    expect(await day('2024-10-27T00:30:00Z', 'Europe/Berlin', 'hour')).toBe('2024-10-27T00:00:00.000Z');
    expect(await day('2024-10-27T01:30:00Z', 'Europe/Berlin', 'hour')).toBe('2024-10-27T01:00:00.000Z');
    expect(await day('2024-06-01T10:20:00Z', 'Asia/Kathmandu', 'hour')).toBe('2024-06-01T10:15:00.000Z');
    expect(await day('2024-06-01T00:00:00Z', 'Australia/Lord_Howe', 'year')).toBe('2023-12-31T13:00:00.000Z');
  });

  it('read Dates and epoch milliseconds, give null for nullish and invalid Dates, and reject other values', async () => {
    const [fromDate, fromNumber, nil, missing, invalid] = await evaluate([new Date(Date.UTC(2024, 4, 15, 13, 45, 10)), Date.UTC(2024, 4, 15, 13, 45, 10), null, undefined, new Date(NaN)]);
    expect(fromNumber).toEqual(fromDate);
    expect(fromDate).toMatchObject({
      year: new Date(Date.UTC(2024, 0, 1)), quarter: new Date(Date.UTC(2024, 3, 1)), week: new Date(Date.UTC(2024, 4, 13)), minute: new Date(Date.UTC(2024, 4, 15, 13, 45)),
      'part:quarter': 2, 'part:month': 5, 'part:day': 15, 'part:weekday': 3, 'part:hour': 13, 'part:minute': 45,
    });
    for (const row of [nil, missing, invalid]) for (const value of Object.values(row)) expect(value).toBeNull();
    await expect(evaluate(['2024-05-15'])).rejects.toThrow(/Date or epoch milliseconds/);
    await expect(evaluate([8.64e15 + 1])).rejects.toThrow(TypeError);
    expect(Object.values((await evaluate(['2024-05-15', NaN], undefined, 'skip'))[1]).every(v => v === null)).toBe(true);
    const [early] = await evaluate([new Date('0050-07-04T10:00:00Z')], 'Europe/Berlin');
    expect(early['part:year']).toBe(50);
    // At the ends of the Date range, Intl throws for instants a day beyond; a period starting before the range is null.
    const [last, first] = await evaluate([new Date(8.64e15), new Date(-8.64e15)], 'Asia/Tokyo');
    expect(last).toMatchObject({ day: new Date(8.64e15 - 9 * 3_600_000), 'part:hour': 9 });
    // Tokyo's offset before 1888 was its local mean time, +09:18:59, so even the first minute starts before the range.
    expect(first).toMatchObject({ day: null, minute: null, 'part:hour': 9, 'part:minute': 18 });
  });

  it('take Date arithmetic through epochMs: durations, their measures, and the same operand rules', async () => {
    type Span = { id: number; from?: unknown; to?: unknown };
    const s = forRows<Span>(), from = s.field('from'), to = s.field('to');
    const day = 86_400_000, start = Date.UTC(2024, 4, 1);
    const spans: Span[] = [
      { id: 0, from: new Date(start), to: new Date(start + 2 * day) }, { id: 1, from: start, to: new Date(start + day / 2) },
      { id: 2, from: new Date(start), to: null }, { id: 3, from: new Date(NaN), to: new Date(start) }, { id: 4 },
    ];
    const plan = s.rows({ select: { ms: s.epochMs(from), days: s.div(s.sub(s.epochMs(to), s.epochMs(from)), s.literal(day)) } });
    const { rows } = await plan.evaluate(createArraySource(spans, { isolation: 'immutable' }));
    expect(rows).toEqual([{ ms: start, days: 2 }, { ms: start, days: 0.5 }, { ms: start, days: null }, { ms: null, days: null }, { ms: null, days: null }]);
    const stats = s.aggregate({ measures: { mean: s.avg(s.sub(s.epochMs(to), s.epochMs(from))), longest: s.max(s.sub(s.epochMs(to), s.epochMs(from))) } });
    expect((await stats.evaluate(createArraySource(spans, { isolation: 'immutable' }))).rows).toEqual([{ mean: 1.25 * day, longest: 2 * day }]);
    // sub itself stays numeric: under the default policy a Date operand throws, so a missing epochMs() never becomes NaN.
    const bare = s.rows({ select: { d: s.sub(to as never, from as never) } });
    await expect(bare.evaluate(createArraySource(spans.slice(0, 1), { isolation: 'immutable' }))).rejects.toThrow(/finite number/);
    const skipped = s.rows({ select: { d: s.sub(to as never, from as never) }, invalidNumbers: 'skip' });
    expect((await skipped.evaluate(createArraySource(spans.slice(0, 1), { isolation: 'immutable' }))).rows).toEqual([{ d: null }]);
    const read = (values: unknown[], invalidNumbers?: 'skip') => s.rows({ select: { ms: s.epochMs(from) }, ...(invalidNumbers ? { invalidNumbers } : {}) })
      .evaluate(createArraySource(values.map((value, id) => ({ id, from: value })), { isolation: 'immutable' }));
    await expect(read(['2024-05-01'])).rejects.toThrow(/epochMs\(\) needs a Date or epoch milliseconds/);
    await expect(read([8.64e15 + 1])).rejects.toThrow(TypeError);
    expect((await read(['2024-05-01', 8.64e15], 'skip')).rows).toEqual([{ ms: null }, { ms: 8.64e15 }]);
  });

  it('reject unknown units, parts and time zones when the plan is prepared', () => {
    const at = q.field('at');
    expect(() => q.rows({ select: { x: q.dateTrunc(at, 'decade' as never) } })).toThrow(TypeError);
    expect(() => q.rows({ select: { x: q.datePart(at, 'week' as never) } })).toThrow(TypeError);
    expect(() => q.rows({ select: { x: q.dateTrunc(at, 'day', { timeZone: 'Mars/Olympus' }) } })).toThrow(/unknown time zone/);
    expect(() => q.rows({ select: { x: q.dateTrunc(at, 'day', { timeZone: '' }) } })).toThrow(TypeError);
    expect(() => q.rows({ select: { x: { v: 1, op: 'dateTrunc', args: [at], unit: 'day', zone: 'UTC' } as never } })).toThrow(/unexpected property/);
  });

  it('group by local day across a DST change and merge those groups from partials', async () => {
    const hours = Array.from({ length: 72 }, (_, i) => new Date(Date.UTC(2024, 2, 29, 12) + i * 3_600_000));
    const plan = q.aggregate({ groupBy: { day: q.dateTrunc(q.field('at'), 'day', { timeZone: 'Europe/Berlin' }) }, measures: { n: q.count() } });
    const whole = await plan.evaluate(source(hours));
    expect(whole.rows.map(r => [(r.day as Date).toISOString(), r.n])).toEqual([
      ['2024-03-28T23:00:00.000Z', 11], ['2024-03-29T23:00:00.000Z', 24], ['2024-03-30T23:00:00.000Z', 23], ['2024-03-31T22:00:00.000Z', 14],
    ]);
    const parts = await Promise.all([source(hours.slice(0, 30)), source(hours.slice(30))].map(s => plan.partial(s)));
    expect((await plan.merge(parts.map(p => structuredClone(p)))).rows).toEqual(whole.rows);
  });
});
