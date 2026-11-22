// Records MongoDB's answers for calendar cases into tests/compute/mongodb-calendar.json, which
// src/compute/calendar.test.ts replays without a server. MONGODB_URL names a running server (default
// mongodb://127.0.0.1:27017); the script only runs $documents pipelines and writes no data there.
// Cases are seeded, so a rerun against the same server version writes the same file. Each case also records MongoDB's
// UTC offsets (minutes) at its instants, so a runtime whose time zone data differs can skip it instead of failing.
import { writeFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';

const url = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017';
const OUT = 'tests/compute/mongodb-calendar.json';
const PER_KIND = 900;
// UTC; DST at 02:00 or 01:00 UTC; DST that skips or repeats midnight; a 30-minute DST shift; offsets at :30 and :45;
// zones whose offset changed since 2000 by a whole or a half hour.
const ZONES = ['UTC', 'Europe/Berlin', 'America/New_York', 'America/Havana', 'America/Santiago', 'Australia/Lord_Howe', 'Asia/Kathmandu',
  'Asia/Kolkata', 'America/St_Johns', 'Pacific/Apia', 'Asia/Colombo'];
const UNITS = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const PARTS = { year: '$year', month: '$month', day: '$dayOfMonth', hour: '$hour', minute: '$minute', second: '$second', millisecond: '$millisecond',
  dayOfYear: '$dayOfYear', isoWeek: '$isoWeek', isoWeekYear: '$isoWeekYear', weekday: '$isoDayOfWeek' };
const SPAN = { year: 3.2e10, quarter: 8e9, month: 3e9, week: 2e9, day: 5e8, hour: 4e7, minute: 4e6, second: 2e5, millisecond: 5e3 };

let seed = 20261122;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = (list) => list[Math.floor(random() * list.length)];
const START = Date.UTC(2000, 0, 1), END = Date.UTC(2036, 0, 1);
// Instants near the zones' transitions, where most calendar rules differ, and uniformly spread ones.
const near = [];
for (const zone of ZONES) {
  if (!globalThis.Temporal) break;
  let z = Temporal.Instant.fromEpochMilliseconds(START).toZonedDateTimeISO(zone);
  while ((z = z.getTimeZoneTransition('next')) && z.epochMilliseconds < END) near.push([zone, z.epochMilliseconds]);
}
const instant = (zone) => {
  const local = near.filter(([z]) => z === zone);
  if (local.length && random() < 0.5) return pick(local)[1] + Math.round((random() - 0.5) * 2 * pick([1, 60_000, 1_800_000, 3_600_000, 86_400_000]));
  return Math.floor(START + random() * (END - START));
};

const cases = { trunc: [], part: [], add: [], diff: [] };
for (let i = 0; i < PER_KIND; i++) {
  let zone = pick(ZONES), unit = pick(UNITS);
  const bin = random() < 0.4 ? 1 : pick(unit === 'millisecond' ? [2, 10, 250, 1000] : [2, 3, 4, 5, 7, 15]);
  cases.trunc.push({ t: instant(zone), unit, bin, sow: pick(WEEKDAYS), zone });
  zone = pick(ZONES);
  cases.part.push({ t: instant(zone), part: pick(Object.keys(PARTS)), zone });
  zone = pick(ZONES); unit = pick(UNITS);
  const amount = Math.round((random() - 0.5) * (random() < 0.8 ? 80 : 4000));
  cases.add.push({ t: instant(zone), unit, amount, zone });
  zone = pick(ZONES); unit = pick(UNITS);
  const t = instant(zone);
  cases.diff.push({ t, e: t + Math.round((random() - 0.5) * 2 * SPAN[unit] * (random() < 0.3 ? 0.01 : 1)), unit, sow: pick(WEEKDAYS), zone });
}

const client = await new MongoClient(url).connect();
try {
  const admin = client.db('admin');
  const version = (await admin.command({ buildInfo: 1 })).version;
  const offset = (date) => ({ $dateToString: { date, format: '%z', timezone: '$zone' } });
  const minutes = (z) => (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
  // [value, offsets at the case's instants and, for Date results, at the result]
  const run = async (docs, value, dateResult) => {
    const out = [];
    for (let i = 0; i < docs.length; i += 300) {
      const rows = await admin.aggregate([
        { $documents: docs.slice(i, i + 300) },
        { $project: { _id: 0, v: value, d: 1, f: 1, zone: 1 } },
        { $project: { v: 1, a: offset('$d'), b: { $cond: [{ $ifNull: ['$f', false] }, offset('$f'), null] }, c: dateResult ? offset('$v') : null } },
      ]).toArray();
      out.push(...rows.map(r => [r.v instanceof Date ? r.v.getTime() : r.v, [r.a, r.b, r.c].filter(z => z !== null).map(minutes)]));
    }
    return out;
  };
  const asDocs = (list) => list.map(c => ({ ...c, d: new Date(c.t), ...(c.e !== undefined ? { f: new Date(c.e) } : {}) }));
  const trunc = await run(asDocs(cases.trunc), { $dateTrunc: { date: '$d', unit: '$unit', binSize: '$bin', timezone: '$zone', startOfWeek: '$sow' } }, true);
  const parts = [];
  for (const [name, op] of Object.entries(PARTS)) {
    const subset = cases.part.map((c, i) => [c, i]).filter(([c]) => c.part === name);
    const values = await run(asDocs(subset.map(([c]) => c)), { [op]: { date: '$d', timezone: '$zone' } });
    subset.forEach(([, i], k) => { parts[i] = values[k]; });
  }
  const added = await run(asDocs(cases.add), { $dateAdd: { startDate: '$d', unit: '$unit', amount: '$amount', timezone: '$zone' } }, true);
  const diffs = await run(asDocs(cases.diff), { $dateDiff: { startDate: '$d', endDate: '$f', unit: '$unit', timezone: '$zone', startOfWeek: '$sow' } });
  const file = {
    provenance: { mongodb: version, generated: new Date().toISOString().slice(0, 10), node: process.version, script: 'scripts/mongodb-calendar-fixture.mjs' },
    trunc: cases.trunc.map((c, i) => [c.t, c.unit, c.bin, c.sow, c.zone, ...trunc[i]]),
    part: cases.part.map((c, i) => [c.t, c.part, c.zone, ...parts[i]]),
    add: cases.add.map((c, i) => [c.t, c.unit, c.amount, c.zone, ...added[i]]),
    diff: cases.diff.map((c, i) => [c.t, c.e, c.unit, c.sow, c.zone, ...diffs[i]]),
  };
  await writeFile(OUT, JSON.stringify(file).replace(/\],\[/g, '],\n[') + '\n');
  console.log(`${new Date().toISOString()} info wrote ${OUT} mongodb=${version} cases=${4 * PER_KIND}`);
} finally {
  await client.close();
}
