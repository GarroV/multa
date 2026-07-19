import { describe, expect, it } from 'vitest';
import {
  abs,
  add,
  compare,
  convert,
  exponentOf,
  fromMajor,
  isZero,
  money,
  negate,
  subtract,
  toMajorString,
  type RateSnapshot,
} from './money.ts';

describe('exponentOf', () => {
  it('возвращает 2 для типовых валют', () => {
    expect(exponentOf('RUB')).toBe(2);
    expect(exponentOf('EUR')).toBe(2);
    expect(exponentOf('USD')).toBe(2);
    expect(exponentOf('RSD')).toBe(2);
    expect(exponentOf('GEL')).toBe(2);
  });

  it('возвращает 0 для валют без минорных единиц (JPY, KRW)', () => {
    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('KRW')).toBe(0);
  });

  it('возвращает 3 для валют с тремя знаками (BHD, KWD)', () => {
    expect(exponentOf('BHD')).toBe(3);
    expect(exponentOf('KWD')).toBe(3);
  });

  it('по умолчанию 2 для неизвестной валюты', () => {
    expect(exponentOf('XTS')).toBe(2);
  });
});

describe('fromMajor / toMajorString', () => {
  it('парсит целое без дробной части', () => {
    expect(fromMajor('18000', 'RUB').minor).toBe(1800000n);
  });

  it('парсит дробную часть по экспоненте валюты', () => {
    expect(fromMajor('79.45', 'RUB').minor).toBe(7945n);
    expect(fromMajor('4.5', 'EUR').minor).toBe(450n);
  });

  it('дополняет недостающие знаки нулями', () => {
    expect(fromMajor('4.5', 'BHD').minor).toBe(4500n); // exp 3
  });

  it('уважает нулевую экспоненту (JPY)', () => {
    expect(fromMajor('1000', 'JPY').minor).toBe(1000n);
  });

  it('парсит отрицательные суммы', () => {
    expect(fromMajor('-250', 'RSD').minor).toBe(-25000n);
  });

  it('бросает при большем числе знаков, чем экспонента (потеря точности)', () => {
    expect(() => fromMajor('1.234', 'RUB')).toThrow();
    expect(() => fromMajor('1.5', 'JPY')).toThrow();
  });

  it('бросает на нечисловом вводе (например, запятой)', () => {
    expect(() => fromMajor('79,45', 'RUB')).toThrow();
  });

  it('round-trip fromMajor → toMajorString', () => {
    expect(toMajorString(fromMajor('79.45', 'RUB'))).toBe('79.45');
    expect(toMajorString(fromMajor('1000', 'JPY'))).toBe('1000');
    expect(toMajorString(fromMajor('4.500', 'BHD'))).toBe('4.500');
    expect(toMajorString(fromMajor('-250', 'RSD'))).toBe('-250.00');
  });
});

describe('арифметика', () => {
  it('складывает суммы одной валюты', () => {
    expect(add(money(1800000n, 'RUB'), money(200000n, 'RUB'))).toEqual(money(2000000n, 'RUB'));
  });

  it('вычитает суммы одной валюты', () => {
    expect(subtract(money(2000000n, 'RUB'), money(1800000n, 'RUB'))).toEqual(money(200000n, 'RUB'));
  });

  it('бросает при сложении разных валют', () => {
    expect(() => add(money(100n, 'RUB'), money(100n, 'EUR'))).toThrow();
  });

  it('negate / abs / isZero / compare', () => {
    expect(negate(money(100n, 'RUB')).minor).toBe(-100n);
    expect(abs(money(-100n, 'RUB')).minor).toBe(100n);
    expect(isZero(money(0n, 'RUB'))).toBe(true);
    expect(isZero(money(1n, 'RUB'))).toBe(false);
    expect(compare(money(100n, 'RUB'), money(200n, 'RUB'))).toBe(-1);
    expect(compare(money(200n, 'RUB'), money(100n, 'RUB'))).toBe(1);
    expect(compare(money(100n, 'RUB'), money(100n, 'RUB'))).toBe(0);
  });
});

describe('convert (иммутабельный снапшот курса)', () => {
  const rate = (from: string, to: string, r: string): RateSnapshot => ({
    from,
    to,
    rate: r,
    source: 'cbr',
    date: '2026-03-19',
  });

  it('конвертирует EUR→RUB (1 EUR = 98.1 RUB)', () => {
    // 650.00 EUR → 63 765.00 RUB
    const result = convert(money(65000n, 'EUR'), rate('EUR', 'RUB', '98.1'));
    expect(result).toEqual(money(6376500n, 'RUB'));
  });

  it('корректно работает при разных экспонентах (JPY exp0 → RUB exp2)', () => {
    // 1000 JPY * 0.62 = 620.00 RUB
    const result = convert(money(1000n, 'JPY'), rate('JPY', 'RUB', '0.62'));
    expect(result).toEqual(money(62000n, 'RUB'));
  });

  it('округляет половину вверх (от нуля)', () => {
    // 355.00 RUB * 0.011 = 3.905 EUR → 3.91
    const result = convert(money(35500n, 'RUB'), rate('RUB', 'EUR', '0.011'));
    expect(result).toEqual(money(391n, 'EUR'));
  });

  it('округляет вниз, когда дробь < 0.5', () => {
    // 333.00 RUB * 0.011 = 3.663 EUR → 3.66
    const result = convert(money(33300n, 'RUB'), rate('RUB', 'EUR', '0.011'));
    expect(result).toEqual(money(366n, 'EUR'));
  });

  it('симметрично округляет отрицательные (−0.5 → от нуля)', () => {
    // −355.00 RUB * 0.011 → −3.91
    const result = convert(money(-35500n, 'RUB'), rate('RUB', 'EUR', '0.011'));
    expect(result).toEqual(money(-391n, 'EUR'));
  });

  it('бросает, если валюта суммы не совпадает с from снапшота', () => {
    expect(() => convert(money(100n, 'USD'), rate('EUR', 'RUB', '98.1'))).toThrow();
  });
});
