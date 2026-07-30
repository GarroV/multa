import { describe, expect, it } from 'vitest';
import {
  formatPayday,
  payoutsToSources,
  percentSum,
  previewDates,
  rhythmToConfig,
  rhythmToPayload,
  withRhythmKind,
  type RhythmForm,
} from './income.ts';

const twiceMonthly: RhythmForm = {
  kind: 'twiceMonthly',
  days: [10, 25],
  weeks: 2,
  anchorDate: '2026-08-07',
  weekendRule: 'as-is',
};

describe('rhythmToConfig', () => {
  it('два раза в месяц → monthly-days с обоими числами', () => {
    expect(rhythmToConfig(twiceMonthly)).toEqual({
      kind: 'monthly-days',
      days: [10, 25],
      weekendRule: 'as-is',
    });
  });

  it('раз в месяц → monthly-days с одним числом', () => {
    expect(rhythmToConfig({ ...twiceMonthly, kind: 'monthly', days: [5] })).toEqual({
      kind: 'monthly-days',
      days: [5],
      weekendRule: 'as-is',
    });
  });

  it('цикл недель → every-weeks от указанной даты, а не от сегодня', () => {
    expect(rhythmToConfig({ ...twiceMonthly, kind: 'everyWeeks' })).toEqual({
      kind: 'every-weeks',
      weeks: 2,
      startsOn: '2026-08-07',
      weekendRule: 'as-is',
    });
  });
});

describe('withRhythmKind', () => {
  it('возврат к «два раза в месяц» после правки одного числа даёт снова два числа', () => {
    const monthlyDay5 = withRhythmKind({ ...twiceMonthly, days: [5] }, 'monthly');
    expect(monthlyDay5.days).toEqual([5]);
    // Регресс: раньше ритм молча оставался однодневным, а второе поле пустым.
    expect(withRhythmKind(monthlyDay5, 'twiceMonthly').days).toEqual([5, 25]);
  });

  it('«раз в месяц» оставляет первое число', () => {
    expect(withRhythmKind(twiceMonthly, 'monthly').days).toEqual([10]);
  });

  it('не даёт двух одинаковых чисел — откатывает к дефолту', () => {
    const monthly = withRhythmKind({ ...twiceMonthly, days: [25] }, 'monthly');
    expect(withRhythmKind({ ...monthly, days: [25, 25] }, 'twiceMonthly').days).toEqual([10, 25]);
  });

  it('цикл недель числа не трогает', () => {
    expect(withRhythmKind(twiceMonthly, 'everyWeeks')).toEqual({
      ...twiceMonthly,
      kind: 'everyWeeks',
    });
  });
});

describe('formatPayday', () => {
  it('даёт человеческую дату без сдвига таймзоны', () => {
    expect(formatPayday('2026-08-10', 'ru')).toBe('10 авг.');
    expect(formatPayday('2026-08-10', 'en')).toBe('Aug 10');
  });
});

describe('rhythmToPayload', () => {
  it('не отдаёт weekendRule — сервер склеивает его сам', () => {
    expect(rhythmToPayload(twiceMonthly)).toEqual({ kind: 'monthly-days', days: [10, 25] });
  });
});

describe('previewDates', () => {
  it('показывает ближайшие даты выплат для «два раза в месяц»', () => {
    expect(previewDates(twiceMonthly, '2026-08-01', 3)).toEqual([
      '2026-08-10',
      '2026-08-25',
      '2026-09-10',
    ]);
  });

  it('для цикла в две недели даты плывут по календарю', () => {
    expect(previewDates({ ...twiceMonthly, kind: 'everyWeeks' }, '2026-08-01', 3)).toEqual([
      '2026-08-07',
      '2026-08-21',
      '2026-09-04',
    ]);
  });

  it('учитывает правило выходных', () => {
    // 25 июля 2026 — суббота.
    expect(
      previewDates(
        { ...twiceMonthly, kind: 'monthly', days: [25], weekendRule: 'before' },
        '2026-07-01',
        1,
      ),
    ).toEqual(['2026-07-24']);
  });
});

describe('payoutsToSources', () => {
  const payouts = [
    { label: 'Аванс', day: 10, amount: '80000', percent: '40' },
    { label: 'Зарплата', day: 25, amount: '120000', percent: '60' },
  ];

  it('абсолютные суммы → источники с monthly-days и minor units', () => {
    const sources = payoutsToSources(payouts, { currency: 'RUB', usePercent: false, gross: '' });
    expect(sources).toEqual([
      {
        label: 'Аванс',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [10] },
        amount: { kind: 'absolute', amountMinor: '8000000' },
        stability: 'fixed',
        active: true,
        sort: 0,
      },
      {
        label: 'Зарплата',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [25] },
        amount: { kind: 'absolute', amountMinor: '12000000' },
        stability: 'fixed',
        active: true,
        sort: 1,
      },
    ]);
  });

  it('проценты → amount percent с окладом в minor units', () => {
    const sources = payoutsToSources(payouts, {
      currency: 'RUB',
      usePercent: true,
      gross: '200000',
    });
    expect(sources[0]!.amount).toEqual({ kind: 'percent', percent: '40', ofMinor: '20000000' });
  });

  it('пропускает выплаты без валидной суммы', () => {
    const sources = payoutsToSources([{ label: 'Аванс', day: 10, amount: '', percent: '' }], {
      currency: 'RUB',
      usePercent: false,
      gross: '',
    });
    expect(sources).toEqual([]);
  });

  it('пропускает проценты без оклада', () => {
    const sources = payoutsToSources(payouts, { currency: 'RUB', usePercent: true, gross: '' });
    expect(sources).toEqual([]);
  });
});

describe('percentSum', () => {
  it('складывает проценты выплат', () => {
    expect(
      percentSum([
        { label: 'a', day: 10, amount: '', percent: '40' },
        { label: 'b', day: 25, amount: '', percent: '60' },
      ]),
    ).toBe(100);
  });

  it('пустой процент считает нулём', () => {
    expect(percentSum([{ label: 'a', day: 10, amount: '', percent: '' }])).toBe(0);
  });
});
