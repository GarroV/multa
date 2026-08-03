/**
 * Источники дохода: сколько и когда приходит. Границы периодов задаёт РИТМ (PeriodConfig,
 * настройка воркспейса) — источники их не двигают. Ожидаемый доход периода = сумма событий
 * всех активных источников внутри [startsOn, endsOn).
 *
 * Даты — строки 'YYYY-MM-DD', арифметика в UTC (см. periods.ts). Деньги — integer minor units.
 */

import { money, type Money } from './money.ts';
import {
  addDays,
  everyWeeksDatesBetween,
  generatePeriods,
  monthlyDatesBetween,
  shiftForWeekend,
  type PayPeriod,
  type PeriodConfig,
  type WeekendRule,
} from './periods.ts';

export type IncomeSchedule =
  | { readonly kind: 'monthly-days'; readonly days: readonly number[] } // «10 и 25»
  | { readonly kind: 'every-weeks'; readonly weeks: number; readonly startsOn: string } // цикл от реальной даты выплаты
  | { readonly kind: 'one-off'; readonly date: string } // разовый гонорар
  /**
   * Каждый день (смены, торговля, такси). Такой доход не «нерегулярный»: он предсказуем, но не
   * датами, а частотой — планируется от суммы за раз, а не от суммы за период.
   */
  | { readonly kind: 'daily' }
  /** Раз в неделю в определённый день; 0 — воскресенье, как у `Date.getUTCDay`. */
  | { readonly kind: 'weekly'; readonly weekday: number }
  | { readonly kind: 'irregular' }; // «когда как» — в план не идёт, только факт

export type IncomeAmount =
  | { readonly kind: 'absolute'; readonly amountMinor: bigint }
  | { readonly kind: 'percent'; readonly percent: string; readonly ofMinor: bigint }; // аванс 40% от оклада

export interface IncomeSource {
  readonly id: string;
  readonly label: string;
  readonly currency: string;
  readonly schedule: IncomeSchedule;
  readonly amount: IncomeAmount;
  readonly stability: 'fixed' | 'variable';
  readonly active: boolean;
  readonly startsOn?: string;
  readonly endsOn?: string;
}

export interface IncomeEvent {
  readonly sourceId: string;
  readonly label: string;
  /** Фактическая дата прихода — после применения правила выходных. */
  readonly date: string;
  /** Сумма в валюте источника. */
  readonly amountMinor: bigint;
  readonly currency: string;
}

/**
 * Процент от суммы в BigInt с округлением вниз: «40%» от 200 000,00 → 80 000,00.
 * Планирование, не платёж — поэтому floor, а не half-up.
 */
export function percentOfMinor(ofMinor: bigint, percent: string): bigint {
  const [intPart = '0', fracPart = ''] = percent.trim().split('.');
  const scaled = BigInt((intPart || '0') + fracPart); // "12.5" → 125
  const denom = 100n * 10n ** BigInt(fracPart.length);
  return (ofMinor * scaled) / denom;
}

/** Сумма одного прихода источника в его валюте. */
export function amountOfSource(amount: IncomeAmount): bigint {
  return amount.kind === 'absolute'
    ? amount.amountMinor
    : percentOfMinor(amount.ofMinor, amount.percent);
}

/**
 * Максимальный сдвиг по правилу выходных — 2 дня, поэтому окно расширяем на 3:
 * приход из-за границы периода может попасть внутрь после сдвига (1 марта вс → 27 фев).
 */
const SHIFT_MARGIN_DAYS = 3;

/** Сырые даты расписания в окне вокруг периода, до применения правила выходных. */
/** Каждый день окна включительно. Отдельной функцией: шаг в день через «недели» читался бы ребусом. */
function dailyDatesBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  for (let day = fromIso; day <= toIso; day = addDays(day, 1)) out.push(day);
  return out;
}

function rawDatesAround(schedule: IncomeSchedule, period: PayPeriod): string[] {
  const from = addDays(period.startsOn, -SHIFT_MARGIN_DAYS);
  const to = addDays(period.endsOn, SHIFT_MARGIN_DAYS);
  switch (schedule.kind) {
    case 'monthly-days':
      return monthlyDatesBetween(schedule.days, from, to);
    case 'every-weeks':
      return everyWeeksDatesBetween(schedule.weeks, schedule.startsOn, from, to);
    case 'one-off':
      return schedule.date >= from && schedule.date <= to ? [schedule.date] : [];
    case 'daily':
      return dailyDatesBetween(from, to);
    case 'weekly': {
      // Первый нужный день недели в окне, дальше шаг в неделю.
      const shift = (schedule.weekday - new Date(`${from}T00:00:00Z`).getUTCDay() + 7) % 7;
      return everyWeeksDatesBetween(1, addDays(from, shift), from, to);
    }
    case 'irregular':
      return []; // в план не идёт по инварианту
  }
}

/** Даты прихода источника внутри [startsOn, endsOn) с учётом правила выходных и срока жизни источника. */
function datesIn(source: IncomeSource, period: PayPeriod, weekendRule: WeekendRule): string[] {
  return rawDatesAround(source.schedule, period)
    .map((date) => shiftForWeekend(date, weekendRule))
    .filter((date) => date >= period.startsOn && date < period.endsOn)
    .filter((date) => source.startsOn === undefined || date >= source.startsOn)
    .filter((date) => source.endsOn === undefined || date <= source.endsOn)
    .sort();
}

/** Приходы всех активных источников внутри периода, отсортированные по дате. */
export function incomeEventsIn(
  sources: readonly IncomeSource[],
  period: PayPeriod,
  weekendRule: WeekendRule = 'as-is',
): IncomeEvent[] {
  const events: IncomeEvent[] = [];
  for (const source of sources) {
    if (!source.active) continue;
    const amountMinor = amountOfSource(source.amount);
    if (amountMinor <= 0n) continue; // пустой источник в план не тянем
    for (const date of datesIn(source, period, weekendRule)) {
      events.push({
        sourceId: source.id,
        label: source.label,
        date,
        amountMinor,
        currency: source.currency,
      });
    }
  }
  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface IncomeTotal {
  /** Сумма приходов в базовой валюте. */
  readonly incomeMinor: bigint;
  readonly events: readonly IncomeEvent[];
  /** Приходы, которые не удалось привести к базовой валюте (курс недоступен). */
  readonly unresolved: readonly IncomeEvent[];
}

/**
 * Ожидаемый доход периода в базовой валюте. Конвертация — инъекцией: ядро не знает
 * про БД и кеш курсов. Недоступный курс уводит приход в `unresolved`, а не в молчаливый
 * ноль: заниженный доход раздувает сжатие каскада.
 */
export function expectedIncomeForPeriod(
  events: readonly IncomeEvent[],
  base: string,
  toBase: (m: Money) => Money | null,
): IncomeTotal {
  let incomeMinor = 0n;
  const unresolved: IncomeEvent[] = [];
  for (const event of events) {
    if (event.currency === base) {
      incomeMinor += event.amountMinor;
      continue;
    }
    const converted = toBase(money(event.amountMinor, event.currency));
    if (converted === null) {
      unresolved.push(event);
      continue;
    }
    incomeMinor += converted.minor;
  }
  return { incomeMinor, events, unresolved };
}

/**
 * Границы периодов, в которые ни один источник не платит. Информационно: ритм задаёт
 * пользователь, и «период начинается 10-го, а зарплата приходит 12-го» — его право,
 * но об этом стоит сказать.
 */
export function rhythmMismatches(
  rhythm: PeriodConfig,
  sources: readonly IncomeSource[],
  weekendRule: WeekendRule,
  from: string,
  count = 2,
): string[] {
  return generatePeriods(rhythm, from, count)
    .filter(
      (period) =>
        !incomeEventsIn(sources, period, weekendRule).some((e) => e.date === period.startsOn),
    )
    .map((period) => period.startsOn);
}
