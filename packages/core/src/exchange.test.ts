import { describe, expect, it } from 'vitest';
import { exchangeResult } from './exchange.ts';

/** Официальный курс RUB→RSD ≈ 1.15 (за 1 рубль дают 1.15 динара). */
const official = {
  from: 'RUB',
  to: 'RSD',
  rate: '1.1500000000',
  source: 'cbr',
  date: '2026-07-30',
};

describe('exchangeResult — фактический курс и спред (01-domain-model §ExchangeOperation)', () => {
  it('обмен точно по официальному курсу — спреда нет', () => {
    const r = exchangeResult({
      fromMinor: 10000000n,
      fromCurrency: 'RUB',
      toMinor: 11500000n,
      toCurrency: 'RSD',
      official,
    });

    expect(r.effectiveRate).toBe('1.15');
    expect(r.lostMinor).toBe(0n);
    expect(r.spreadPct).toBe('0.00');
  });

  it('меняльник дал меньше — считаем недополученное и процент', () => {
    // 100 000 RUB: по официальному 115 000 RSD, дали 112 700 → недобор 2 300 RSD = 2%.
    const r = exchangeResult({
      fromMinor: 10000000n,
      fromCurrency: 'RUB',
      toMinor: 11270000n,
      toCurrency: 'RSD',
      official,
    });

    expect(r.lostMinor).toBe(230000n);
    expect(r.spreadPct).toBe('2.00');
    expect(r.effectiveRate).toBe('1.127');
  });

  it('дали больше официального — спред отрицательный, это выгода, а не ошибка', () => {
    const r = exchangeResult({
      fromMinor: 10000000n,
      fromCurrency: 'RUB',
      toMinor: 11730000n,
      toCurrency: 'RSD',
      official,
    });

    expect(r.lostMinor).toBe(-230000n);
    expect(r.spreadPct).toBe('-2.00');
  });

  it('курс считается по major-суммам, а не по minor: exponent валют разный', () => {
    // 1 000 RUB → 1 400 JPY (exponent 0): курс 1.4, а не 0.014.
    const jpy = { from: 'RUB', to: 'JPY', rate: '1.4000000000', source: 'cbr', date: '2026-07-30' };
    const r = exchangeResult({
      fromMinor: 100000n,
      fromCurrency: 'RUB',
      toMinor: 1400n,
      toCurrency: 'JPY',
      official: jpy,
    });

    expect(r.effectiveRate).toBe('1.4');
    expect(r.lostMinor).toBe(0n);
  });

  it('без официального курса спред не выдумываем', () => {
    const r = exchangeResult({
      fromMinor: 10000000n,
      fromCurrency: 'RUB',
      toMinor: 11270000n,
      toCurrency: 'RSD',
      official: null,
    });

    expect(r.effectiveRate).toBe('1.127');
    expect(r.lostMinor).toBeNull();
    expect(r.spreadPct).toBeNull();
  });

  it('нулевая отдача не роняет расчёт делением на ноль', () => {
    const r = exchangeResult({
      fromMinor: 0n,
      fromCurrency: 'RUB',
      toMinor: 11500000n,
      toCurrency: 'RSD',
      official,
    });

    expect(r.effectiveRate).toBeNull();
    expect(r.lostMinor).toBeNull();
  });
});
