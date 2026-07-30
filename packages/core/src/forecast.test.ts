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

    expect(events.find((e) => e.kind === 'freed_money')).toMatchObject({ amountMinor: 4500000n, periodsAway: 2 });
  });

  it('цель достигается в срок — событие достижения', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 12,
      periodLengthDays: 15,
      debts: [],
      goals: [{ id: 'moto', name: 'Мотоцикл', targetMinor: 30000n, savedMinor: 10000n, perPeriodMinor: 5000n }],
    });

    expect(events.find((e) => e.kind === 'goal_reached')).toMatchObject({ targetId: 'moto', periodsAway: 4 });
  });

  it('цель не успевает в горизонт — предупреждение о риске, а не тишина', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 3,
      periodLengthDays: 15,
      debts: [],
      goals: [{ id: 'moto', name: 'Мотоцикл', targetMinor: 300000n, savedMinor: 0n, perPeriodMinor: 5000n }],
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
      goals: [{ id: 'moto', name: 'Мотоцикл', targetMinor: 30000n, savedMinor: 0n, perPeriodMinor: 0n }],
    });

    expect(events.find((e) => e.kind === 'goal_at_risk')).toMatchObject({ targetId: 'moto' });
  });

  it('уже накопленная цель не попадает в прогноз как событие будущего', () => {
    const events = forecastTimeline({
      asOf,
      periodsAhead: 6,
      periodLengthDays: 15,
      debts: [],
      goals: [{ id: 'moto', name: 'Мотоцикл', targetMinor: 30000n, savedMinor: 30000n, perPeriodMinor: 5000n }],
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
      goals: [{ id: 'g1', name: 'Цель', targetMinor: 30000n, savedMinor: 10000n, perPeriodMinor: 5000n }],
    });

    const dates = events.map((e) => e.on);
    expect([...dates].sort()).toEqual(dates);
  });
});
