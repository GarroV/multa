import { describe, expect, it } from 'vitest';
import { forecastTimeline } from './forecast.ts';

const asOf = '2026-07-30';

describe('forecastTimeline — лента cash-flow вперёд (Спринт 4)', () => {
  it('долг закрывается, когда остаток выбирается платежами: событие с датой', () => {
    // Остаток 90 000, платёж 45 000 за период, периодов в месяце два → закроется через 2 периода.
    const events = forecastTimeline({
      asOf,
      periodsAhead: 6,
      periodLengthDays: 15,
      debts: [{ id: 'ozon', name: 'Озон', remainingMinor: 9000000n, paymentMinor: 4500000n }],
      goals: [],
    });

    const closing = events.find((e) => e.kind === 'debt_closed');
    expect(closing).toMatchObject({ targetId: 'ozon', periodsAway: 2 });
    expect(closing?.on).toBe('2026-08-29'); // 30.07 + 2 периода по 15 дней
  });

  it('после закрытия долга освобождается платёж — это отдельное событие', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 6,
      periodLengthDays: 15,
      debts: [{ id: 'ozon', name: 'Озон', remainingMinor: 9000000n, paymentMinor: 4500000n }],
      goals: [],
    });

    expect(events.find((e) => e.kind === 'freed_money')).toMatchObject({
      amountMinor: 4500000n,
      periodsAway: 2,
    });
  });

  it('цель достигается в срок — событие достижения', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 12,
      periodLengthDays: 15,
      debts: [],
      goals: [
        {
          id: 'moto',
          name: 'Мотоцикл',
          targetMinor: 30000n,
          savedMinor: 10000n,
          perPeriodMinor: 5000n,
        },
      ],
    });

    expect(events.find((e) => e.kind === 'goal_reached')).toMatchObject({
      targetId: 'moto',
      periodsAway: 4,
    });
  });

  it('цель не успевает в горизонт — предупреждение о риске, а не тишина', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 3,
      periodLengthDays: 15,
      debts: [],
      goals: [
        {
          id: 'moto',
          name: 'Мотоцикл',
          targetMinor: 300000n,
          savedMinor: 0n,
          perPeriodMinor: 5000n,
        },
      ],
    });

    expect(events.find((e) => e.kind === 'goal_at_risk')).toMatchObject({ targetId: 'moto' });
    expect(events.some((e) => e.kind === 'goal_reached')).toBe(false);
  });

  it('цель без взносов не «достигается никогда» молча — тоже риск', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 6,
      periodLengthDays: 15,
      debts: [],
      goals: [
        { id: 'moto', name: 'Мотоцикл', targetMinor: 30000n, savedMinor: 0n, perPeriodMinor: 0n },
      ],
    });

    expect(events.find((e) => e.kind === 'goal_at_risk')).toMatchObject({ targetId: 'moto' });
  });

  it('уже накопленная цель не попадает в прогноз как событие будущего', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 6,
      periodLengthDays: 15,
      debts: [],
      goals: [
        {
          id: 'moto',
          name: 'Мотоцикл',
          targetMinor: 30000n,
          savedMinor: 30000n,
          perPeriodMinor: 5000n,
        },
      ],
    });

    expect(events).toEqual([]);
  });

  it('долг без платежа не закроется — молча его не «закрываем»', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 6,
      periodLengthDays: 15,
      debts: [{ id: 'ozon', name: 'Озон', remainingMinor: 9000000n, paymentMinor: 0n }],
      goals: [],
    });

    expect(events).toEqual([]);
  });

  it('события отсортированы по дате: лента читается сверху вниз', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 12,
      periodLengthDays: 15,
      debts: [{ id: 'd1', name: 'Долг', remainingMinor: 900000n, paymentMinor: 450000n }],
      goals: [
        { id: 'g1', name: 'Цель', targetMinor: 30000n, savedMinor: 10000n, perPeriodMinor: 5000n },
      ],
    });

    const dates = events.map((e) => e.on);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('прогноз считается по платежу, который будет, а не по сегодняшнему (#103)', () => {
  /*
   * Ступени суммы человек заводит из интерфейса («с ноября плачу по 5 000»), и весь остальной код
   * ходит через `amountOn`. Прогноз брал плоский `paymentMinor` — и обещал закрытие долга в разы
   * позже или раньше, чем есть. Это не неточность: прогноз и существует ради ответа «когда я
   * вылезу», по нему принимают решения.
   */
  it('ступень платежа приближает закрытие долга', () => {
    const events = forecastTimeline({
      asOf: '2026-08-01',
      periodsAhead: 12,
      periodLengthDays: 15,
      debts: [
        {
          id: 'd1',
          name: 'Кредит',
          remainingMinor: 3_000_000n,
          paymentMinor: 100_000n,
          // Со второго периода платёж впятеро больше: 100 000 + 6 × 500 000 = 3 100 000.
          paymentsByPeriod: [100_000n, 500_000n, 500_000n, 500_000n, 500_000n, 500_000n, 500_000n],
        },
      ],
      goals: [],
    });
    const closed = events.find((e) => e.kind === 'debt_closed');
    // Без ступеней 3 000 000 / 100 000 = 30 периодов — за горизонт, события не было бы вовсе.
    expect(closed).toBeDefined();
    expect(closed!.periodsAway).toBe(7);
  });

  it('без ступеней считается по обычному платежу — прежнее поведение цело', () => {
    const events = forecastTimeline({
      asOf: '2026-08-01',
      periodsAhead: 12,
      periodLengthDays: 15,
      debts: [{ id: 'd1', name: 'Кредит', remainingMinor: 300_000n, paymentMinor: 100_000n }],
      goals: [],
    });
    expect(events.find((e) => e.kind === 'debt_closed')!.periodsAway).toBe(3);
  });
});

describe('регулярные платежи попадают на горизонт, а не только в текущий период (#103)', () => {
  it('ежегодный платёж внутри горизонта виден заранее', () => {
    const events = forecastTimeline({
      asOf: '2026-08-01',
      periodsAhead: 12,
      periodLengthDays: 15,
      debts: [],
      goals: [],
      recurring: [
        { id: 'r1', name: 'Страховка', on: '2026-12-20', amountMinor: 4_500_000n },
        // За горизонтом (12 периодов по 15 дней ≈ 180 дней) — не показываем, чтобы не врать точностью.
        { id: 'r2', name: 'Домен', on: '2027-06-01', amountMinor: 120_000n },
      ],
    });
    const due = events.filter((e) => e.kind === 'recurring_due');
    expect(due.map((e) => e.name)).toEqual(['Страховка']);
    expect(due[0]!.amountMinor).toBe(4_500_000n);
  });

  it('события ленты отсортированы по дате независимо от вида', () => {
    const events = forecastTimeline({
      asOf: '2026-08-01',
      periodsAhead: 12,
      periodLengthDays: 15,
      debts: [{ id: 'd1', name: 'Кредит', remainingMinor: 300_000n, paymentMinor: 100_000n }],
      goals: [],
      recurring: [{ id: 'r1', name: 'Страховка', on: '2026-08-10', amountMinor: 4_500_000n }],
    });
    const dates = events.map((e) => e.on);
    expect([...dates].sort()).toEqual(dates);
  });
});
