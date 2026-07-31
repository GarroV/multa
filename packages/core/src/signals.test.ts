import { describe, expect, it } from 'vitest';
import { burnRate } from './signals.ts';

const period = { startsOn: '2026-07-25', endsOn: '2026-08-10' };

describe('burnRate — темп трат и когда кончатся деньги (Спринт 4)', () => {
  it('считает дневной темп по прошедшим дням, а не по всему периоду', () => {
    // 5 дней прошло (25–29), потрачено 10 000 → темп 2 000/день.
    const r = burnRate({
      livingMinor: 100000n,
      spentLivingMinor: 10000n,
      period,
      asOf: '2026-07-29',
    });

    expect(r.perDayMinor).toBe(2000n);
  });

  it('при текущем темпе денег хватает — сигнала нет', () => {
    // Осталось 90 000, темп 2 000/день, до выплаты 12 дней → нужно 24 000. Хватает.
    const r = burnRate({
      livingMinor: 100000n,
      spentLivingMinor: 10000n,
      period,
      asOf: '2026-07-29',
    });

    expect(r.willLast).toBe(true);
    expect(r.runsOutOn).toBeNull();
  });

  it('темп выше плана — говорит, какого числа кончатся деньги', () => {
    // 5 дней, потрачено 60 000 → темп 12 000/день. Осталось 40 000 → хватит на 3 дня.
    const r = burnRate({
      livingMinor: 100000n,
      spentLivingMinor: 60000n,
      period,
      asOf: '2026-07-29',
    });

    expect(r.perDayMinor).toBe(12000n);
    expect(r.willLast).toBe(false);
    expect(r.runsOutOn).toBe('2026-08-01'); // 29 июля + 3 дня
  });

  it('деньги уже кончились — дата в прошлом не выдумывается, берётся сегодня', () => {
    const r = burnRate({
      livingMinor: 100000n,
      spentLivingMinor: 120000n,
      period,
      asOf: '2026-07-29',
    });

    expect(r.willLast).toBe(false);
    expect(r.runsOutOn).toBe('2026-07-29');
  });

  it('первый день периода: делим на один день, а не на ноль', () => {
    const r = burnRate({
      livingMinor: 100000n,
      spentLivingMinor: 3000n,
      period,
      asOf: '2026-07-25',
    });

    expect(r.perDayMinor).toBe(3000n);
  });

  it('без трат темпа нет и предсказывать нечего', () => {
    const r = burnRate({ livingMinor: 100000n, spentLivingMinor: 0n, period, asOf: '2026-07-29' });

    expect(r.perDayMinor).toBe(0n);
    expect(r.willLast).toBe(true);
    expect(r.runsOutOn).toBeNull();
  });

  it('план на нуле: любая трата означает, что запаса нет', () => {
    const r = burnRate({ livingMinor: 0n, spentLivingMinor: 500n, period, asOf: '2026-07-29' });

    expect(r.willLast).toBe(false);
    expect(r.runsOutOn).toBe('2026-07-29');
  });

  it('последний день периода — прогноз не нужен, до выплаты дошли', () => {
    const r = burnRate({
      livingMinor: 100000n,
      spentLivingMinor: 90000n,
      period,
      asOf: '2026-08-10',
    });

    expect(r.willLast).toBe(true);
    expect(r.runsOutOn).toBeNull();
  });
});
