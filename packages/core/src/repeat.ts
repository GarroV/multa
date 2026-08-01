/**
 * Правила повтора платежа сверх «числа месяца» (issue #55): «N-й день недели месяца» и
 * «ежегодно», плюс вывод вариантов повтора из выбранной даты.
 *
 * Правило, определяющее весь модуль: **правило не имеет права молча не сработать**. Пятого
 * вторника в месяце может не быть, 29 февраля бывает раз в четыре года. Если такое правило просто
 * не даёт даты, платёж исчезает из плана без единого сигнала — и человек узнаёт о нём от банка, а
 * не от Multa. Поэтому «пятая неделя» хранится как «последняя» (nth = -1), а несуществующий день
 * года прижимается к концу месяца — тем же клампом, что и `monthlyDatesBetween`.
 *
 * Вся арифметика в UTC: даты — строки 'YYYY-MM-DD', лексикографический порядок совпадает с
 * хронологическим.
 */

/** 0 — воскресенье, 6 — суббота: та же нумерация, что у `Date.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Порядковый номер дня недели в месяце. -1 — последний; «пятого» как правила не существует. */
export type NthWeekday = 1 | 2 | 3 | 4 | -1;

const iso = (year: number, month1to12: number, day: number): string =>
  `${year}-${String(month1to12).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const daysInMonth = (year: number, month1to12: number): number =>
  new Date(Date.UTC(year, month1to12, 0)).getUTCDate();

const weekdayOf = (year: number, month1to12: number, day: number): number =>
  new Date(Date.UTC(year, month1to12 - 1, day)).getUTCDay();

/** Перебирает месяцы окна включительно по краям. */
function* monthsBetween(fromIso: string, toIso: string): Generator<[number, number]> {
  let year = Number(fromIso.slice(0, 4));
  let month = Number(fromIso.slice(5, 7));
  const lastYear = Number(toIso.slice(0, 4));
  const lastMonth = Number(toIso.slice(5, 7));
  while (year * 12 + month <= lastYear * 12 + lastMonth) {
    yield [year, month];
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/**
 * Дата N-го дня недели в месяце. `nth = -1` — последнее вхождение. Возвращает null, если такого
 * вхождения в месяце нет (например, пятая пятница) — вызывающий обязан это заметить, а не
 * подставить соседнюю дату.
 */
export function nthWeekdayOfMonth(
  year: number,
  month1to12: number,
  nth: number,
  weekday: number,
): string | null {
  const dim = daysInMonth(year, month1to12);
  const firstWeekday = weekdayOf(year, month1to12, 1);
  // Первое вхождение нужного дня недели: сдвиг от первого числа по кругу недели.
  const firstHit = 1 + ((weekday - firstWeekday + 7) % 7);
  if (nth === -1) {
    const last = firstHit + Math.floor((dim - firstHit) / 7) * 7;
    return iso(year, month1to12, last);
  }
  const day = firstHit + (nth - 1) * 7;
  return day >= 1 && day <= dim ? iso(year, month1to12, day) : null;
}

/** Даты «N-го <дня недели> месяца» внутри окна [fromIso, toIso]. Отсортированы. */
export function nthWeekdayDatesBetween(
  nth: number,
  weekday: number,
  fromIso: string,
  toIso: string,
): string[] {
  const out: string[] = [];
  for (const [year, month] of monthsBetween(fromIso, toIso)) {
    const date = nthWeekdayOfMonth(year, month, nth, weekday);
    if (date && date >= fromIso && date <= toIso) out.push(date);
  }
  return out;
}

/**
 * Даты «каждый год, месяц/день» внутри окна. Несуществующий день (29 февраля в невисокосный год)
 * прижимается к концу месяца: страховка, оплаченная 29-го, обязана напомнить о себе и в обычный
 * год.
 */
export function yearlyDatesBetween(
  month1to12: number,
  day: number,
  fromIso: string,
  toIso: string,
): string[] {
  const out: string[] = [];
  const firstYear = Number(fromIso.slice(0, 4));
  const lastYear = Number(toIso.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year += 1) {
    const date = iso(year, month1to12, Math.min(day, daysInMonth(year, month1to12)));
    if (date >= fromIso && date <= toIso) out.push(date);
  }
  return out;
}

/** Правило повтора в том виде, в каком его хранит платёж (совместимо с `RecurringSchedule`). */
export type RepeatRule =
  | { readonly kind: 'monthly-days'; readonly days: readonly number[] }
  | { readonly kind: 'every-weeks'; readonly weeks: number; readonly startsOn: string }
  | { readonly kind: 'monthly-nth-weekday'; readonly nth: NthWeekday; readonly weekday: Weekday }
  | { readonly kind: 'yearly'; readonly month: number; readonly day: number }
  | { readonly kind: 'each-payout' };

/**
 * Варианты повтора, выведенные из выбранной первой даты — как это делают календари: выбрал
 * «14 июля», получил «14-го числа», «каждый вторник», «каждый второй вторник».
 *
 * Считает ядро, а не интерфейс: определить, что 14 июля 2026 — это «второй вторник», значит
 * сделать календарную арифметику (правило 4). Веб только подписывает варианты через i18n.
 */
export function repeatRuleCandidates(anchorIso: string): RepeatRule[] {
  const year = Number(anchorIso.slice(0, 4));
  const month = Number(anchorIso.slice(5, 7));
  const day = Number(anchorIso.slice(8, 10));
  const weekday = weekdayOf(year, month, day) as Weekday;

  /*
   * Номер вхождения дня недели в месяце. Пятое вхождение предлагаем как «последнее»: правила
   * «пятый вторник» не существует, и хранить 5 значило бы завести правило, которое в половине
   * месяцев молчит. Четвёртое вхождение, если оно же последнее, тоже честнее назвать «последним».
   */
  const nthRaw = Math.ceil(day / 7);
  const isLast = nthWeekdayOfMonth(year, month, -1, weekday) === anchorIso;
  const nth: NthWeekday = isLast || nthRaw >= 5 ? -1 : (nthRaw as NthWeekday);

  return [
    { kind: 'monthly-days', days: [day] },
    { kind: 'monthly-nth-weekday', nth, weekday },
    { kind: 'every-weeks', weeks: 1, startsOn: anchorIso },
    { kind: 'every-weeks', weeks: 2, startsOn: anchorIso },
    { kind: 'yearly', month, day },
    { kind: 'each-payout' },
  ];
}
