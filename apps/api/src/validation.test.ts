import { describe, expect, it } from 'vitest';
import { anchorsSchema, createWorkspaceSchema, paydaySchema, rateQuerySchema } from './validation.ts';

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

describe('rateQuerySchema', () => {
  it('требует from и to', () => {
    expect(() => rateQuerySchema.parse({ from: 'EUR' })).toThrow();
    expect(rateQuerySchema.parse({ from: 'EUR', to: 'RUB' })).toMatchObject({ from: 'EUR', to: 'RUB' });
  });
});
