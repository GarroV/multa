/**
 * Листание периодов в истории трат (issue #137).
 *
 * Отсчёт идёт от периода ВЫПЛАТ, а не от календарного месяца: продукт живёт от выплаты до выплаты, и
 * «прошлый месяц» здесь означал бы не то, что человек видит на «Плане».
 *
 * Смещение считается по длине самого периода, а не «минус месяц»: длина у периодов разная (10→25 это
 * 15 дней, 25→10 — 16), и календарный шаг разъехался бы с ритмом уже на второй итерации. Точные
 * границы прошлых периодов знает сервер (`generatePeriods` в ядре); здесь нужен ровно отрезок для
 * запроса истории, и приблизительность по длине текущего периода для него честнее, чем выдуманный
 * календарь.
 */

export interface PeriodRange {
  readonly startsOn: string;
  readonly endsOn: string;
}

const DAY_MS = 86_400_000;

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Границы периода как есть: интервал полуоткрытый, [начало, конец). */
export function periodBounds(period: PeriodRange): PeriodRange {
  return { startsOn: period.startsOn, endsOn: period.endsOn };
}

/** Сдвигает отрезок на `steps` его собственных длин: -1 — предыдущий, +1 — следующий. */
export function shiftPeriod(period: PeriodRange, steps: number): PeriodRange {
  if (steps === 0) return periodBounds(period);
  const from = toUtc(period.startsOn);
  const to = toUtc(period.endsOn);
  const length = to - from;
  return {
    startsOn: toIso(from + length * steps),
    endsOn: toIso(to + length * steps),
  };
}
