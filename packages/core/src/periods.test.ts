import { describe, expect, it } from 'vitest';
import {
  daysInPeriod,
  daysLeftInPeriod,
  generatePeriods,
  periodForDate,
  type PeriodConfig,
} from './periods.ts';

describe('generatePeriods — monthly-days', () => {
  const cfg: PeriodConfig = { kind: 'monthly-days', days: [10, 25] };

  it('генерит периоды вперёд от даты внутри периода', () => {
    const periods = generatePeriods(cfg, '2026-03-19', 3);
    expect(periods).toEqual([
      { startsOn: '2026-03-10', endsOn: '2026-03-25' },
      { startsOn: '2026-03-25', endsOn: '2026-04-10' },
      { startsOn: '2026-04-10', endsOn: '2026-04-25' },
    ]);
  });

  it('дата до первого якоря месяца попадает в период с прошлого месяца', () => {
    const periods = generatePeriods(cfg, '2026-03-05', 1);
    expect(periods[0]).toEqual({ startsOn: '2026-02-25', endsOn: '2026-03-10' });
  });

  it('клампит несуществующий день месяца к последнему дню (31 → 28 фев)', () => {
    const monthly: PeriodConfig = { kind: 'monthly-days', days: [31] };
    const periods = generatePeriods(monthly, '2026-02-15', 2);
    expect(periods).toEqual([
      { startsOn: '2026-01-31', endsOn: '2026-02-28' },
      { startsOn: '2026-02-28', endsOn: '2026-03-31' },
    ]);
  });
});

describe('generatePeriods — every-weeks', () => {
  it('генерит биваленжные периоды от стартовой даты', () => {
    const cfg: PeriodConfig = { kind: 'every-weeks', weeks: 2, startsOn: '2026-01-01' };
    const periods = generatePeriods(cfg, '2026-01-20', 2);
    expect(periods).toEqual([
      { startsOn: '2026-01-15', endsOn: '2026-01-29' },
      { startsOn: '2026-01-29', endsOn: '2026-02-12' },
    ]);
  });
});

describe('generatePeriods — custom', () => {
  const cfg: PeriodConfig = {
    kind: 'custom',
    dates: ['2026-03-10', '2026-03-25', '2026-04-10'],
  };

  it('строит периоды между явными датами', () => {
    const periods = generatePeriods(cfg, '2026-03-19', 2);
    expect(periods).toEqual([
      { startsOn: '2026-03-10', endsOn: '2026-03-25' },
      { startsOn: '2026-03-25', endsOn: '2026-04-10' },
    ]);
  });

  it('не выдумывает периоды за пределами явных дат (клампит count)', () => {
    const periods = generatePeriods(cfg, '2026-03-19', 5);
    expect(periods).toHaveLength(2);
  });
});

describe('periodForDate — граница периода полуоткрытая [start, end)', () => {
  const cfg: PeriodConfig = { kind: 'monthly-days', days: [10, 25] };

  it('день выплаты начинает НОВЫЙ период (start включительно)', () => {
    expect(periodForDate(cfg, '2026-03-25')).toEqual({
      startsOn: '2026-03-25',
      endsOn: '2026-04-10',
    });
  });

  it('день накануне выплаты — ещё в старом периоде', () => {
    expect(periodForDate(cfg, '2026-03-24')).toEqual({
      startsOn: '2026-03-10',
      endsOn: '2026-03-25',
    });
  });
});

describe('метрики периода (для «цифры дня»)', () => {
  const period = { startsOn: '2026-03-10', endsOn: '2026-03-25' };

  it('daysInPeriod — число дней от start до end (исключая end)', () => {
    expect(daysInPeriod(period)).toBe(15);
  });

  it('daysLeftInPeriod — дней от asOf до конца (19-е → 6 дней до 25-го)', () => {
    expect(daysLeftInPeriod(period, '2026-03-19')).toBe(6);
  });

  it('в день выплаты старого периода остаётся 0 дней', () => {
    expect(daysLeftInPeriod(period, '2026-03-25')).toBe(0);
  });
});
