import type { ExchangeOp, PlanDto } from './queries.ts';

/**
 * Агрегаты «Статистики» (issue #30). Экран отвечает на четыре вопроса: сколько денег связано
 * обязательствами, насколько план расходится с фактом, в каких валютах живут обязательства и
 * сколько уходит менялам. Всё считается из уже полученных DTO — новых ручек это не требует, а
 * доменных решений здесь нет: это арифметика отображения.
 */

export interface LockedSplit {
  /** Обязательное: долги, корзины, конверты, цели — то, что каскад не режет по желанию. */
  lockedMinor: bigint;
  /** Гибкое: категории — единственная часть, которой человек управляет на ходу. */
  flexibleMinor: bigint;
  lockedPct: number;
}

export function lockedSplit(plan: PlanDto): LockedSplit {
  let locked = 0n;
  let flexible = 0n;
  for (const a of plan.allocations) {
    const minor = BigInt(a.allocatedMinor);
    if (a.targetKind === 'category') flexible += minor;
    else locked += minor;
  }
  const total = locked + flexible;
  const lockedPct = total > 0n ? Number((locked * 1_000_000n) / total) / 10_000 : 0;
  return { lockedMinor: locked, flexibleMinor: flexible, lockedPct };
}

export interface CurrencyShare {
  currency: string;
  minor: bigint;
  pct: number;
}

/**
 * Валютный состав обязательств. Это мера валютного риска: если 60% выплаты уходит в EUR, курс
 * бьёт по бюджету напрямую — поэтому доли считаются по исходной валюте обязательства.
 */
export function currencyMix(plan: PlanDto): CurrencyShare[] {
  const sums = new Map<string, bigint>();
  for (const a of plan.allocations) {
    const minor = BigInt(a.allocatedMinor);
    if (minor <= 0n) continue;
    sums.set(a.sourceCurrency, (sums.get(a.sourceCurrency) ?? 0n) + minor);
  }
  const total = [...sums.values()].reduce((s, v) => s + v, 0n);
  if (total === 0n) return [];

  return [...sums.entries()]
    .map(([currency, minor]) => ({
      currency,
      minor,
      pct: Number((minor * 1_000_000n) / total) / 10_000,
    }))
    .sort((a, b) => (b.minor > a.minor ? 1 : b.minor < a.minor ? -1 : 0));
}

export interface PlanVsFact {
  plannedMinor: bigint;
  spentMinor: bigint;
  /** Отклонение факта от плана, проценты: плюс — перерасход, минус — экономия, null — плана нет. */
  deltaPct: number | null;
}

/**
 * План против факта — только по категориям. Долг «не оплачен» ещё не значит «сэкономлено»:
 * счёт придёт, и включать его в отклонение значило бы врать в свою пользу.
 */
export function planVsFact(plan: PlanDto): PlanVsFact {
  let planned = 0n;
  let spent = 0n;
  for (const a of plan.allocations) {
    if (a.targetKind !== 'category') continue;
    planned += BigInt(a.allocatedMinor);
    spent += BigInt(a.spentMinor);
  }
  const deltaPct =
    planned > 0n ? Number(((spent - planned) * 1_000_000n) / planned) / 10_000 : null;
  return { plannedMinor: planned, spentMinor: spent, deltaPct };
}

export interface SpreadAverage {
  pct: number;
  count: number;
}

/**
 * Средний спред по разменам. Операции без официального курса пропускаются: у них спред неизвестен,
 * а подставить ноль означало бы приукрасить картину.
 */
export function spreadAverage(ops: readonly ExchangeOp[]): SpreadAverage | null {
  const known = ops.map((o) => o.spreadPct).filter((v): v is string => v !== null);
  if (known.length === 0) return null;
  const sum = known.reduce((s, v) => s + Number(v), 0);
  return { pct: sum / known.length, count: known.length };
}
