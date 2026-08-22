/**
 * Сборка плана периода поверх каскада. Чистые функции (без БД/FX — те живут в apps/api).
 *
 * Задача модуля — превратить набор обязательств (уже приведённых к base-валюте) в
 * упорядоченный вход каскада и посчитать производные ага-момента (04-web-ux §Дашборд):
 * «жить на X/день, к концу периода свободно Z».
 *
 * «К размену» здесь НЕ считается (issue #152): для него нужна валюта каждой строки, а сюда
 * приходят суммы, уже приведённые к base. Правило живёт в `exchangeNeed()` и вызывается там, где
 * валюты известны — в сборке плана (apps/api) и в мастер-сетке (grid.ts).
 *
 * Приоритет раздачи (01-domain-model §Каскад): debts → buckets → envelopes → categories → goals.
 * Сжатие при нехватке — забота cascade() (goals → envelopes → незащищённые categories).
 */

import {
  cascade,
  type Allocation,
  type CascadeResult,
  type CompressibleKind,
  type PlanItem,
  type TargetKind,
} from './cascade.ts';

/** Порядок отображения строк плана = порядок раздачи каскада. */
export const PLAN_PRIORITY: readonly TargetKind[] = [
  'debt',
  'bucket',
  'envelope',
  'category',
  'goal',
];

const priorityIndex = (kind: TargetKind): number => {
  const i = PLAN_PRIORITY.indexOf(kind);
  return i === -1 ? PLAN_PRIORITY.length : i;
};

/**
 * Стабильная сортировка строк плана по приоритету каскада (внутри уровня — исходный порядок).
 * Не мутирует вход.
 */
export function orderPlanItems<T extends { readonly targetKind: TargetKind }>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        priorityIndex(a.item.targetKind) - priorityIndex(b.item.targetKind) || a.index - b.index,
    )
    .map(({ item }) => item);
}

export interface PlanSummary {
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
export function summarizePlan(
  result: CascadeResult,
  opts: { readonly daysInPeriod: number },
): PlanSummary {
  const categoryMinor = sumBy(result.allocations, 'category');
  const livingRaw = categoryMinor + result.freeMinor;
  const livingMinor = livingRaw > 0n ? livingRaw : 0n;
  const days = opts.daysInPeriod;
  const canSpendPerDayMinor = days > 0 ? livingMinor / BigInt(days) : 0n;
  return { freeMinor: result.freeMinor, livingMinor, canSpendPerDayMinor };
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
  /**
   * Сколько отложено «на всякий случай» и не вошло в дневной темп (issue #49). Остаток при этом не
   * уменьшается: буфер про осторожность темпа, а не про исчезновение денег.
   */
  readonly bufferMinor: bigint;
}

/** Максимальный буфер: половина остатка — уже не осторожность, а вторая заначка. */
const MAX_BUFFER_PCT = 50;

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
  opts: {
    readonly spentLivingMinor: bigint;
    readonly daysLeft: number;
    /**
     * Доля остатка, которую не включаем в дневной темп (настройка воркспейса, issue #49). Нужна
     * тем, кто предпочитает дойти до выплаты с запасом, а не ровно в ноль.
     */
    readonly bufferPct?: number;
  },
): PlanFact {
  const bufferPct = opts.bufferPct ?? 0;
  if (!Number.isInteger(bufferPct) || bufferPct < 0 || bufferPct > MAX_BUFFER_PCT) {
    throw new Error('buffer_pct_out_of_range');
  }
  const remainingLivingMinor = summary.livingMinor - opts.spentLivingMinor;
  const spendable = remainingLivingMinor > 0n ? remainingLivingMinor : 0n;
  // Буфер считается от остатка, а не от плана: в середине периода «10% плана» уже не запас.
  const bufferMinor = (spendable * BigInt(bufferPct)) / 100n;
  const pace = spendable - bufferMinor;
  return {
    spentLivingMinor: opts.spentLivingMinor,
    remainingLivingMinor,
    overspentMinor: remainingLivingMinor < 0n ? -remainingLivingMinor : 0n,
    canSpendPerDayMinor: opts.daysLeft > 0 ? pace / BigInt(opts.daysLeft) : 0n,
    bufferMinor,
  };
}

/** Статусы исполнения плановой строки (01-domain-model §Исполнение). */
export type ExecutionStatus = 'pending' | 'confirmed' | 'partial' | 'skipped' | 'n_a';

export interface Execution {
  readonly status: ExecutionStatus;
  /** Сколько ещё не внесено по этой строке (0, если исполнено или исполнять нечего). */
  readonly remainderMinor: bigint;
}

/**
 * Статус строки по фактически внесённой сумме.
 *
 * `skipped` здесь не возвращается: пропуск — осознанное действие пользователя, а не вывод из
 * суммы (ноль означает «ещё не сделал», и пропуск не должен путаться с забывчивостью).
 * Переплата не делает остаток отрицательным: строка просто исполнена.
 */
export function executionOf(plannedMinor: bigint, executedMinor: bigint): Execution {
  if (plannedMinor <= 0n) return { status: 'n_a', remainderMinor: 0n };
  if (executedMinor <= 0n) return { status: 'pending', remainderMinor: plannedMinor };
  if (executedMinor >= plannedMinor) return { status: 'confirmed', remainderMinor: 0n };
  return { status: 'partial', remainderMinor: plannedMinor - executedMinor };
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
  opts: {
    readonly daysInPeriod: number;
    /** Порядок сжатия из настроек воркспейса (issue #49); инвариант «долги целы» ядро держит само. */
    readonly compressOrder?: readonly CompressibleKind[];
  },
): AssembledPlan {
  const ordered = orderPlanItems(plan);
  const result = cascade(incomeMinor, ordered, {
    ...(opts.compressOrder ? { compressOrder: opts.compressOrder } : {}),
  });
  return { result, summary: summarizePlan(result, opts) };
}
