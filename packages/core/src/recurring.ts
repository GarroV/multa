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
import {
  nthWeekdayDatesBetween,
  yearlyDatesBetween,
  type NthWeekday,
  type Weekday,
} from './repeat.ts';

/**
 * Расписание платежа. Старые виды не переименовываются никогда: schedule лежит в jsonb, и смена
 * имени вида сделала бы нечитаемыми уже сохранённые строки.
 */
export type RecurringSchedule =
  | { readonly kind: 'monthly-days'; readonly days: readonly number[] }
  | { readonly kind: 'every-weeks'; readonly weeks: number; readonly startsOn: string }
  /** «Второй вторник месяца» (issue #55). nth = -1 — последний: «пятого» не существует. */
  | { readonly kind: 'monthly-nth-weekday'; readonly nth: NthWeekday; readonly weekday: Weekday }
  /** «Раз в год» (issue #55): страховка, домен, пошлина. */
  | { readonly kind: 'yearly'; readonly month: number; readonly day: number }
  /**
   * «В каждую выплату» (issue #55) — ровно одна дата в периоде, его начало. Ритм воркспейса знать
   * не нужно: период уже пришёл аргументом, и его граница уже сдвинута правилом выходных.
   */
  | { readonly kind: 'each-payout' }
  | { readonly kind: 'one-off'; readonly date: string }
  | { readonly kind: 'irregular' };

export interface RecurringItem {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly schedule: RecurringSchedule;
  /** С какой даты платёж существует; до неё событий нет. */
  readonly startsOn?: string | null;
  /** Отменённая подписка перестаёт быть событием, но остаётся в истории. */
  readonly endsOn?: string | null;
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
      return everyWeeksDatesBetween(
        schedule.weeks,
        schedule.startsOn,
        period.startsOn,
        period.endsOn,
      );
    case 'monthly-nth-weekday':
      return nthWeekdayDatesBetween(schedule.nth, schedule.weekday, period.startsOn, period.endsOn);
    case 'yearly':
      return yearlyDatesBetween(schedule.month, schedule.day, period.startsOn, period.endsOn);
    case 'each-payout':
      // Ровно одна дата — начало периода. Отдать заодно endsOn значило бы удвоить платёж: конец
      // одного периода это начало следующего.
      return [period.startsOn];
    case 'one-off':
      return schedule.date >= period.startsOn && schedule.date < period.endsOn
        ? [schedule.date]
        : [];
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
      // Срок жизни платежа — как у источника дохода: до первой даты и после отмены событий нет.
      if (item.startsOn && on < item.startsOn) continue;
      if (item.endsOn && on > item.endsOn) continue;
      due.push({
        id: item.id,
        name: item.name,
        amountMinor: item.amountMinor,
        currency: item.currency,
        on,
      });
    }
  }
  return due.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
}
