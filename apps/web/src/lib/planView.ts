import type { PlanDto, PlanTargetKind } from './queries.ts';

/**
 * Подготовка плана к плотной раскладке (прототип, issue #30): агрегаты для доната каскада и
 * позиции точек на карте периода. Здесь только арифметика отображения — доменные решения
 * (сколько кому досталось, что сжато) принимает `packages/core` и остаётся в DTO неизменным.
 */

/** Порядок каскада — тот же, что в ядре: долги → корзины → конверты → категории → цели. */
export const CASCADE_ORDER: readonly PlanTargetKind[] = ['debt', 'bucket', 'envelope', 'category', 'goal'];

export interface CascadeGroup {
  kind: PlanTargetKind;
  minor: bigint;
  /** Доля в раздаче, проценты. Считается от суммы групп, а не от дохода: донат замкнут. */
  share: number;
}

/** Суммы по группам каскада; пустые группы пропущены — дуга нулевой длины читается как артефакт. */
export function cascadeGroups(plan: PlanDto): CascadeGroup[] {
  const sums = new Map<PlanTargetKind, bigint>();
  for (const a of plan.allocations) {
    sums.set(a.targetKind, (sums.get(a.targetKind) ?? 0n) + BigInt(a.allocatedMinor));
  }

  const present = CASCADE_ORDER.filter((kind) => (sums.get(kind) ?? 0n) > 0n);
  const total = present.reduce((acc, kind) => acc + (sums.get(kind) ?? 0n), 0n);
  if (total === 0n) return [];

  return present.map((kind) => {
    const minor = sums.get(kind) ?? 0n;
    return { kind, minor, share: Number((minor * 1_000_000n) / total) / 10_000 };
  });
}

export interface DonutArc {
  kind: PlanTargetKind;
  /** Смещение начала дуги по окружности, проценты. */
  offset: number;
  /** Длина дуги, проценты. */
  length: number;
}

/** Минимальная видимая дуга: строка на 0,05% иначе исчезает, и в легенде появляется «призрак». */
const MIN_ARC = 0.8;

/**
 * Доли → дуги: подряд, без зазоров, суммарно на всю окружность. Мелкие доли поднимаются до
 * видимого минимума, а недостача берётся с крупных — масштабировать всё подряд нельзя, иначе
 * поднятая дуга снова уходит под минимум.
 */
export function donutArcs(groups: readonly CascadeGroup[]): DonutArc[] {
  if (groups.length === 0) return [];

  const tiny = groups.filter((g) => g.share < MIN_ARC);
  const rest = groups.filter((g) => g.share >= MIN_ARC);
  const restTotal = rest.reduce((s, g) => s + g.share, 0);
  const budget = 100 - MIN_ARC * tiny.length;
  // Групп так много, что минимумы не влезают в окружность: делим её ровно.
  const equal = budget <= 0 || restTotal <= 0;

  let offset = 0;
  return groups.map((g) => {
    const length = equal
      ? 100 / groups.length
      : g.share < MIN_ARC
        ? MIN_ARC
        : (g.share / restTotal) * budget;
    const arc = { kind: g.kind, offset, length };
    offset += length;
    return arc;
  });
}

const DAY_MS = 86_400_000;

function dayValue(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

/**
 * Позиция даты на полосе периода, проценты. За границами обрезается: событие следующего периода
 * (рента 1-го, закрытие долга в августе) должно упираться в край, а не уезжать из полосы.
 */
export function markPosition(startsOn: string, endsOn: string, on: string): number {
  const span = dayValue(endsOn) - dayValue(startsOn);
  if (span <= 0) return 0;
  const share = ((dayValue(on) - dayValue(startsOn)) / span) * 100;
  return Math.min(100, Math.max(0, share));
}

/** Дата «сегодня» внутри периода: у DTO есть только `daysLeft`, отсчитываем от конца. */
export function todayInPeriod(plan: PlanDto): string {
  const at = dayValue(plan.period.endsOn) - plan.daysLeft * DAY_MS;
  return new Date(at).toISOString().slice(0, 10);
}

/** Роль метки на оси периода. Порядок важен: он же задаёт приоритет в тесной группе. */
export type MarkTone = 'today' | 'risk' | 'income' | 'due' | 'fx';

const TONE_RANK: Record<MarkTone, number> = { today: 0, risk: 1, income: 2, due: 3, fx: 4 };

export interface AxisMark {
  key: string;
  at: number;
  tone: MarkTone;
  label: string;
}

export interface MarkCluster {
  at: number;
  /** Метка, чья подпись показывается: важнейшая в группе, а не первая по дате. */
  lead: AxisMark;
  /** Сколько подписей скрыто под ней — иначе непонятно, что событий больше одного. */
  hidden: number;
}

/**
 * Схлопывает метки, стоящие ближе `minGapPct` процентов друг к другу. Без этого подписи на оси
 * налезают одна на другую и карта периода становится нечитаемой — а именно она отвечает на
 * вопрос «что успеет случиться до выплаты».
 */
export function clusterMarks(marks: readonly AxisMark[], minGapPct: number): MarkCluster[] {
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  const clusters: AxisMark[][] = [];
  for (const mark of sorted) {
    const current = clusters.at(-1);
    if (current && mark.at - current.at(-1)!.at < minGapPct) current.push(mark);
    else clusters.push([mark]);
  }

  return clusters.map((group) => {
    const lead = [...group].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])[0]!;
    return { at: lead.at, lead, hidden: group.length - 1 };
  });
}
