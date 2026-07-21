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
