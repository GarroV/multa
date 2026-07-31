import { describe, expect, it } from 'vitest';
import { divDecimal, normalizeDecimal, parseCbrXml, parseFrankfurter, resolveRate } from './fx.ts';
import type { RateSnapshot } from './money.ts';

describe('divDecimal / normalizeDecimal', () => {
  it('делит с фиксированным числом знаков', () => {
    expect(divDecimal('1', '8', 10)).toBe('0.1250000000');
    expect(divDecimal('1', '4', 2)).toBe('0.25');
    expect(divDecimal('10', '3', 4)).toBe('3.3333');
    expect(divDecimal('2', '3', 4)).toBe('0.6667');
  });

  it('округляет половину вверх', () => {
    expect(divDecimal('1', '16', 3)).toBe('0.063'); // 0.0625 → 0.063
  });

  it('бросает при делении на ноль', () => {
    expect(() => divDecimal('1', '0', 4)).toThrow();
  });

  it('normalizeDecimal убирает хвостовые нули и точку', () => {
    expect(normalizeDecimal('0.1250000000')).toBe('0.125');
    expect(normalizeDecimal('100.00')).toBe('100');
    expect(normalizeDecimal('3.3333')).toBe('3.3333');
    expect(normalizeDecimal('79.4567')).toBe('79.4567');
  });
});

describe('parseCbrXml (windows-1251, запятая, Nominal)', () => {
  const xml = `<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="19.07.2026" name="Foreign Currency Market">
  <Valute ID="R01235">
    <NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal>
    <Name>Доллар США</Name><Value>79,4567</Value><VunitRate>79,4567</VunitRate>
  </Valute>
  <Valute ID="R01820">
    <NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal>
    <Name>Иена</Name><Value>53,2100</Value><VunitRate>0,53210</VunitRate>
  </Valute>
</ValCurs>`;

  it('нормализует к курсу за 1 единицу к RUB и парсит дату DD.MM.YYYY', () => {
    const quotes = parseCbrXml(xml);
    expect(quotes).toEqual([
      { from: 'USD', to: 'RUB', rate: '79.4567', source: 'cbr', date: '2026-07-19' },
      { from: 'JPY', to: 'RUB', rate: '0.5321', source: 'cbr', date: '2026-07-19' },
    ]);
  });
});

describe('parseFrankfurter (ЕЦБ)', () => {
  it('раскладывает base→quote', () => {
    const quotes = parseFrankfurter({
      amount: 1,
      base: 'EUR',
      date: '2026-07-18',
      rates: { USD: 1.09, RUB: 98.5 },
    });
    expect(quotes).toEqual([
      { from: 'EUR', to: 'USD', rate: '1.09', source: 'frankfurter', date: '2026-07-18' },
      { from: 'EUR', to: 'RUB', rate: '98.5', source: 'frankfurter', date: '2026-07-18' },
    ]);
  });
});

describe('resolveRate', () => {
  const q = (from: string, to: string, rate: string, date: string): RateSnapshot => ({
    from,
    to,
    rate,
    source: 'cbr',
    date,
  });

  it('одинаковая валюта → курс 1', () => {
    const r = resolveRate([], 'RUB', 'RUB', '2026-07-19');
    expect(r?.rate).toBe('1');
  });

  it('прямая котировка на дату', () => {
    const quotes = [q('USD', 'RUB', '79.4567', '2026-07-19')];
    const r = resolveRate(quotes, 'USD', 'RUB', '2026-07-19');
    expect(r).toEqual(q('USD', 'RUB', '79.4567', '2026-07-19'));
  });

  it('обратная котировка → 1/rate', () => {
    const quotes = [q('USD', 'RUB', '79.4567', '2026-07-19')];
    const r = resolveRate(quotes, 'RUB', 'USD', '2026-07-19');
    expect(r?.rate).toBe(divDecimal('1', '79.4567', 10));
    expect(r?.from).toBe('RUB');
    expect(r?.to).toBe('USD');
  });

  it('кросс-курс через пивот (RUB): USD→RSD из USD→RUB и RSD→RUB', () => {
    const quotes = [
      q('USD', 'RUB', '79.4567', '2026-07-19'),
      q('RSD', 'RUB', '0.75', '2026-07-19'),
    ];
    const r = resolveRate(quotes, 'USD', 'RSD', '2026-07-19', { pivots: ['RUB'] });
    expect(r?.rate).toBe(divDecimal('79.4567', '0.75', 10));
    expect(r?.from).toBe('USD');
    expect(r?.to).toBe('RSD');
  });

  it('выходные: курса на дату нет → последний рабочий день, rate_date фактический', () => {
    const quotes = [q('USD', 'RUB', '79.4567', '2026-07-17')]; // пятница
    const r = resolveRate(quotes, 'USD', 'RUB', '2026-07-19', { maxLookbackDays: 5 }); // воскресенье
    expect(r?.rate).toBe('79.4567');
    expect(r?.date).toBe('2026-07-17');
  });

  it('нет данных в пределах lookback → null', () => {
    expect(resolveRate([], 'USD', 'RUB', '2026-07-19')).toBeNull();
  });
});
