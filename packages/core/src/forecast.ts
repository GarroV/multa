/**
 * Прогноз-таймлайн (01-domain-model §Прогноз, 07-roadmap Спринт 4): лента событий вперёд —
 * «Озон закрывается в марте», «к октябрю на цель не хватит».
 *
 * Ценность в предупреждении за месяцы, а не в точности до копейки: считаем по текущим
 * платежам и взносам, без индексаций и процентов. Поэтому «нечем платить» и «взнос нулевой»
 * не превращаются в молчание — это событие риска, иначе цель тихо не наступит никогда.
 */

import { addDays, daysBetween } from './periods.ts';

export interface ForecastDebt {
  readonly id: string;
  readonly name: string;
  /**
   * Валюта строки. Конвертировать прогноз нечем и незачем: курса на будущую дату не существует, а
   * выдуманный ради красивой цифры — то же враньё, только незаметнее. Событие несёт свою валюту,
   * интерфейс её и показывает (#99).
   */
  readonly currency: string;
  readonly remainingMinor: bigint;
  /** Платёж за период (0 — платежа нет, долг не закроется). */
  readonly paymentMinor: bigint;
  /**
   * Платёж по периодам, если он меняется во времени (#103). Индекс — смещение от текущего периода;
   * чего нет в списке, берётся из `paymentMinor`.
   *
   * Ступени человек заводит из интерфейса («с ноября плачу по 5 000»), и весь остальной код ходит
   * через `amountOn`. Прогноз, считающий по сегодняшнему платежу, отвечает на «когда я вылезу»
   * цифрой, которой не будет.
   */
  readonly paymentsByPeriod?: readonly bigint[];
}

/** Разовое списание на горизонте: регулярный платёж, попавший в будущий период. */
export interface ForecastRecurring {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly on: string;
  readonly amountMinor: bigint;
}

export interface ForecastGoal {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly targetMinor: bigint;
  readonly savedMinor: bigint;
  /** Взнос за период (0 — цель не наступит). */
  readonly perPeriodMinor: bigint;
}

export type ForecastKind =
  'debt_closed' | 'freed_money' | 'goal_reached' | 'goal_at_risk' | 'recurring_due';

export interface ForecastEvent {
  readonly kind: ForecastKind;
  readonly targetId: string;
  readonly name: string;
  /** Валюта суммы события — та же, что у строки, из которой оно выросло. */
  readonly currency: string;
  /** Дата события; для риска — конец горизонта, к которому цель так и не собралась. */
  readonly on: string;
  readonly periodsAway: number;
  /** Сумма события: платёж, который освободится, или недостающая часть цели. */
  readonly amountMinor?: bigint;
}

export interface ForecastInput {
  readonly asOf: string;
  /** Горизонт в периодах выплат. */
  readonly periodsAhead: number;
  /** Средняя длина периода в днях — для перевода «через N периодов» в дату. */
  readonly periodLengthDays: number;
  readonly debts: readonly ForecastDebt[];
  readonly goals: readonly ForecastGoal[];
  /**
   * Списания регулярных платежей на горизонте. Раньше лента знала только текущий период и потому
   * дублировала карту периода вместо ответа «что ждёт впереди» (#103).
   */
  readonly recurring?: readonly ForecastRecurring[];
}

/** Сколько периодов нужно, чтобы выбрать сумму взносами (округление вверх). */
const periodsToCover = (amount: bigint, perPeriod: bigint): number | null => {
  if (perPeriod <= 0n) return null;
  const whole = amount / perPeriod;
  return Number(amount % perPeriod === 0n ? whole : whole + 1n);
};

/**
 * За сколько периодов закроется долг с учётом меняющегося платежа.
 *
 * Идём по периодам, а не делим нацело: при ступенях деления нет — платёж в каждом периоде свой.
 * `null` — не закроется в пределах горизонта (в том числе при нулевом платеже).
 */
function periodsToClose(debt: ForecastDebt, periodsAhead: number): number | null {
  if (!debt.paymentsByPeriod?.length) {
    const periods = periodsToCover(debt.remainingMinor, debt.paymentMinor);
    return periods === null || periods > periodsAhead ? null : periods;
  }
  let left = debt.remainingMinor;
  for (let i = 0; i < periodsAhead; i++) {
    const payment = debt.paymentsByPeriod[i] ?? debt.paymentMinor;
    if (payment <= 0n) continue;
    left -= payment;
    if (left <= 0n) return i + 1;
  }
  return null;
}

export function forecastTimeline(input: ForecastInput): ForecastEvent[] {
  const { asOf, periodsAhead, periodLengthDays } = input;
  const dateOf = (periods: number) => addDays(asOf, periods * periodLengthDays);
  const events: ForecastEvent[] = [];

  for (const debt of input.debts) {
    if (debt.remainingMinor <= 0n) continue;
    const periods = periodsToClose(debt, periodsAhead);
    if (periods === null) continue;
    const on = dateOf(periods);
    events.push({
      kind: 'debt_closed',
      targetId: debt.id,
      name: debt.name,
      currency: debt.currency,
      on,
      periodsAway: periods,
    });
    // Закрытый долг освобождает платёж — 01-domain-model предлагает переложить его в конверт/цель.
    events.push({
      kind: 'freed_money',
      targetId: debt.id,
      name: debt.name,
      currency: debt.currency,
      on,
      periodsAway: periods,
      amountMinor: debt.paymentMinor,
    });
  }

  for (const goal of input.goals) {
    const left = goal.targetMinor - goal.savedMinor;
    if (left <= 0n) continue;
    const periods = periodsToCover(left, goal.perPeriodMinor);
    if (periods === null || periods > periodsAhead) {
      events.push({
        kind: 'goal_at_risk',
        targetId: goal.id,
        name: goal.name,
        currency: goal.currency,
        on: dateOf(periodsAhead),
        periodsAway: periodsAhead,
        amountMinor: left,
      });
      continue;
    }
    events.push({
      kind: 'goal_reached',
      targetId: goal.id,
      name: goal.name,
      currency: goal.currency,
      on: dateOf(periods),
      periodsAway: periods,
    });
  }

  // Горизонт один на всю ленту: событие за его пределами обещало бы точность, которой нет.
  const horizonEnd = dateOf(periodsAhead);
  for (const item of input.recurring ?? []) {
    if (item.on < asOf || item.on > horizonEnd) continue;
    events.push({
      kind: 'recurring_due',
      targetId: item.id,
      name: item.name,
      currency: item.currency,
      on: item.on,
      periodsAway: Math.max(0, Math.round(daysBetween(asOf, item.on) / periodLengthDays)),
      amountMinor: item.amountMinor,
    });
  }

  return events.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
}
