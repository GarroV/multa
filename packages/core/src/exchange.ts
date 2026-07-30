/**
 * Факт размена: из суммы «отдал» и суммы «получил» выводим фактический курс, а рядом с
 * официальным курсом на дату — спред (01-domain-model §ExchangeOperation).
 *
 * Спред считаем в валюте получения: «недополучил столько-то динаров» понятнее, чем проценты.
 * Отрицательный спред не прячем — иногда обменник даёт лучше банка, и это тоже правда.
 * Если официального курса нет, спред не выдумываем: null честнее нуля.
 */

import { convert, exponentOf, money, type Currency, type RateSnapshot } from './money.ts';

export interface ExchangeInput {
  readonly fromMinor: bigint;
  readonly fromCurrency: Currency;
  readonly toMinor: bigint;
  readonly toCurrency: Currency;
  /** Официальный курс from→to на дату операции; null — котировки нет. */
  readonly official: RateSnapshot | null;
}

export interface ExchangeResult {
  /** Фактический курс as major/major, строкой без хвостовых нулей. null — отдали ноль. */
  readonly effectiveRate: string | null;
  /** Недополучено в валюте получения (minor). Отрицательное — получено больше официального. */
  readonly lostMinor: bigint | null;
  /** Спред в процентах от ожидаемого по официальному курсу, две цифры после точки. */
  readonly spreadPct: string | null;
}

const POW10 = (n: number): bigint => 10n ** BigInt(n);

/** Курс = (to / 10^expTo) / (from / 10^expFrom). Считаем в целых, форматируем строкой. */
function effectiveRateOf(input: ExchangeInput): string | null {
  if (input.fromMinor <= 0n || input.toMinor < 0n) return null;
  const expFrom = exponentOf(input.fromCurrency);
  const expTo = exponentOf(input.toCurrency);
  // rate * 10^scale, scale берём с запасом, потом обрезаем хвостовые нули.
  const scale = 10;
  const numerator = input.toMinor * POW10(expFrom) * POW10(scale);
  const denominator = input.fromMinor * POW10(expTo);
  const scaled = numerator / denominator;
  const whole = scaled / POW10(scale);
  const frac = (scaled % POW10(scale)).toString().padStart(scale, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function exchangeResult(input: ExchangeInput): ExchangeResult {
  const effectiveRate = effectiveRateOf(input);
  if (effectiveRate === null) return { effectiveRate: null, lostMinor: null, spreadPct: null };
  if (!input.official) return { effectiveRate, lostMinor: null, spreadPct: null };

  const expected = convert(money(input.fromMinor, input.fromCurrency), input.official).minor;
  if (expected <= 0n) return { effectiveRate, lostMinor: null, spreadPct: null };

  const lostMinor = expected - input.toMinor;
  // Процент с двумя знаками: считаем в целых (×10000), затем вставляем точку.
  const pctScaled = (lostMinor * 10000n) / expected;
  const sign = pctScaled < 0n ? '-' : '';
  const abs = pctScaled < 0n ? -pctScaled : pctScaled;
  const spreadPct = `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return { effectiveRate, lostMinor, spreadPct };
}
