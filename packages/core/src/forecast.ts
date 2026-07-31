/**
 * Прогноз-таймлайн (01-domain-model §Прогноз, 07-roadmap Спринт 4): лента событий вперёд —
 * «Озон закрывается в марте», «к октябрю на цель не хватит».
 *
 * Ценность в предупреждении за месяцы, а не в точности до копейки: считаем по текущим
 * платежам и взносам, без индексаций и процентов. Поэтому «нечем платить» и «взнос нулевой»
 * не превращаются в молчание — это событие риска, иначе цель тихо не наступит никогда.
 */

import { addDays } from './periods.ts';

export interface ForecastDebt {
  readonly id: string;
  readonly name: string;
  readonly remainingMinor: bigint;
  /** Платёж за период (0 — платежа нет, долг не закроется). */
  readonly paymentMinor: bigint;
}

export interface ForecastGoal {
  readonly id: string;
  readonly name: string;
  readonly targetMinor: bigint;
  readonly savedMinor: bigint;
  /** Взнос за период (0 — цель не наступит). */
  readonly perPeriodMinor: bigint;
}

export type ForecastKind = 'debt_closed' | 'freed_money' | 'goal_reached' | 'goal_at_risk';

export interface ForecastEvent {
  readonly kind: ForecastKind;
  readonly targetId: string;
  readonly name: string;
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
}

/** Сколько периодов нужно, чтобы выбрать сумму взносами (округление вверх). */
const periodsToCover = (amount: bigint, perPeriod: bigint): number | null => {
  if (perPeriod <= 0n) return null;
  const whole = amount / perPeriod;
  return Number(amount % perPeriod === 0n ? whole : whole + 1n);
};

export function forecastTimeline(input: ForecastInput): ForecastEvent[] {
  const { asOf, periodsAhead, periodLengthDays } = input;
  const dateOf = (periods: number) => addDays(asOf, periods * periodLengthDays);
  const events: ForecastEvent[] = [];

  for (const debt of input.debts) {
    if (debt.remainingMinor <= 0n) continue;
    const periods = periodsToCover(debt.remainingMinor, debt.paymentMinor);
    if (periods === null || periods > periodsAhead) continue;
    const on = dateOf(periods);
    events.push({
      kind: 'debt_closed',
      targetId: debt.id,
      name: debt.name,
      on,
      periodsAway: periods,
    });
    // Закрытый долг освобождает платёж — 01-domain-model предлагает переложить его в конверт/цель.
    events.push({
      kind: 'freed_money',
      targetId: debt.id,
      name: debt.name,
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
      on: dateOf(periods),
      periodsAway: periods,
    });
  }

  return events.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
}
