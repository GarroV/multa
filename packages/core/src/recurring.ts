/**
 * Регулярные платежи вне обязательств (issue #21): подписки, уборка, страховка.
 *
 * Долги, конверты, цели и корзины уже описаны своими сущностями — здесь только то, что иначе
 * приходилось бы вспоминать головой. Модуль отвечает на один вопрос: какие платежи попадают
 * в этот период и какого числа. Границы — полуинтервал `[startsOn, endsOn)`, как у дохода и
 * факта: день выплаты принадлежит следующему периоду, иначе платёж считался бы дважды.
 *
 * Нерегулярное расписание (`irregular`) в план не тянем: без даты его нельзя ни запланировать,
 * ни предупредить о нём — это заметка, а не платёж.
 */

import { everyWeeksDatesBetween, monthlyDatesBetween, type PayPeriod } from './periods.ts';

export type RecurringSchedule =
  | { readonly kind: 'monthly-days'; readonly days: readonly number[] }
  | { readonly kind: 'every-weeks'; readonly weeks: number; readonly startsOn: string }
  | { readonly kind: 'one-off'; readonly date: string }
  | { readonly kind: 'irregular' };

export interface RecurringItem {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly schedule: RecurringSchedule;
}

export interface RecurringDue {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly on: string;
}

function datesIn(schedule: RecurringSchedule, period: PayPeriod): string[] {
  switch (schedule.kind) {
    case 'monthly-days':
      return monthlyDatesBetween(schedule.days, period.startsOn, period.endsOn);
    case 'every-weeks':
      return everyWeeksDatesBetween(schedule.weeks, schedule.startsOn, period.startsOn, period.endsOn);
    case 'one-off':
      return schedule.date >= period.startsOn && schedule.date < period.endsOn ? [schedule.date] : [];
    case 'irregular':
      return [];
  }
}

/** Платежи, приходящиеся на период, отсортированные по дате. */
export function recurringDueIn(items: readonly RecurringItem[], period: PayPeriod): RecurringDue[] {
  const due: RecurringDue[] = [];
  for (const item of items) {
    if (item.amountMinor <= 0n) continue;
    for (const on of datesIn(item.schedule, period)) {
      // Полуинтервал: endsOn — это уже следующий период.
      if (on < period.startsOn || on >= period.endsOn) continue;
      due.push({ id: item.id, name: item.name, amountMinor: item.amountMinor, currency: item.currency, on });
    }
  }
  return due.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
}
