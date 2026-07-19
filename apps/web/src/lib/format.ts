import { money, toMajorString, type Currency } from '@multa/core';

/** Форматирует minor units в человекочитаемую сумму с группировкой по локали. */
export function formatMinor(minor: string | bigint, currency: Currency, locale: string): string {
  const major = toMajorString(money(typeof minor === 'string' ? BigInt(minor) : minor, currency));
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(major));
}
