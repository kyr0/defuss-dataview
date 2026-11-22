import { describe, expect, it } from 'vitest';
import { forRows } from '../compute.js';
import { createArraySource } from '../stream.js';

type Row = { id: number; a?: unknown; b?: unknown; c?: unknown };
const q = forRows<Row>();
const a = q.field('a'), b = q.field('b'), c = q.field('c');
const select = async (exprs: Record<string, unknown>, rows: Row[], invalidNumbers?: 'skip') =>
  (await q.rows({ select: exprs as never, ...(invalidNumbers ? { invalidNumbers } : {}) }).evaluate(createArraySource(rows, { isolation: 'immutable' }))).rows as Record<string, unknown>[];
const one = async (expr: unknown, row: Omit<Row, 'id'>, invalidNumbers?: 'skip') => (await select({ x: expr }, [{ id: 0, ...row }], invalidNumbers))[0].x;

describe('arithmetic', () => {
  it('mod keeps the sign of the dividend; pow, sqrt, ln and exp are real and finite or throw RangeError', async () => {
    expect(await select({ mod: q.mod(a as never, b as never), pow: q.pow(a as never, b as never) }, [
      { id: 1, a: 7, b: 3 }, { id: 2, a: -7, b: 3 }, { id: 3, a: 7.5, b: -2 }, { id: 4, a: null, b: 2 }, { id: 5, a: 2, b: 0.5 },
    ])).toEqual([{ mod: 1, pow: 343 }, { mod: -1, pow: -343 }, { mod: 1.5, pow: 1 / 56.25 }, { mod: null, pow: null }, { mod: 0, pow: Math.SQRT2 }]);
    expect(await select({ sqrt: q.sqrt(a as never), ln: q.ln(a as never), exp: q.exp(a as never) }, [{ id: 1, a: 4 }, { id: 2, a: Math.E }, { id: 3 }]))
      .toEqual([{ sqrt: 2, ln: Math.log(4), exp: Math.exp(4) }, { sqrt: Math.sqrt(Math.E), ln: 1, exp: Math.exp(Math.E) }, { sqrt: null, ln: null, exp: null }]);
    await expect(one(q.mod(a as never, b as never), { a: 1, b: 0 })).rejects.toThrow('mod by zero');
    expect(await one(q.mod(a as never, b as never), { a: -(2n ** 70n) - 5n, b: 3n })).toBe((-(2n ** 70n) - 5n) % 3n);
    await expect(one(q.mod(a as never, b as never), { a: 1n, b: 0n })).rejects.toThrow('mod by zero');
    await expect(one(q.mod(a as never, b as never), { a: 7n, b: 2 })).rejects.toThrow(TypeError);
    await expect(one(q.pow(a as never, b as never), { a: -8, b: 1 / 3 })).rejects.toThrow('not a real number');
    await expect(one(q.pow(a as never, b as never), { a: 10, b: 400 })).rejects.toThrow('overflowed');
    await expect(one(q.sqrt(a as never), { a: -1 })).rejects.toThrow(RangeError);
    await expect(one(q.ln(a as never), { a: 0 })).rejects.toThrow(RangeError);
    await expect(one(q.exp(a as never), { a: 1000 })).rejects.toThrow(RangeError);
    await expect(one(q.mod(a as never, b as never), { a: '7', b: 2 })).rejects.toThrow(TypeError);
    expect(await one(q.mod(a as never, b as never), { a: '7', b: 2 }, 'skip')).toBeNull();
  });
});

describe('bitwise operators', () => {
  // Reference: BigInt.asIntN(64, ...), MongoDB's long arithmetic.
  const ref = (op: string, x: number, y: number) => Number(BigInt.asIntN(64, op === 'and' ? BigInt(x) & BigInt(y) : op === 'or' ? BigInt(x) | BigInt(y) : BigInt(x) ^ BigInt(y)));
  it('compute safe integers as 64-bit two\'s complement, above 32 bits too', async () => {
    let seed = 3;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const edge = [0, 1, -1, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, 2 ** 32, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 52 + 3];
    const pairs = [...edge.flatMap(x => edge.map(y => [x, y])), ...Array.from({ length: 300 }, () => [Math.round((random() - 0.5) * 2 * Number.MAX_SAFE_INTEGER), Math.round((random() - 0.5) * 2 ** (random() * 54))])];
    const rows = pairs.map(([x, y], id) => ({ id, a: x, b: y }));
    const got = await select({ and: q.bitAnd(a as never, b as never), or: q.bitOr(a as never, b as never), xor: q.bitXor(a as never, b as never), not: q.bitNot(a as never) }, rows);
    got.forEach((r, i) => {
      const [x, y] = pairs[i];
      expect(r, `${x}, ${y}`).toEqual({ and: ref('and', x, y), or: ref('or', x, y), xor: ref('xor', x, y), not: Number(BigInt.asIntN(64, ~BigInt(x))) });
    });
  });
  it('take BigInts at full width, three or more operands, and null for nullish ones', async () => {
    expect(await select({ and: q.bitAnd(a as never, b as never, c as never), not: q.bitNot(a as never) }, [
      { id: 1, a: 2n ** 70n + 7n, b: 2n ** 70n + 3n, c: -1n }, { id: 2, a: 6, b: 3, c: 2 }, { id: 3, a: 1, b: null, c: 1 },
    ])).toEqual([{ and: 2n ** 70n + 3n, not: -(2n ** 70n) - 8n }, { and: 2, not: -7 }, { and: null, not: -2 }]);
  });
  it('reject fractions, unsafe integers and mixed numbers and BigInts, or skip them', async () => {
    for (const row of [{ a: 1.5, b: 1 }, { a: 2 ** 53, b: 1 }, { a: 1, b: 1n }, { a: '1', b: 1 }]) {
      await expect(one(q.bitOr(a as never, b as never), row)).rejects.toThrow(TypeError);
      expect(await one(q.bitOr(a as never, b as never), row, 'skip')).toBeNull();
    }
  });
});

describe('least() and greatest()', () => {
  it('pick in the typed order, skip nullish and invalid operands, keep the first of equals', async () => {
    expect(await select({ least: q.least(a, b, c), greatest: q.greatest(a, b, c) }, [
      { id: 1, a: 3, b: 1, c: 2 }, { id: 2, a: null, b: NaN, c: 'x' }, { id: 3, a: 'b', b: 1, c: new Date(0) }, { id: 4 }, { id: 5, a: [1, 2], b: [1], c: new Date(NaN) },
    ])).toEqual([{ least: 1, greatest: 3 }, { least: 'x', greatest: 'x' }, { least: 1, greatest: new Date(0) }, { least: null, greatest: null }, { least: [1], greatest: [1, 2] }]);
  });
});

describe('text functions', () => {
  it('split, replaceAll and indexOf', async () => {
    expect(await select({ parts: q.split(a, b), replaced: q.replaceAll(a, b, c), at: q.indexOf(a, b) }, [
      { id: 1, a: 'a,b,,c', b: ',', c: '$&' }, { id: 2, a: '😀x😀', b: 'x', c: '' }, { id: 3, a: 'abc', b: 'z', c: '-' }, { id: 4, a: null, b: ',', c: '' },
    ])).toEqual([
      { parts: ['a', 'b', '', 'c'], replaced: 'a$&b$&$&c', at: 1 }, { parts: ['😀', '😀'], replaced: '😀😀', at: 1 },
      { parts: ['abc'], replaced: 'abc', at: -1 }, { parts: null, replaced: null, at: null },
    ]);
    await expect(one(q.split(a, b), { a: 'abc', b: '' })).rejects.toThrow('nonempty separator');
    await expect(one(q.replaceAll(a, b, c), { a: 'abc', b: '', c: 'x' })).rejects.toThrow('nonempty find');
    await expect(one(q.indexOf(a, b), { a: 1, b: '1' })).rejects.toThrow('needs a string');
  });
  it('toText and parseNumber convert explicitly and reject what they cannot read', async () => {
    expect(await select({ text: q.toText(a) }, [
      { id: 1, a: 'x' }, { id: 2, a: -0 }, { id: 3, a: 1.5e300 }, { id: 4, a: 12n }, { id: 5, a: false }, { id: 6, a: new Date(0) }, { id: 7, a: new Date(NaN) }, { id: 8 },
    ])).toEqual(['x', '0', '1.5e+300', '12', 'false', '1970-01-01T00:00:00.000Z', null, null].map(text => ({ text })));
    await expect(one(q.toText(a), { a: [1] })).rejects.toThrow('toText() needs');
    expect(await select({ n: q.parseNumber(a) }, [{ id: 1, a: ' -12.5e3 ' }, { id: 2, a: '.5' }, { id: 3, a: 7 }, { id: 4, a: '1.' }, { id: 5, a: null }]))
      .toEqual([-12500, 0.5, 7, 1, null].map(n => ({ n })));
    for (const bad of ['', '0x10', '1e400', 'Infinity', '1,5', NaN, true]) {
      await expect(one(q.parseNumber(a), { a: bad })).rejects.toThrow(TypeError);
      expect(await one(q.parseNumber(a), { a: bad }, 'skip')).toBeNull();
    }
  });
});

describe('variance and standard deviation', () => {
  const measures = { vp: q.varPop(a as never), vs: q.varSamp(a as never), sp: q.stdDevPop(a as never), ss: q.stdDevSamp(a as never) };
  const totals = async (values: unknown[]) =>
    (await q.aggregate({ measures }).evaluate(createArraySource(values.map((v, id) => ({ id, a: v })), { isolation: 'immutable' }))).rows[0];
  it('give population and sample values, null without enough values, skipping nullish ones', async () => {
    expect(await totals([2, 4, 4, 4, 5, 5, 7, 9, null, undefined])).toEqual({ vp: 4, vs: 32 / 7, sp: 2, ss: Math.sqrt(32 / 7) });
    expect(await totals([5])).toEqual({ vp: 0, vs: null, sp: 0, ss: null });
    expect(await totals([])).toEqual({ vp: null, vs: null, sp: null, ss: null });
  });
  it('stay exact around a large mean and in any order, where the textbook formula cancels', async () => {
    const values = [1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16];
    expect(await totals(values)).toMatchObject({ vp: 22.5, vs: 30 });
    const naive = values.reduce((s, x) => s + x * x, 0) / 4 - (values.reduce((s, x) => s + x, 0) / 4) ** 2;
    expect(naive).not.toBe(22.5);
    const mixed = [0.1, 1e15, -3.3, 2 ** -20, 7e-3, -1e15 + 1];
    const forward = await totals(mixed), backward = await totals([...mixed].reverse());
    expect(backward).toEqual(forward);
  });
  it('throw a RangeError for squares beyond the double range and an invalid number per policy', async () => {
    await expect(totals([1e200])).rejects.toThrow(RangeError);
    await expect(totals(['x'])).rejects.toThrow(TypeError);
  });
  it('merge from partials and reject malformed variance terms', async () => {
    const plan = q.aggregate({ measures });
    const rows = [3, 1, 4, 1, 5, 9, 2, 6].map((v, id) => ({ id, a: v }));
    const whole = await plan.evaluate(createArraySource(rows, { isolation: 'immutable' }));
    const parts = await Promise.all([rows.slice(0, 3), rows.slice(3)].map(part => plan.partial(createArraySource(part, { isolation: 'immutable' }))));
    expect((await plan.merge(parts.map(p => structuredClone(p)))).rows).toEqual(whole.rows);
    const broken = structuredClone(parts[0]) as unknown as { states: { squares: Float64Array }[] };
    broken.states[0].squares[0] = NaN;
    await expect(plan.merge([broken as never])).rejects.toThrow('Malformed partial aggregate');
  });
});
