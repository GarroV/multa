/**
 * Обучение плана на факте (07-roadmap Спринт 4, 01-domain-model §Сигналы):
 * «ты 3 периода подряд тратишь на еду 24k при плане 20k — поднять?».
 *
 * Три правила, чтобы совет не превратился в шум:
 * 1. Меньше трёх периодов — молчим: два случая это совпадение, а не привычка.
 * 2. Отклонение до 10% от плана — молчим: бюджет не переписывают из-за шума.
 * 3. Разнонаправленный разброс (и сильно выше медианы, и сильно ниже) — молчим: привычки не
 *    видно, а угадывать система не должна. Разброс меряется от медианы самого ряда, а не от
 *    плана: иначе совет противоречит сам себе (issue #82).
 *
 * Советуем медиану, а не среднее: один месяц с ремонтом не должен задирать бюджет на год.
 */

const MIN_PERIODS = 3;
/** Порог значимости отклонения от плана, в процентах. */
const NOISE_PCT = 10n;
/**
 * Насколько точка должна отойти от медианы ряда, чтобы считаться выбросом, в процентах.
 *
 * Порог крупный намеренно: обычная категория гуляет на десятки процентов и остаётся привычкой.
 * «Нестабильно» — это не «неровно», а «в одной статье лежат разные по смыслу траты»: месяц с
 * 12 000 и месяц с 1 500 не усредняются в план, их надо разделять.
 */
const VOLATILE_PCT = 35n;

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

/**
 * Ряд разнонаправленно скачет: есть точки заметно выше медианы И заметно ниже неё.
 *
 * Меряем от медианы **самого ряда**, а не от плана (issue #82). Раньше мерили от плана, и получался
 * совет, противоречащий сам себе: при заниженном плане все точки лежали выше него, разброса «не
 * было», система советовала поднять план — а после поднятия те же данные внезапно объявлялись
 * нестабильными. Разброс — свойство фактов, и от того, что человек написал в плане, он не меняется.
 */
function isVolatile(history: readonly bigint[]): boolean {
  if (history.length < MIN_PERIODS) return false;
  const center = median(history);
  if (center <= 0n) return false;
  const threshold = (center * VOLATILE_PCT) / 100n;
  const above = history.filter((v) => v - center > threshold).length;
  const below = history.filter((v) => center - v > threshold).length;
  return above > 0 && below > 0;
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

  // Разнонаправленный разброс: медиана такого ряда — не бюджет, а среднее по больнице.
  if (isVolatile(history)) return null;

  return { kind: diff > 0n ? 'raise' : 'lower', suggestedMinor, periods: history.length };
}

/**
 * Вердикт по категории для аналитики (issue #51). Совет (`budgetAdvice`) отвечает «менять ли план»,
 * вердикт — «что вообще происходит со статьёй», и у него есть состояние, которого у совета нет:
 * **нестабильно**. Статью с разбросом в обе стороны бессмысленно «поднимать» — её надо разбирать
 * (в ней прячутся разные по смыслу траты), поэтому она обязана называться своим словом.
 */
export type CategoryVerdictKind =
  'unknown' | 'stable' | 'raise' | 'lower' | 'volatile' | 'unplanned';

export interface CategoryVerdict {
  readonly kind: CategoryVerdictKind;
  /** Медиана факта: один месяц с ремонтом не должен задирать бюджет на год. */
  readonly medianMinor: bigint;
  /** Отклонение медианы от плана в процентах; null — плана нет, сравнивать не с чем. */
  readonly deltaPct: number | null;
  readonly periods: number;
}

export function categoryVerdict(input: BudgetAdviceInput): CategoryVerdict {
  const { plannedMinor, history } = input;
  const periods = history.length;
  if (periods === 0) return { kind: 'unknown', medianMinor: 0n, deltaPct: null, periods };

  const medianMinor = median(history);
  const deltaPct =
    plannedMinor > 0n
      ? Number(((medianMinor - plannedMinor) * 10_000n) / plannedMinor) / 100
      : null;

  if (plannedMinor <= 0n) return { kind: 'unplanned', medianMinor, deltaPct, periods };
  if (periods < MIN_PERIODS) return { kind: 'unknown', medianMinor, deltaPct, periods };

  // Разброс в обе стороны — не «поднять» и не «снизить»: привычки не видно.
  if (isVolatile(history)) return { kind: 'volatile', medianMinor, deltaPct, periods };

  const advice = budgetAdvice(input);
  if (!advice) return { kind: 'stable', medianMinor, deltaPct, periods };
  return { kind: advice.kind, medianMinor, deltaPct, periods };
}
