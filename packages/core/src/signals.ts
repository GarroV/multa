/**
 * Сигналы периода (Спринт 4, сердце продукта): темп трат и предупреждение «еда кончится 21-го».
 *
 * Смысл — предупредить до того, как деньги закончились, а не констатировать факт постфактум.
 * Поэтому темп считаем по УЖЕ прошедшим дням периода, а не по всей его длине: иначе в начале
 * периода любая трата выглядела бы безобидной, а к концу сигнал приходил бы слишком поздно.
 *
 * Тон — штурман (06-design-system §Тон): модуль отдаёт дату и темп, а не оценку поведения.
 */

import { addDays, daysLeftInPeriod, type PayPeriod } from './periods.ts';

export interface BurnRateInput {
  /** План на жизнь в периоде (категории + свободный остаток). */
  readonly livingMinor: bigint;
  readonly spentLivingMinor: bigint;
  readonly period: PayPeriod;
  /** Сегодня (в таймзоне воркспейса). */
  readonly asOf: string;
}

export interface BurnRate {
  /** Фактический дневной темп трат. */
  readonly perDayMinor: bigint;
  /** Хватит ли остатка до выплаты при этом темпе. */
  readonly willLast: boolean;
  /** Дата, когда остаток кончится при текущем темпе; null — хватит до выплаты. */
  readonly runsOutOn: string | null;
}

const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

export function burnRate(input: BurnRateInput): BurnRate {
  const { livingMinor, spentLivingMinor, period, asOf } = input;
  // Первый день периода считается за один: делить на ноль нечего, а темп уже виден.
  const daysPassed = Math.max(1, daysBetween(period.startsOn, asOf) + 1);
  const perDayMinor = spentLivingMinor / BigInt(daysPassed);
  const remaining = livingMinor - spentLivingMinor;
  const daysLeft = daysLeftInPeriod(period, asOf);

  if (remaining <= 0n) {
    // Деньги уже кончились: дату не выдумываем задним числом — это «сегодня».
    return { perDayMinor, willLast: false, runsOutOn: asOf };
  }
  if (daysLeft <= 0 || perDayMinor <= 0n) {
    return { perDayMinor, willLast: true, runsOutOn: null };
  }

  const daysCovered = Number(remaining / perDayMinor);
  if (daysCovered >= daysLeft) return { perDayMinor, willLast: true, runsOutOn: null };
  return { perDayMinor, willLast: false, runsOutOn: addDays(asOf, daysCovered) };
}
