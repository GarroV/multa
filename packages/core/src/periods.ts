/**
 * Периоды выплат (PayPeriod). Всё планирование живёт в периодах, не в календарных месяцах.
 * Интервал полуоткрытый [startsOn, endsOn): день выплаты начинает НОВЫЙ период,
 * поэтому транзакция в день выплаты попадает в новый период.
 *
 * Даты — строки 'YYYY-MM-DD', вся арифметика в UTC (без DST-дрейфа).
 * Лексикографическое сравнение ISO-дат совпадает с хронологическим.
 */

export interface PayPeriod {
  readonly startsOn: string;
  readonly endsOn: string;
}

/** Правило переноса выплаты, попавшей на выходной. В РФ и Сербии обычно платят раньше. */
export type WeekendRule = 'as-is' | 'before' | 'after';

export type PeriodConfig =
  | { kind: 'monthly-days'; days: number[]; weekendRule?: WeekendRule } // «10 и 25»
  | { kind: 'every-weeks'; weeks: number; startsOn: string; weekendRule?: WeekendRule } // «каждые N недель» от даты
  | { kind: 'custom'; dates: string[] }; // явные даты выплат

const MS_PER_DAY = 86_400_000;

function toUTC(iso: string): number {
  const parts = iso.split('-');
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function fromUTC(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysInMonth(year: number, month1to12: number): number {
  // День 0 следующего месяца = последний день текущего.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round((toUTC(toIso) - toUTC(fromIso)) / MS_PER_DAY);
}

/** Сдвиг ISO-даты на n дней (n может быть отрицательным). */
export function addDays(iso: string, n: number): string {
  return fromUTC(toUTC(iso) + n * MS_PER_DAY);
}

/**
 * Дата выплаты с учётом правила выходных: 'before' — предшествующая пятница,
 * 'after' — следующий понедельник. Влияет на границы периодов, поэтому применяется
 * до сборки периодов, а не при отображении.
 */
export function shiftForWeekend(iso: string, rule: WeekendRule = 'as-is'): string {
  if (rule === 'as-is') return iso;
  const weekday = new Date(toUTC(iso)).getUTCDay(); // 0 = вс, 6 = сб
  if (weekday !== 0 && weekday !== 6) return iso;
  const delta = rule === 'before' ? (weekday === 6 ? -1 : -2) : weekday === 6 ? 2 : 1;
  return addDays(iso, delta);
}

/** Сортировка + дедуп: сдвиг по выходным и кламп коротких месяцев могут дать одну дату из двух. */
function normalizeDates(dates: readonly string[]): string[] {
  const sorted = [...dates].sort();
  return sorted.filter((d, i) => i === 0 || d !== sorted[i - 1]);
}

/** Даты «дней месяца» внутри окна [fromIso, toIso] с клампом к длине месяца. Отсортированы, без дублей. */
export function monthlyDatesBetween(
  days: readonly number[],
  fromIso: string,
  toIso: string,
): string[] {
  const sortedDays = [...new Set(days)].sort((a, b) => a - b);
  const start = new Date(toUTC(fromIso));
  const end = new Date(toUTC(toIso));
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  const lastYear = end.getUTCFullYear();
  const lastMonth = end.getUTCMonth() + 1;
  const out: string[] = [];
  while (year * 12 + month <= lastYear * 12 + lastMonth) {
    const dim = daysInMonth(year, month);
    for (const day of sortedDays) {
      out.push(fromUTC(Date.UTC(year, month - 1, Math.min(day, dim))));
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return normalizeDates(out).filter((d) => d >= fromIso && d <= toIso);
}

/** Даты цикла «каждые N недель» от якорной даты внутри окна [fromIso, toIso]. Дат до якоря не бывает. */
export function everyWeeksDatesBetween(
  weeks: number,
  anchorStart: string,
  fromIso: string,
  toIso: string,
): string[] {
  const stepDays = weeks * 7;
  const out: string[] = [];
  let current = anchorStart;
  // Прыжок к началу окна, чтобы не шагать по одному циклу от далёкого якоря.
  const gap = diffDays(anchorStart, fromIso);
  if (gap > 0) current = addDays(anchorStart, Math.floor(gap / stepDays) * stepDays);
  while (current <= toIso) {
    if (current >= fromIso) out.push(current);
    current = addDays(current, stepDays);
  }
  return out;
}

/** Список дат выплат для monthly-days, начиная за месяц до `around`, длиной ~count+3 месяца. */
function monthlyPaydays(days: number[], around: string, count: number): string[] {
  const from = addDays(around, -62); // месяц назад с запасом на любую длину месяца
  const to = addDays(around, 31 * (count + 3));
  return monthlyDatesBetween(days, from, to);
}

function everyWeeksPaydays(weeks: number, anchorStart: string, around: string, count: number): string[] {
  const step = weeks * 7;
  const base = toUTC(anchorStart);
  const target = toUTC(around);
  let k0 = Math.floor((target - base) / (step * MS_PER_DAY));
  if (k0 < 0) k0 = 0;
  const paydays: string[] = [];
  for (let k = k0; k <= k0 + count + 1; k++) {
    paydays.push(fromUTC(base + k * step * MS_PER_DAY));
  }
  return paydays;
}

function buildFrom(paydays: string[], from: string, count: number): PayPeriod[] {
  let i0 = 0;
  for (let i = 0; i < paydays.length; i++) {
    const p = paydays[i];
    if (p !== undefined && p <= from) i0 = i;
    else break;
  }
  const periods: PayPeriod[] = [];
  for (let k = i0; k < i0 + count && k + 1 < paydays.length; k++) {
    const startsOn = paydays[k];
    const endsOn = paydays[k + 1];
    if (startsOn === undefined || endsOn === undefined) break;
    periods.push({ startsOn, endsOn });
  }
  return periods;
}

/** Сдвигает даты выплат по правилу выходных и нормализует (сдвиг может склеить две даты в одну). */
function withWeekendRule(paydays: string[], rule: WeekendRule | undefined): string[] {
  if (!rule || rule === 'as-is') return paydays;
  return normalizeDates(paydays.map((d) => shiftForWeekend(d, rule)));
}

/** Генерит `count` периодов начиная с периода, содержащего `from`. */
export function generatePeriods(config: PeriodConfig, from: string, count: number): PayPeriod[] {
  switch (config.kind) {
    case 'monthly-days':
      return buildFrom(
        withWeekendRule(monthlyPaydays(config.days, from, count), config.weekendRule),
        from,
        count,
      );
    case 'every-weeks':
      return buildFrom(
        withWeekendRule(
          everyWeeksPaydays(config.weeks, config.startsOn, from, count),
          config.weekendRule,
        ),
        from,
        count,
      );
    case 'custom':
      return buildFrom(normalizeDates(config.dates), from, count);
  }
}

/** Период, содержащий заданную дату. Бросает, если определить нельзя (custom вне диапазона). */
export function periodForDate(config: PeriodConfig, date: string): PayPeriod {
  const period = generatePeriods(config, date, 1)[0];
  if (!period) {
    throw new Error(`Невозможно определить период для даты ${date} при данной конфигурации`);
  }
  return period;
}

/** Число дней в периоде (от start до end, не включая end). */
export function daysInPeriod(period: PayPeriod): number {
  return diffDays(period.startsOn, period.endsOn);
}

/** Дней от `asOf` до конца периода (не может быть меньше 0). Основа «цифры дня». */
export function daysLeftInPeriod(period: PayPeriod, asOf: string): number {
  return Math.max(0, diffDays(asOf, period.endsOn));
}
