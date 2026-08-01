import { describe, expect, it } from 'vitest';
import { buildSignals, type SignalsInput, type SignalThresholds } from './signalEngine.ts';

/**
 * Сигналы как сущность (issue #50).
 *
 * Правило, вокруг которого всё построено: **сигнал без действия — это шум**. Раньше «сигналы» были
 * разметкой на экране статистики: четыре разнородных источника, тон выбирался в JSX, и ни одной
 * кнопки. Здесь у каждого сигнала есть правило, severity, метрика и хотя бы одно действие — иначе
 * он не выпускается наружу.
 *
 * Второе правило: текст сигнала здесь не собирается. Наружу идут rule + метрика + параметры, а
 * формулировку берёт i18n — иначе строки поехали бы мимо словаря (правило 5).
 */

const period = { startsOn: '2026-07-25', endsOn: '2026-08-10' };

const thresholds: SignalThresholds = {
  burnThresholdDays: 3,
  runwayWarnDays: 14,
  lockedWarnPct: 60,
  maxSignals: 6,
};

const input = (over: Partial<SignalsInput> = {}): SignalsInput => ({
  asOf: '2026-08-01',
  period,
  baseCurrency: 'RUB',
  burn: { perDayMinor: 0n, willLast: true, runsOutOn: null },
  livingMinor: 5_000_00n,
  overspentMinor: 0n,
  compressedMinor: 0n,
  incomeMinor: 100_000_00n,
  lockedMinor: 0n,
  balancesBaseMinor: null,
  categories: [],
  forecast: [],
  ...over,
});

describe('buildSignals', () => {
  it('спокойный период не выдумывает тревог', () => {
    expect(buildSignals(input(), thresholds)).toEqual([]);
  });

  it('темп трат: деньги кончатся раньше выплаты — риск с датой и действием', () => {
    const signals = buildSignals(
      input({ burn: { perDayMinor: 800_00n, willLast: false, runsOutOn: '2026-08-02' } }),
      thresholds,
    );
    const burn = signals.find((s) => s.rule === 'burn_rate')!;
    expect(burn.severity).toBe('risk');
    expect(burn.metric).toEqual({ kind: 'date', on: '2026-08-02' });
    // Действие обязательно: сигнал без него — просто испорченное настроение.
    expect(burn.actions.length).toBeGreaterThan(0);
  });

  it('порог тревоги из настроек действительно работает', () => {
    /*
     * `burnThresholdDays` до этого был мёртвой настройкой: тумблер в интерфейсе был, а кода,
     * который его читает, не существовало. Разница между «кончатся за день до выплаты» и
     * «кончатся за неделю» — это разница между «поджаться» и «пересобрать план».
     */
    const soon = buildSignals(
      // Кончатся 8 августа, до конца периода 2 дня — это «внимание», а не «риск».
      input({ burn: { perDayMinor: 100_00n, willLast: false, runsOutOn: '2026-08-08' } }),
      thresholds,
    );
    expect(soon.find((s) => s.rule === 'burn_rate')?.severity).toBe('attention');

    const early = buildSignals(
      input({ burn: { perDayMinor: 100_00n, willLast: false, runsOutOn: '2026-08-02' } }),
      thresholds,
    );
    expect(early.find((s) => s.rule === 'burn_rate')?.severity).toBe('risk');
  });

  it('перерасход и сжатие плана — разные сигналы с разными метриками', () => {
    const signals = buildSignals(
      input({ overspentMinor: 1_200_00n, compressedMinor: 3_000_00n }),
      thresholds,
    );
    expect(signals.find((s) => s.rule === 'overspent')?.metric).toEqual({
      kind: 'money',
      minor: 1_200_00n,
      currency: 'RUB',
    });
    expect(signals.find((s) => s.rule === 'compressed')?.metric).toEqual({
      kind: 'money',
      minor: 3_000_00n,
      currency: 'RUB',
    });
  });

  it('категория стабильно дороже плана — предложение с конкретной суммой', () => {
    const signals = buildSignals(
      input({
        categories: [
          {
            id: 'c1',
            name: 'Еда',
            plannedMinor: 9_000_00n,
            medianMinor: 13_350_00n,
            verdict: 'raise',
            deltaPct: 48,
          },
        ],
      }),
      thresholds,
    );
    const signal = signals.find((s) => s.rule === 'median_overrun')!;
    expect(signal.targetId).toBe('c1');
    // Действие несёт сумму: «поднять до медианы» — это решение, а не совет вообще.
    expect(signal.actions).toContainEqual({
      kind: 'set_budget',
      targetId: 'c1',
      amountMinor: 13_350_00n,
    });
  });

  it('нестабильная категория советует разобраться, а не поднять план', () => {
    // Медиана по прыгающему ряду — не бюджет: поднимать план по ней значит закрепить хаос.
    const signals = buildSignals(
      input({
        categories: [
          {
            id: 'c2',
            name: 'Развлечения',
            plannedMinor: 2_500_00n,
            medianMinor: 7_750_00n,
            verdict: 'volatile',
            deltaPct: 210,
          },
        ],
      }),
      thresholds,
    );
    const signal = signals.find((s) => s.rule === 'volatile_category')!;
    expect(signal.actions.every((a) => a.kind !== 'set_budget')).toBe(true);
  });

  it('доля зафиксированного выше порога — сигнал внимания с процентом', () => {
    const signals = buildSignals(
      input({ incomeMinor: 100_000_00n, lockedMinor: 75_000_00n }),
      thresholds,
    );
    const locked = signals.find((s) => s.rule === 'locked_share')!;
    expect(locked.metric).toEqual({ kind: 'percent', bp: 7500 });
    expect(locked.severity).toBe('attention');
  });

  it('доля ниже порога молчит: 50% связанных денег — не новость', () => {
    const signals = buildSignals(
      input({ incomeMinor: 100_000_00n, lockedMinor: 50_000_00n }),
      thresholds,
    );
    expect(signals.some((s) => s.rule === 'locked_share')).toBe(false);
  });

  it('запас хода считается только когда известен и остаток, и темп', () => {
    const known = buildSignals(
      input({
        balancesBaseMinor: 5_000_00n,
        burn: { perDayMinor: 1_000_00n, willLast: false, runsOutOn: '2026-08-05' },
      }),
      thresholds,
    );
    expect(known.find((s) => s.rule === 'runway')?.metric).toEqual({ kind: 'days', days: 5 });

    // Остаток неизвестен (нет курса или счетов) — молчим, а не показываем ноль дней.
    const unknown = buildSignals(
      input({
        balancesBaseMinor: null,
        burn: { perDayMinor: 1_000_00n, willLast: false, runsOutOn: '2026-08-05' },
      }),
      thresholds,
    );
    expect(unknown.some((s) => s.rule === 'runway')).toBe(false);
  });

  it('освободившиеся деньги — возможность, риск цели — внимание', () => {
    const signals = buildSignals(
      input({
        forecast: [
          {
            kind: 'freed_money',
            targetId: 'd1',
            name: 'Рассрочка',
            on: '2026-08-18',
            amountMinor: 8_000_00n,
          },
          {
            kind: 'goal_at_risk',
            targetId: 'g1',
            name: 'Мотоцикл',
            on: '2027-02-21',
            amountMinor: 210_000_00n,
          },
        ],
      }),
      thresholds,
    );
    expect(signals.find((s) => s.rule === 'freed_money')?.severity).toBe('opportunity');
    expect(signals.find((s) => s.rule === 'goal_at_risk')?.severity).toBe('attention');
    // У цели под риском действие — заморозить взнос: это то, что человек реально может сделать.
    expect(signals.find((s) => s.rule === 'goal_at_risk')?.actions).toContainEqual({
      kind: 'freeze_goal',
      targetId: 'g1',
    });
  });

  it('риск идёт раньше внимания, а внутри тона — крупная метрика раньше мелкой', () => {
    const signals = buildSignals(
      input({
        overspentMinor: 100_00n,
        compressedMinor: 5_000_00n,
        burn: { perDayMinor: 800_00n, willLast: false, runsOutOn: '2026-08-02' },
      }),
      thresholds,
    );
    expect(signals[0]?.severity).toBe('risk');
    expect(signals.at(-1)?.severity).toBe('attention');
  });

  it('лимит из настроек режет хвост, а не голову', () => {
    const many = buildSignals(
      input({
        overspentMinor: 100_00n,
        compressedMinor: 5_000_00n,
        burn: { perDayMinor: 800_00n, willLast: false, runsOutOn: '2026-08-02' },
        incomeMinor: 100_000_00n,
        lockedMinor: 90_000_00n,
      }),
      { ...thresholds, maxSignals: 2 },
    );
    expect(many).toHaveLength(2);
    expect(many.every((s) => s.severity === 'risk')).toBe(true);
  });

  it('у каждого сигнала стабильный id: список не прыгает между запросами', () => {
    const twice = [0, 1].map(() =>
      buildSignals(input({ overspentMinor: 100_00n }), thresholds).map((s) => s.id),
    );
    expect(twice[0]).toEqual(twice[1]);
    expect(twice[0]?.[0]).toBe('overspent:period');
  });
});
