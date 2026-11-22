import { describe, expect, it } from 'vitest';
import fixture from '../../tests/compute/mongodb-calendar.json' with { type: 'json' };
import { forRows } from '../compute.js';
import { createArraySource } from '../stream.js';
import { add, diff, part, truncate, WEEKDAYS, zoneFor } from './dates.js';
import type { DatePart, DateUnit } from './dates.js';

// VERIFIED: tests/compute/mongodb-calendar.json holds MongoDB 9.0.8's answers (scripts/mongodb-calendar-fixture.mjs,
// 2026-11-22) for 900 cases each of $dateTrunc (binSize, startOfWeek), date parts, $dateAdd and $dateDiff in 11 time
// zones, half of them within a day of a transition. A case is skipped where this runtime's time zone data gives other
// offsets than MongoDB's did (Bun 1.4.3 still has older rules for America/Havana).
const SIZE: Partial<Record<string, number>> = { millisecond: 1, second: 1000, minute: 60_000, hour: 3_600_000 };
const REF = Date.UTC(2000, 0, 1);
const zone = (name: string) => zoneFor(name, 'test');
const sameData = (name: string, instants: number[], offsets: number[]) => instants.every((t, i) => zone(name).offset(t) / 60_000 === offsets[i]);

describe('calendar functions match MongoDB', () => {
  it('dateTrunc with bins and week starts, except where 0.8.0 chose Temporal', () => {
    let compared = 0, skipped = 0;
    const divergences: string[] = [];
    for (const [t, unit, bin, sow, name, want, offsets] of fixture.trunc as [number, DateUnit, number, string, string, number, number[]][]) {
      if (!sameData(name, [t, want], offsets)) { skipped++; continue; }
      const z = zone(name), got = truncate(t, unit, z, bin, unit === 'week' ? WEEKDAYS.indexOf(sow as never) : 0);
      compared++;
      if (got === want) continue;
      const size = SIZE[unit], ref = z.dayStart(Math.round(REF / 86_400_000));
      if (bin === 1 && size !== undefined && want === ref + Math.floor((t - ref) / size) * size && (z.offset(t) - z.offset(ref)) % size !== 0) {
        // MongoDB counts single hours and minutes from the offset of 2000-01-01; dataview's are local wall-clock units.
        divergences.push(`${name} ${unit}`);
        continue;
      }
      if (want > t && got <= t && size === undefined) {
        // A transition repeats midnight: MongoDB starts the day at the second midnight, after the instant itself.
        divergences.push(`${name} ${unit} repeated midnight`);
        continue;
      }
      expect.fail(`${new Date(t).toISOString()} ${unit} bin ${bin} ${sow} ${name}: ${new Date(got).toISOString()}, MongoDB ${new Date(want).toISOString()}`);
    }
    expect(compared).toBeGreaterThan(850);
    expect(skipped).toBeLessThan(20);
    for (const d of divergences) expect(d).toMatch(/^(Australia\/Lord_Howe (hour|minute)|Asia\/Colombo (hour|minute)|\S+ (day|week|month|quarter|year) repeated midnight)$/);
  });
  it('date parts', () => {
    let compared = 0;
    for (const [t, which, name, want, offsets] of fixture.part as [number, DatePart, string, number, number[]][]) {
      if (!sameData(name, [t], offsets)) continue;
      compared++;
      expect(part(t, which, zone(name)), `${new Date(t).toISOString()} ${which} ${name}`).toBe(want);
    }
    expect(compared).toBeGreaterThan(850);
  });
  it('dateAdd', () => {
    let compared = 0;
    for (const [t, unit, n, name, want, offsets] of fixture.add as [number, DateUnit, number, string, number, number[]][]) {
      if (!sameData(name, [t, want], offsets)) continue;
      compared++;
      expect(add(t, unit, n, zone(name)), `${new Date(t).toISOString()} ${n} ${unit} ${name}`).toBe(want);
    }
    expect(compared).toBeGreaterThan(850);
  });
  it('dateDiff', () => {
    let compared = 0;
    for (const [s, e, unit, sow, name, want, offsets] of fixture.diff as [number, number, DateUnit, string, string, number, number[]][]) {
      if (!sameData(name, [s, e], offsets)) continue;
      compared++;
      expect(diff(s, e, unit, zone(name), WEEKDAYS.indexOf(sow as never)), `${new Date(s).toISOString()} to ${new Date(e).toISOString()} ${unit} ${sow} ${name}`).toBe(want);
    }
    expect(compared).toBeGreaterThan(850);
  });
});

type Row = { id: number; at?: unknown; n?: unknown };
const q = forRows<Row>();
const at = q.field('at');
const evaluate = async (select: Record<string, unknown>, rows: Row[], invalidNumbers?: 'skip') =>
  (await q.rows({ select: select as never, ...(invalidNumbers ? { invalidNumbers } : {}) }).evaluate(createArraySource(rows, { isolation: 'immutable' }))).rows;

describe('calendar expressions', () => {
  it('take bins, week starts, amounts and time zones from the descriptor', async () => {
    // Values from the MongoDB probes of 2026-11-22: Wednesday 2026-11-18T13:47:31.789Z.
    const rows = await evaluate({
      bins: q.dateTrunc(at, 'hour', { binSize: 5, timeZone: 'Europe/Berlin' }),
      wed: q.dateTrunc(at, 'week', { startOfWeek: 'wednesday', binSize: 2 }),
      sunday: q.dateTrunc(at, 'week', { startOfWeek: 'sunday' }),
      ms: q.dateTrunc(at, 'millisecond', { binSize: 250 }),
      second: q.dateTrunc(at, 'second'),
      later: q.dateAdd(at, 'month', q.number(q.field('n')), { timeZone: 'Europe/Berlin' }),
      months: q.dateDiff(q.literal(new Date('2026-01-31T23:00:00Z')), q.literal(new Date('2026-02-01T00:00:00Z')), 'month'),
      weeks: q.dateDiff(q.literal(new Date('2026-11-14T12:00:00Z')), q.literal(new Date('2026-11-15T12:00:00Z')), 'week', { startOfWeek: 'sunday' }),
      date: q.toDate(q.literal(1_000)),
      iso: q.datePart(at, 'isoWeek'), day: q.datePart(at, 'dayOfYear'), msPart: q.datePart(at, 'millisecond'),
    }, [{ id: 1, at: new Date('2026-11-18T13:47:31.789Z'), n: 3 }]);
    expect(rows).toEqual([{
      bins: new Date('2026-11-18T12:00:00Z'), wed: new Date('2026-11-18T00:00:00Z'), sunday: new Date('2026-11-15T00:00:00Z'),
      ms: new Date('2026-11-18T13:47:31.750Z'), second: new Date('2026-11-18T13:47:31Z'), later: new Date('2027-02-18T13:47:31.789Z'),
      months: 1, weeks: 1, date: new Date(1_000), iso: 47, day: 322, msPart: 789,
    }]);
  });
  it('give null for nullish operands and follow invalidNumbers for amounts', async () => {
    const select = { later: q.dateAdd(at, 'day', q.number(q.field('n'))), span: q.dateDiff(at, q.field('n'), 'day'), date: q.toDate(q.field('n')) };
    expect(await evaluate(select, [{ id: 1, at: null, n: 1 }, { id: 2, at: new Date(0) }])).toEqual([{ later: null, span: null, date: new Date(1) }, { later: null, span: null, date: null }]);
    await expect(evaluate({ later: q.dateAdd(at, 'day', q.literal(1.5)) }, [{ id: 1, at: new Date(0) }])).rejects.toThrow('integer');
    expect(await evaluate({ later: q.dateAdd(at, 'day', q.literal(1.5)) }, [{ id: 1, at: new Date(0) }], 'skip')).toEqual([{ later: null }]);
    await expect(evaluate({ later: q.dateAdd(at, 'year', q.literal(300_000)) }, [{ id: 1, at: new Date(0) }])).rejects.toThrow(RangeError);
  });
  it('reject invalid units, bins and week starts when the plan is prepared', () => {
    expect(() => q.rows({ select: { x: q.dateTrunc(at, 'hour', { binSize: 0 }) } })).toThrow('binSize');
    expect(() => q.rows({ select: { x: q.dateTrunc(at, 'hour', { binSize: 1.5 }) } })).toThrow('binSize');
    expect(() => q.rows({ select: { x: q.dateTrunc(at, 'week', { startOfWeek: 'Mon' as never }) } })).toThrow('startOfWeek');
    expect(() => q.rows({ select: { x: q.dateAdd(at, 'fortnight' as never, q.literal(1)) } })).toThrow('dateAdd takes one of');
    expect(() => q.rows({ select: { x: q.dateDiff(at, at, 'day', { timeZone: 'Mars/Olympus' }) } })).toThrow('unknown time zone');
  });
});
