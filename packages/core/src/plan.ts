/**
 * Сборка плана периода поверх каскада. Чистые функции (без БД/FX — те живут в apps/api).
 *
 * Задача модуля — превратить набор обязательств (уже приведённых к base-валюте) в
 * упорядоченный вход каскада и посчитать производные ага-момента (04-web-ux §Дашборд):
 * «жить на X/день, поменять Y, к концу периода свободно Z».
 *
 * Приоритет раздачи (01-domain-model §Каскад): debts → buckets → envelopes → categories → goals.
 * Сжатие при нехватке — забота cascade() (goals → envelopes → незащищённые categories).
 */

import { cascade, type Allocation, type CascadeResult, type PlanItem, type TargetKind } from './cascade.ts';

/** Порядок отображения строк плана = порядок раздачи каскада. */
export const PLAN_PRIORITY: readonly TargetKind[] = ['debt', 'bucket', 'envelope', 'category', 'goal'];

const priorityIndex = (kind: TargetKind): number => {
  const i = PLAN_PRIORITY.indexOf(kind);
  return i === -1 ? PLAN_PRIORITY.length : i;
};

/**
 * Стабильная сортировка строк плана по приоритету каскада (внутри уровня — исходный порядок).
 * Не мутирует вход.
 */
export function orderPlanItems<T extends { readonly targetKind: TargetKind }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => priorityIndex(a.item.targetKind) - priorityIndex(b.item.targetKind) || a.index - b.index)
    .map(({ item }) => item);
}

export interface PlanSummary {
  /** Сумма аллокаций валютных корзин — «К размену». */
  readonly toExchangeMinor: bigint;
  /** Свободный остаток после каскада (может быть < 0 при нехватке на обязательства). */
  readonly freeMinor: bigint;
  /** Деньги на повседневную жизнь = аллокации категорий + свободный остаток (>= 0). */
  readonly livingMinor: bigint;
  /** Герой-цифра: сколько можно тратить в день = livingMinor ÷ дней периода. */
  readonly canSpendPerDayMinor: bigint;
}

const sumBy = (allocations: readonly Allocation[], kind: TargetKind): bigint =>
  allocations.reduce((acc, a) => (a.targetKind === kind ? acc + a.allocatedMinor : acc), 0n);

/**
 * Производные ага-момента из результата каскада.
 * `daysInPeriod` — делитель цифры дня; при 0 цифра дня = 0 (защита от деления на ноль).
 */
export function summarizePlan(result: CascadeResult, opts: { readonly daysInPeriod: number }): PlanSummary {
  const toExchangeMinor = sumBy(result.allocations, 'bucket');
  const categoryMinor = sumBy(result.allocations, 'category');
  const livingRaw = categoryMinor + result.freeMinor;
  const livingMinor = livingRaw > 0n ? livingRaw : 0n;
  const days = opts.daysInPeriod;
  const canSpendPerDayMinor = days > 0 ? livingMinor / BigInt(days) : 0n;
  return { toExchangeMinor, freeMinor: result.freeMinor, livingMinor, canSpendPerDayMinor };
}

export interface PlanFact {
  /** Уже потрачено на жизнь в этом периоде (base). */
  readonly spentLivingMinor: bigint;
  /** Остаток на жизнь = план − факт. Отрицательный при перерасходе — показываем честно. */
  readonly remainingLivingMinor: bigint;
  /** Насколько вышли за план (0, если не вышли). Отдельным полем, чтобы UI не считал знаки. */
  readonly overspentMinor: bigint;
  /** Герой-цифра: остаток ÷ дней, которые ОСТАЛОСЬ жить до выплаты (04-web-ux §Дашборд). */
  readonly canSpendPerDayMinor: bigint;
}

/**
 * Накладывает факт периода на план: сколько осталось на жизнь и какой теперь дневной темп.
 *
 * Делитель — `daysLeft`, а не длина периода: цифра отвечает на вопрос «сколько можно тратить
 * до выплаты», поэтому в середине периода делим остаток на остаток дней. Делим вниз — чтобы
 * дневной темп нельзя было умножить на дни и получить больше, чем реально есть.
 * При перерасходе темп 0 (а не отрицательный): тон штурмана, минус живёт в `overspentMinor`.
 */
export function summarizeFact(
  summary: PlanSummary,
  opts: { readonly spentLivingMinor: bigint; readonly daysLeft: number },
): PlanFact {
  const remainingLivingMinor = summary.livingMinor - opts.spentLivingMinor;
  const spendable = remainingLivingMinor > 0n ? remainingLivingMinor : 0n;
  return {
    spentLivingMinor: opts.spentLivingMinor,
    remainingLivingMinor,
    overspentMinor: remainingLivingMinor < 0n ? -remainingLivingMinor : 0n,
    canSpendPerDayMinor: opts.daysLeft > 0 ? spendable / BigInt(opts.daysLeft) : 0n,
  };
}

export interface CategorySpending {
  readonly spentMinor: bigint;
  readonly remainingMinor: bigint;
  readonly overspentMinor: bigint;
}

/** План/факт одной категории. Бюджет 0 («без бюджета») → любая трата уходит в перерасход. */
export function categorySpending(budgetMinor: bigint, spentMinor: bigint): CategorySpending {
  const remainingMinor = budgetMinor - spentMinor;
  return {
    spentMinor,
    remainingMinor,
    overspentMinor: remainingMinor < 0n ? -remainingMinor : 0n,
  };
}

export interface AssembledPlan {
  readonly result: CascadeResult;
  readonly summary: PlanSummary;
}

/**
 * Полная сборка: упорядочивает строки, гоняет каскад, считает сводку.
 * `plan` — строки уже в base-валюте (конвертация — в apps/api до вызова).
 */
export function assemblePlan(
  incomeMinor: bigint,
  plan: readonly PlanItem[],
  opts: { readonly daysInPeriod: number },
): AssembledPlan {
  const ordered = orderPlanItems(plan);
  const result = cascade(incomeMinor, ordered);
  return { result, summary: summarizePlan(result, opts) };
}
