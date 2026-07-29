import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysInPeriod,
  daysLeftInPeriod,
  everyWeeksDatesBetween,
  generatePeriods,
  monthlyDatesBetween,
  periodForDate,
  shiftForWeekend,
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

describe('shiftForWeekend', () => {
  it('as-is не двигает дату', () => {
    expect(shiftForWeekend('2026-07-25', 'as-is')).toBe('2026-07-25'); // суббота
  });

  it('before уводит субботу на пятницу, воскресенье — на пятницу', () => {
    expect(shiftForWeekend('2026-07-25', 'before')).toBe('2026-07-24');
    expect(shiftForWeekend('2026-07-26', 'before')).toBe('2026-07-24');
  });

  it('after уводит субботу и воскресенье на понедельник', () => {
    expect(shiftForWeekend('2026-07-25', 'after')).toBe('2026-07-27');
    expect(shiftForWeekend('2026-07-26', 'after')).toBe('2026-07-27');
  });

  it('рабочий день не двигает ни одним правилом', () => {
    expect(shiftForWeekend('2026-07-24', 'before')).toBe('2026-07-24'); // пятница
    expect(shiftForWeekend('2026-07-24', 'after')).toBe('2026-07-24');
  });
});

describe('generatePeriods — правило выходных', () => {
  it('сдвигает границу периода, когда выплата попала на субботу', () => {
    const cfg: PeriodConfig = { kind: 'monthly-days', days: [25], weekendRule: 'before' };
    // 25 июля 2026 — суббота → выплата 24-го, значит и период начинается 24-го.
    expect(generatePeriods(cfg, '2026-07-26', 1)).toEqual([
      { startsOn: '2026-07-24', endsOn: '2026-08-25' },
    ]);
  });

  it('склеивает две выплаты, сдвинутые на одну дату (25 сб и 26 вс → 24 пт)', () => {
    const cfg: PeriodConfig = { kind: 'monthly-days', days: [25, 26], weekendRule: 'before' };
    expect(generatePeriods(cfg, '2026-07-27', 1)).toEqual([
      { startsOn: '2026-07-24', endsOn: '2026-08-25' },
    ]);
  });

  it('без weekendRule поведение не меняется (дефолт as-is)', () => {
    const cfg: PeriodConfig = { kind: 'monthly-days', days: [25] };
    expect(generatePeriods(cfg, '2026-07-26', 1)).toEqual([
      { startsOn: '2026-07-25', endsOn: '2026-08-25' },
    ]);
  });
});

describe('оконные генераторы дат', () => {
  it('addDays двигает дату в обе стороны через границу месяца', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
  });

  it('monthlyDatesBetween отдаёт даты окна с клампом к длине месяца', () => {
    expect(monthlyDatesBetween([10, 25], '2026-07-05', '2026-08-12')).toEqual([
      '2026-07-10',
      '2026-07-25',
      '2026-08-10',
    ]);
    expect(monthlyDatesBetween([31], '2026-02-01', '2026-02-28')).toEqual(['2026-02-28']);
  });

  it('monthlyDatesBetween дедупит даты, схлопнувшиеся клампом (30 и 31 в феврале)', () => {
    expect(monthlyDatesBetween([30, 31], '2026-02-01', '2026-02-28')).toEqual(['2026-02-28']);
  });

  it('everyWeeksDatesBetween шагает от якоря и не выходит за окно', () => {
    expect(everyWeeksDatesBetween(2, '2026-07-03', '2026-07-10', '2026-08-05')).toEqual([
      '2026-07-17',
      '2026-07-31',
    ]);
  });

  it('everyWeeksDatesBetween не отдаёт дат до якоря', () => {
    expect(everyWeeksDatesBetween(1, '2026-07-10', '2026-07-01', '2026-07-15')).toEqual([
      '2026-07-10',
    ]);
  });
});
