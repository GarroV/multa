import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { anchorsSchema, createWorkspaceSchema, debtCreateSchema, paydaySchema, rateQuerySchema } from './validation.ts';

const debtBody = (paymentMinor: unknown) => ({
  name: 'Озон',
  currency: 'RUB',
  principalMinor: '20000000',
  remainingMinor: '20000000',
  paymentMinor,
});

describe('createWorkspaceSchema', () => {
  it('принимает валюту из 3 букв', () => {
    expect(createWorkspaceSchema.parse({ baseCurrency: 'RUB' }).baseCurrency).toBe('RUB');
  });
  it('отвергает валюту не из 3 символов', () => {
    expect(() => createWorkspaceSchema.parse({ baseCurrency: 'RUBLE' })).toThrow();
  });
});

describe('anchorsSchema (PeriodConfig)', () => {
  it('принимает monthly-days', () => {
    expect(anchorsSchema.parse({ kind: 'monthly-days', days: [10, 25] })).toEqual({
      kind: 'monthly-days',
      days: [10, 25],
    });
  });
  it('отвергает день > 31', () => {
    expect(() => anchorsSchema.parse({ kind: 'monthly-days', days: [32] })).toThrow();
  });
  it('принимает every-weeks и custom', () => {
    expect(anchorsSchema.parse({ kind: 'every-weeks', weeks: 2, startsOn: '2026-01-01' }).kind).toBe(
      'every-weeks',
    );
    expect(
      anchorsSchema.parse({ kind: 'custom', dates: ['2026-03-10', '2026-03-25'] }).kind,
    ).toBe('custom');
  });
});

describe('paydaySchema', () => {
  it('превращает expectedIncomeMinor в bigint (деньги — minor units)', () => {
    const parsed = paydaySchema.parse({
      anchors: { kind: 'monthly-days', days: [10, 25] },
      expectedIncomeMinor: '19000000',
    });
    expect(parsed.expectedIncomeMinor).toBe(19000000n);
  });
});

describe('minor units (деньги на границе)', () => {
  it('принимает целую строку и число, отдаёт bigint', () => {
    expect(debtCreateSchema.parse(debtBody('2000000')).paymentMinor).toBe(2000000n);
    expect(debtCreateSchema.parse(debtBody(2000000)).paymentMinor).toBe(2000000n);
  });
  it('мусор/дробное отвергаются как ZodError (400), а не роняют сырой BigInt-throw (500)', () => {
    for (const bad of ['abc', '1.5', '', '1 000', 1.5]) {
      const res = debtCreateSchema.safeParse(debtBody(bad));
      expect(res.success).toBe(false); // safeParse ловит именно ZodError, сырой throw бы пролетел
    }
    expect(() => debtCreateSchema.parse(debtBody('abc'))).toThrow(z.ZodError);
  });
  it('paydaySchema так же валидирует expectedIncomeMinor', () => {
    expect(paydaySchema.safeParse({ anchors: { kind: 'monthly-days', days: [10] }, expectedIncomeMinor: 'oops' }).success).toBe(false);
  });
});

describe('rateQuerySchema', () => {
  it('требует from и to', () => {
    expect(() => rateQuerySchema.parse({ from: 'EUR' })).toThrow();
    expect(rateQuerySchema.parse({ from: 'EUR', to: 'RUB' })).toMatchObject({ from: 'EUR', to: 'RUB' });
  });
});
