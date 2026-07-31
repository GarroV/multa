/**
 * Каскад распределения выплаты. Чистая функция.
 *
 * Раздача (приоритет): debts → buckets → envelopes → categories → goals.
 * При нехватке денег каскад сжимается сверху вниз: **цели → конверты → категории**
 * (решение основателя; 01-domain-model §Исполнение). Порядок сжатия — настройка воркспейса
 * (issue #49), но набор режущихся уровней — нет: долги и валютные корзины автоматика не трогает
 * ни при какой настройке. Внутри уровня категорий защищённые не режутся.
 *
 * Неприкосновенны для автоматики (инварианты 3, 4): долги, валютные корзины,
 * защищённые категории. Если дефицит не покрывается режущимся, обязательства
 * остаются полными, а freeMinor уходит в минус (честно показываем нехватку).
 *
 * Все суммы — base-валюта, integer minor units (bigint).
 */

export type TargetKind = 'debt' | 'bucket' | 'envelope' | 'category' | 'goal';

export interface PlanItem {
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly plannedMinor: bigint;
  /** Только для категорий: защищённая не режется автоматически (пример: «Ребёнок»). */
  readonly protected?: boolean;
}

export interface Allocation {
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly plannedMinor: bigint;
  readonly allocatedMinor: bigint;
  readonly shortfallMinor: bigint; // plannedMinor - allocatedMinor, >= 0
}

export interface CascadeResult {
  readonly incomeMinor: bigint;
  readonly allocations: Allocation[]; // в порядке входного плана
  readonly totalPlannedMinor: bigint;
  readonly totalAllocatedMinor: bigint;
  readonly compressedMinor: bigint; // сколько срезано всего (>= 0)
  readonly freeMinor: bigint; // income - totalAllocated (может быть < 0 при нехватке на обязательства)
}

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/**
 * Пропорционально распределяет `total` по весам (метод наибольшего остатка).
 * Возвращает целые доли, сумма которых точно равна `total`; доля ≤ соответствующего веса.
 */
function distributeProportional(total: bigint, weights: bigint[]): bigint[] {
  const wsum = sum(weights);
  if (wsum <= 0n || total <= 0n) return weights.map(() => 0n);
  const base = weights.map((w) => (total * w) / wsum);
  let remainder = total - sum(base);
  const fracs = weights.map((w) => (total * w) % wsum);
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => {
      const fa = fracs[a] ?? 0n;
      const fb = fracs[b] ?? 0n;
      if (fb > fa) return 1;
      if (fb < fa) return -1;
      return a - b;
    });
  for (let k = 0; k < order.length && remainder > 0n; k++) {
    const idx = order[k]!;
    base[idx] = (base[idx] ?? 0n) + 1n;
    remainder -= 1n;
  }
  return base;
}

/**
 * Уровни, которые автоматика вправе резать. Долгов и валютных корзин здесь нет и быть не может —
 * это железный инвариант (правило 3), а не настройка: платёж по кредиту и деньги на аренду
 * нельзя «немного подрезать», потому что счёт придёт целиком.
 */
export type CompressibleKind = 'goal' | 'envelope' | 'category';

const COMPRESSIBLE: readonly CompressibleKind[] = ['goal', 'envelope', 'category'];
/** Порядок по умолчанию — решение основателя: первыми уступают цели, категории последними. */
const DEFAULT_COMPRESS_ORDER: readonly CompressibleKind[] = ['goal', 'envelope', 'category'];

export interface CascadeOptions {
  /**
   * Чем жертвовать раньше при нехватке (настройка воркспейса, issue #49). Неизвестные и
   * неприкосновенные виды отбрасываются, пропущенные уровни дописываются в конец по умолчанию —
   * иначе кривая настройка молча оставила бы часть плана нережущейся и увела бы остаток в минус.
   */
  readonly compressOrder?: readonly CompressibleKind[];
}

/** Нормализует запрошенный порядок: только режущиеся уровни, без повторов, ничего не потеряно. */
function normalizeOrder(requested?: readonly CompressibleKind[]): CompressibleKind[] {
  const clean = (requested ?? []).filter((kind): kind is CompressibleKind =>
    COMPRESSIBLE.includes(kind),
  );
  const unique = [...new Set(clean)];
  for (const kind of DEFAULT_COMPRESS_ORDER) if (!unique.includes(kind)) unique.push(kind);
  return unique;
}

/** Индексы позиций плана, режущихся автоматически, в порядке сжатия. */
function compressionTiers(plan: PlanItem[], order: CompressibleKind[]): number[][] {
  const idxOf = (pred: (p: PlanItem) => boolean): number[] =>
    plan.map((p, i) => (pred(p) ? i : -1)).filter((i) => i >= 0);
  return order.map((kind) =>
    // Защищённая категория не режется автоматически — только явным выбором человека.
    idxOf((p) => p.targetKind === kind && !(kind === 'category' && p.protected)),
  );
}

export function cascade(
  incomeMinor: bigint,
  plan: PlanItem[],
  opts: CascadeOptions = {},
): CascadeResult {
  const allocated = plan.map((p) => p.plannedMinor);
  const totalPlanned = sum(allocated);

  let deficit = totalPlanned - incomeMinor;
  if (deficit > 0n) {
    for (const tier of compressionTiers(plan, normalizeOrder(opts.compressOrder))) {
      if (deficit <= 0n) break;
      if (tier.length === 0) continue;
      const weights = tier.map((i) => allocated[i]!);
      const tierTotal = sum(weights);
      if (tierTotal <= 0n) continue;
      const cut = deficit < tierTotal ? deficit : tierTotal;
      const cuts = distributeProportional(cut, weights);
      tier.forEach((i, j) => {
        allocated[i] = allocated[i]! - (cuts[j] ?? 0n);
      });
      deficit -= cut;
    }
  }

  const totalAllocated = sum(allocated);
  const allocations: Allocation[] = plan.map((p, i) => {
    const a = allocated[i]!;
    return {
      targetKind: p.targetKind,
      targetId: p.targetId,
      plannedMinor: p.plannedMinor,
      allocatedMinor: a,
      shortfallMinor: p.plannedMinor - a,
    };
  });

  return {
    incomeMinor,
    allocations,
    totalPlannedMinor: totalPlanned,
    totalAllocatedMinor: totalAllocated,
    compressedMinor: totalPlanned - totalAllocated,
    freeMinor: incomeMinor - totalAllocated,
  };
}
