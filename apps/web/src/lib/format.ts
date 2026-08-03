import { money, toMajorString, type Currency } from '@multa/core';

/** Форматирует minor units в человекочитаемую сумму с группировкой по локали. */
export function formatMinor(minor: string | bigint, currency: Currency, locale: string): string {
  const major = toMajorString(money(typeof minor === 'string' ? BigInt(minor) : minor, currency));
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(major));
}

/**
 * Дата в интерфейсе — всегда дд.мм, год по требованию (решение владельца 2026-08-03).
 *
 * До этого хелпера каждое место резало ISO-строку само: `iso.slice(5)` давало «08-10» — месяц,
 * день и дефис посреди русского экрана. Читается это как 8 октября, а не 10 августа, и заметить
 * подмену нельзя: обе половины даты — правдоподобные числа.
 *
 * Год короткий: в плане и в истории он либо текущий, либо соседний, и четыре цифры отнимают место
 * у самой даты.
 */
export function formatDate(iso: string, opts: { year?: boolean } = {}): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso;
  return opts.year ? `${d}.${m}.${y.slice(2)}` : `${d}.${m}`;
}
