/**
 * Обучение плана на факте (07-roadmap Спринт 4, 01-domain-model §Сигналы):
 * «ты 3 периода подряд тратишь на еду 24k при плане 20k — поднять?».
 *
 * Три правила, чтобы совет не превратился в шум:
 * 1. Меньше трёх периодов — молчим: два случая это совпадение, а не привычка.
 * 2. Отклонение до 10% от плана — молчим: бюджет не переписывают из-за шума.
 * 3. Разнонаправленный разброс (и сильно выше, и сильно ниже) — молчим: привычки не видно,
 *    а угадывать система не должна.
 *
 * Советуем медиану, а не среднее: один месяц с ремонтом не должен задирать бюджет на год.
 */

const MIN_PERIODS = 3;
/** Порог значимости отклонения от плана, в процентах. */
const NOISE_PCT = 10n;

export interface BudgetAdviceInput {
  readonly plannedMinor: bigint;
  /** Факт по категории за прошлые периоды, свежие первыми или последними — порядок не важен. */
  readonly history: readonly bigint[];
}

export interface BudgetAdvice {
  readonly kind: 'raise' | 'lower';
  readonly suggestedMinor: bigint;
  /** Сколько периодов легло в основу совета. */
  readonly periods: number;
}

function median(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

export function budgetAdvice(input: BudgetAdviceInput): BudgetAdvice | null {
  const { plannedMinor, history } = input;
  if (history.length < MIN_PERIODS) return null;

  const suggestedMinor = median(history);
  const threshold = plannedMinor > 0n ? (plannedMinor * NOISE_PCT) / 100n : 0n;
  const diff = suggestedMinor - plannedMinor;
  if (diff > 0n && diff <= threshold) return null;
  if (diff < 0n && -diff <= threshold) return null;
  if (diff === 0n) return null;

  // Разнонаправленный разброс: часть периодов заметно выше плана, часть заметно ниже.
  const above = history.filter((v) => v - plannedMinor > threshold).length;
  const below = history.filter((v) => plannedMinor - v > threshold).length;
  if (above > 0 && below > 0) return null;

  return { kind: diff > 0n ? 'raise' : 'lower', suggestedMinor, periods: history.length };
}
