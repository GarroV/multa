import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createWorkspaceSchema,
  debtCreateSchema,
  incomeSourcePatchSchema,
  incomeSourceRowSchema,
  incomeSourceSchema,
  onboardingIncomeSchema,
  rateQuerySchema,
  rhythmSchema,
  transactionCreateSchema,
  transactionListSchema,
} from './validation.ts';

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

describe('incomeSourceSchema', () => {
  const base = {
    label: 'Аванс',
    currency: 'rub',
    schedule: { kind: 'monthly-days', days: [10] },
    amount: { kind: 'absolute', amountMinor: '8000000' },
  };

  it('парсит абсолютную сумму в bigint и валюту в верхний регистр', () => {
    const parsed = incomeSourceSchema.parse(base);
    expect(parsed.amount).toEqual({ kind: 'absolute', amountMinor: 8000000n });
    expect(parsed.currency).toBe('RUB');
    expect(parsed.stability).toBe('fixed');
    expect(parsed.active).toBe(true);
  });

  it('парсит процент от оклада', () => {
    const parsed = incomeSourceSchema.parse({
      ...base,
      amount: { kind: 'percent', percent: '40', ofMinor: '20000000' },
    });
    expect(parsed.amount).toEqual({ kind: 'percent', percent: '40', ofMinor: 20000000n });
  });

  it('сортирует и дедупит дни месяца', () => {
    const parsed = incomeSourceSchema.parse({
      ...base,
      schedule: { kind: 'monthly-days', days: [25, 10, 10] },
    });
    expect(parsed.schedule).toEqual({ kind: 'monthly-days', days: [10, 25] });
  });

  it('отвергает день вне 1..31', () => {
    expect(
      incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'monthly-days', days: [0] } })
        .success,
    ).toBe(false);
    expect(
      incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'monthly-days', days: [32] } })
        .success,
    ).toBe(false);
  });

  it('отвергает процент вне (0, 100]', () => {
    const ok = (p: string) =>
      incomeSourceSchema.safeParse({
        ...base,
        amount: { kind: 'percent', percent: p, ofMinor: '1' },
      }).success;
    expect(ok('0')).toBe(false);
    expect(ok('100.1')).toBe(false);
    expect(ok('100')).toBe(true);
  });

  it('отвергает нецелую и нулевую сумму', () => {
    expect(
      incomeSourceSchema.safeParse({ ...base, amount: { kind: 'absolute', amountMinor: '80.5' } })
        .success,
    ).toBe(false);
    expect(
      incomeSourceSchema.safeParse({ ...base, amount: { kind: 'absolute', amountMinor: '0' } })
        .success,
    ).toBe(false);
  });

  it('отвергает неизвестный вид расписания', () => {
    expect(incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'lunar' } }).success).toBe(
      false,
    );
  });

  it('требует дату в формате YYYY-MM-DD', () => {
    expect(
      incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'one-off', date: '15.07.2026' } })
        .success,
    ).toBe(false);
    expect(
      incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'one-off', date: '2026-07-15' } })
        .success,
    ).toBe(true);
  });

  it('принимает irregular без дополнительных полей', () => {
    expect(incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'irregular' } }).success).toBe(
      true,
    );
  });

  it('rowSchema парсит строку БД вместе с id', () => {
    const parsed = incomeSourceRowSchema.parse({
      ...base,
      id: '11111111-1111-1111-1111-111111111111',
    });
    expect(parsed.id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('patchSchema допускает частичное обновление', () => {
    expect(incomeSourcePatchSchema.parse({ label: 'Зарплата' })).toEqual({ label: 'Зарплата' });
  });
});

describe('rhythmSchema (ритм планирования)', () => {
  it('принимает дни месяца и цикл недель', () => {
    expect(rhythmSchema.parse({ kind: 'monthly-days', days: [10, 25] })).toEqual({
      kind: 'monthly-days',
      days: [10, 25],
    });
    expect(rhythmSchema.parse({ kind: 'every-weeks', weeks: 2, startsOn: '2026-08-07' })).toEqual({
      kind: 'every-weeks',
      weeks: 2,
      startsOn: '2026-08-07',
    });
  });

  it('не принимает one-off и irregular как ритм', () => {
    expect(rhythmSchema.safeParse({ kind: 'one-off', date: '2026-08-07' }).success).toBe(false);
    expect(rhythmSchema.safeParse({ kind: 'irregular' }).success).toBe(false);
  });

  it('требует дату якоря для цикла недель', () => {
    expect(rhythmSchema.safeParse({ kind: 'every-weeks', weeks: 2 }).success).toBe(false);
  });

  it('отвергает день > 31', () => {
    expect(() => rhythmSchema.parse({ kind: 'monthly-days', days: [32] })).toThrow();
  });
});

describe('onboardingIncomeSchema', () => {
  const source = {
    label: 'Зарплата',
    currency: 'RUB',
    schedule: { kind: 'monthly-days', days: [25] },
    amount: { kind: 'absolute', amountMinor: '12000000' },
  };

  it('требует хотя бы один источник', () => {
    expect(
      onboardingIncomeSchema.safeParse({ rhythm: { kind: 'monthly-days', days: [25] }, sources: [] })
        .success,
    ).toBe(false);
  });

  it('дефолтит правило выходных на before', () => {
    const parsed = onboardingIncomeSchema.parse({
      rhythm: { kind: 'monthly-days', days: [25] },
      sources: [source],
    });
    expect(parsed.weekendRule).toBe('before');
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
  it('суммы источников дохода валидируются тем же minor', () => {
    const body = (amountMinor: unknown) => ({
      label: 'Аванс',
      currency: 'RUB',
      schedule: { kind: 'monthly-days', days: [10] },
      amount: { kind: 'absolute', amountMinor },
    });
    expect(incomeSourceSchema.safeParse(body('oops')).success).toBe(false);
    expect(incomeSourceSchema.parse(body('8000000')).amount).toEqual({
      kind: 'absolute',
      amountMinor: 8000000n,
    });
  });
});

describe('rateQuerySchema', () => {
  it('требует from и to', () => {
    expect(() => rateQuerySchema.parse({ from: 'EUR' })).toThrow();
    expect(rateQuerySchema.parse({ from: 'EUR', to: 'RUB' })).toMatchObject({ from: 'EUR', to: 'RUB' });
  });
});

describe('transactionCreateSchema (факт трат, Спринт 3)', () => {
  const body = (over: Record<string, unknown> = {}) => ({ amountMinor: '25000', currency: 'rub', ...over });

  it('отдаёт сумму bigint и нормализует валюту к верхнему регистру', () => {
    const parsed = transactionCreateSchema.parse(body());
    expect(parsed.amountMinor).toBe(25000n);
    expect(parsed.currency).toBe('RUB');
  });

  it('отвергает ноль и минус: знак несёт kind, а не сумма', () => {
    expect(transactionCreateSchema.safeParse(body({ amountMinor: '0' })).success).toBe(false);
    expect(transactionCreateSchema.safeParse(body({ amountMinor: '-100' })).success).toBe(false);
  });

  it('дату принимает только как YYYY-MM-DD', () => {
    expect(transactionCreateSchema.parse(body({ occurredOn: '2026-07-30' })).occurredOn).toBe('2026-07-30');
    for (const bad of ['30.07.2026', '2026-7-30', 'сегодня', '2026-07-30T12:00:00Z']) {
      expect(transactionCreateSchema.safeParse(body({ occurredOn: bad })).success).toBe(false);
    }
  });

  it('категория опциональна (крупный мазок без категории), но обязана быть uuid', () => {
    expect(transactionCreateSchema.parse(body()).categoryId).toBeUndefined();
    expect(transactionCreateSchema.safeParse(body({ categoryId: 'food' })).success).toBe(false);
  });

  it('источник — только из разрешённого списка (совпадает с check в схеме БД)', () => {
    expect(transactionCreateSchema.parse(body({ source: 'text' })).source).toBe('text');
    expect(transactionCreateSchema.safeParse(body({ source: 'telepathy' })).success).toBe(false);
  });
});

describe('transactionListSchema', () => {
  it('без параметров валиден (значит «текущий период»)', () => {
    expect(transactionListSchema.parse({})).toEqual({});
  });
  it('кривые даты отвергает', () => {
    expect(transactionListSchema.safeParse({ from: '01-07-2026', to: '2026-07-30' }).success).toBe(false);
  });
});
