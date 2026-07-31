import { describe, expect, it } from 'vitest';
import { recurringDueIn } from './recurring.ts';

const period = { startsOn: '2026-07-25', endsOn: '2026-08-10' };

describe('recurringDueIn — регулярные платежи внутри периода (#21)', () => {
  it('месячный платёж попадает в период, если его число внутри границ', () => {
    const due = recurringDueIn(
      [
        {
          id: 'net',
          name: 'Netflix',
          amountMinor: 150000n,
          currency: 'RUB',
          schedule: { kind: 'monthly-days', days: [1] },
        },
      ],
      period,
    );

    expect(due).toEqual([
      { id: 'net', name: 'Netflix', amountMinor: 150000n, currency: 'RUB', on: '2026-08-01' },
    ]);
  });

  it('платёж вне границ периода не показывается', () => {
    expect(
      recurringDueIn(
        [
          {
            id: 'net',
            name: 'Netflix',
            amountMinor: 150000n,
            currency: 'RUB',
            schedule: { kind: 'monthly-days', days: [20] },
          },
        ],
        period,
      ),
    ).toEqual([]);
  });

  it('день выплаты (граница endsOn) относится к следующему периоду — полуинтервал', () => {
    expect(
      recurringDueIn(
        [
          {
            id: 'x',
            name: 'Аренда',
            amountMinor: 100n,
            currency: 'RUB',
            schedule: { kind: 'monthly-days', days: [10] },
          },
        ],
        period,
      ),
    ).toEqual([]);
  });

  it('несколько дат в месяц дают несколько платежей', () => {
    const due = recurringDueIn(
      [
        {
          id: 'x',
          name: 'Подписки',
          amountMinor: 100n,
          currency: 'RUB',
          schedule: { kind: 'monthly-days', days: [26, 5] },
        },
      ],
      period,
    );

    expect(due.map((d) => d.on)).toEqual(['2026-07-26', '2026-08-05']);
  });

  it('каждые N недель считаются от своей стартовой даты', () => {
    const due = recurringDueIn(
      [
        {
          id: 'x',
          name: 'Уборка',
          amountMinor: 300000n,
          currency: 'RUB',
          schedule: { kind: 'every-weeks', weeks: 2, startsOn: '2026-07-01' },
        },
      ],
      period,
    );

    expect(due.map((d) => d.on)).toEqual(['2026-07-29']);
  });

  it('разовый платёж виден только в своём периоде', () => {
    const item = {
      id: 'x',
      name: 'Страховка',
      amountMinor: 500000n,
      currency: 'RUB',
      schedule: { kind: 'one-off' as const, date: '2026-08-03' },
    };

    expect(recurringDueIn([item], period).map((d) => d.on)).toEqual(['2026-08-03']);
    expect(recurringDueIn([item], { startsOn: '2026-08-10', endsOn: '2026-08-25' })).toEqual([]);
  });

  it('нерегулярный платёж в план не тянем: даты у него нет', () => {
    expect(
      recurringDueIn(
        [
          {
            id: 'x',
            name: 'Разное',
            amountMinor: 100n,
            currency: 'RUB',
            schedule: { kind: 'irregular' },
          },
        ],
        period,
      ),
    ).toEqual([]);
  });

  it('события отсортированы по дате', () => {
    const due = recurringDueIn(
      [
        {
          id: 'b',
          name: 'Позже',
          amountMinor: 100n,
          currency: 'RUB',
          schedule: { kind: 'monthly-days', days: [8] },
        },
        {
          id: 'a',
          name: 'Раньше',
          amountMinor: 100n,
          currency: 'RUB',
          schedule: { kind: 'monthly-days', days: [26] },
        },
      ],
      period,
    );

    expect(due.map((d) => d.id)).toEqual(['a', 'b']);
  });
});
