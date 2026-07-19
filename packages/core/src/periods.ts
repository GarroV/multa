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

export type PeriodConfig =
  | { kind: 'monthly-days'; days: number[] } // «10 и 25»
  | { kind: 'every-weeks'; weeks: number; startsOn: string } // «каждые N недель» от даты
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

/** Список дат выплат для monthly-days, начиная за месяц до `around`, длиной ~count+3 месяца. */
function monthlyPaydays(days: number[], around: string, count: number): string[] {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const start = new Date(toUTC(around));
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1 - 1; // на месяц назад
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  const monthsToGen = count + 3;
  const raw: string[] = [];
  for (let i = 0; i < monthsToGen; i++) {
    const dim = daysInMonth(year, month);
    for (const day of sorted) {
      raw.push(fromUTC(Date.UTC(year, month - 1, Math.min(day, dim))));
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  // Кламп мог создать соседние дубликаты (напр. якоря 30 и 31 в феврале).
  return raw.filter((p, idx) => idx === 0 || p !== raw[idx - 1]);
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

/** Генерит `count` периодов начиная с периода, содержащего `from`. */
export function generatePeriods(config: PeriodConfig, from: string, count: number): PayPeriod[] {
  switch (config.kind) {
    case 'monthly-days':
      return buildFrom(monthlyPaydays(config.days, from, count), from, count);
    case 'every-weeks':
      return buildFrom(everyWeeksPaydays(config.weeks, config.startsOn, from, count), from, count);
    case 'custom':
      return buildFrom([...config.dates].sort(), from, count);
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
