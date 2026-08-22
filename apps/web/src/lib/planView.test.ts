import { describe, expect, test } from 'vitest';
import type { PlanAllocation, PlanDto } from './queries.ts';
import { axisMinGapPct, cascadeGroups, clusterMarks, donutArcs, markPosition } from './planView.ts';

/**
 * Подготовка данных плана к плотной раскладке прототипа: донат каскада и карта периода.
 * Считать это в разметке нельзя — числа должны сходиться (доли в 100%, точки внутри полосы),
 * а проверить это можно только тестом.
 */

function alloc(over: Partial<PlanAllocation>): PlanAllocation {
  return {
    targetKind: 'category',
    targetId: 'x',
    name: 'X',
    sourceCurrency: 'RUB',
    sourceMinor: '0',
    plannedMinor: '0',
    allocatedMinor: '0',
    shortfallMinor: '0',
    spentMinor: '0',
    remainingMinor: '0',
    overspentMinor: '0',
    executionStatus: 'pending',
    executedMinor: '0',
    remainderMinor: '0',
    ...over,
  };
}

function plan(over: Partial<PlanDto>): PlanDto {
  return {
    period: { startsOn: '2026-07-25', endsOn: '2026-08-09' },
    daysInPeriod: 16,
    daysLeft: 6,
    baseCurrency: 'RUB',
    incomeMinor: '0',
    totalPlannedMinor: '0',
    totalAllocatedMinor: '0',
    compressedMinor: '0',
    freeMinor: '0',
    toExchangeMinor: '0',
    toExchangeByCurrency: [],
    bufferMinor: '0',
    canSpendPerDayMinor: '0',
    extraIncomeMinor: '0',
    livingMinor: '0',
    spentLivingMinor: '0',
    remainingLivingMinor: '0',
    overspentMinor: '0',
    allocations: [],
    unresolved: [],
    burn: { perDayMinor: '0', willLast: true, runsOutOn: null },
    income: { events: [], unresolved: [] },
    ...over,
  };
}

describe('cascadeGroups', () => {
  test('складывает строки в группы каскада в порядке приоритета', () => {
    const groups = cascadeGroups(
      plan({
        allocations: [
          alloc({ targetKind: 'goal', allocatedMinor: '300' }),
          alloc({ targetKind: 'debt', allocatedMinor: '100' }),
          alloc({ targetKind: 'category', allocatedMinor: '200' }),
          alloc({ targetKind: 'debt', allocatedMinor: '50' }),
        ],
      }),
    );

    expect(groups.map((g) => g.kind)).toEqual(['debt', 'category', 'goal']);
    expect(groups[0]?.minor).toBe(150n);
  });

  test('пустые группы не показываются: в донате нет дуг нулевой длины', () => {
    const groups = cascadeGroups(
      plan({ allocations: [alloc({ targetKind: 'debt', allocatedMinor: '100' })] }),
    );
    expect(groups).toHaveLength(1);
  });

  test('доли считаются от суммы раздачи, а не от дохода: сумма долей — 100%', () => {
    const groups = cascadeGroups(
      plan({
        incomeMinor: '1000',
        allocations: [
          alloc({ targetKind: 'debt', allocatedMinor: '100' }),
          alloc({ targetKind: 'category', allocatedMinor: '300' }),
        ],
      }),
    );
    expect(groups.reduce((s, g) => s + g.share, 0)).toBeCloseTo(100, 6);
    expect(groups[0]?.share).toBeCloseTo(25, 6);
  });

  test('пустой план не делит на ноль', () => {
    expect(cascadeGroups(plan({}))).toEqual([]);
  });
});

describe('donutArcs', () => {
  test('дуги идут подряд без зазоров и накрывают всю окружность', () => {
    const arcs = donutArcs([
      { kind: 'debt', minor: 1n, share: 25 },
      { kind: 'category', minor: 3n, share: 75 },
    ]);
    expect(arcs[0]?.offset).toBeCloseTo(0, 6);
    expect(arcs[1]?.offset).toBeCloseTo(25, 6);
    expect(arcs.at(-1)!.offset + arcs.at(-1)!.length).toBeCloseTo(100, 6);
  });

  test('доля меньше видимого минимума всё равно рисуется: строка не должна исчезать', () => {
    const arcs = donutArcs([
      { kind: 'debt', minor: 1n, share: 0.05 },
      { kind: 'category', minor: 1999n, share: 99.95 },
    ]);
    expect(arcs[0]?.length).toBeGreaterThanOrEqual(0.8);
    expect(arcs.at(-1)!.offset + arcs.at(-1)!.length).toBeCloseTo(100, 6);
  });
});

describe('markPosition', () => {
  const from = '2026-07-25';
  const to = '2026-08-09';

  test('начало и конец периода — 0 и 100%', () => {
    expect(markPosition(from, to, from)).toBe(0);
    expect(markPosition(from, to, to)).toBe(100);
  });

  test('дата внутри периода даёт долю пройденного пути', () => {
    // 25.07 → 09.08 — это 15 дней; 01.08 это 7-й день, то есть 46,7% полосы, а не «середина».
    expect(markPosition(from, to, '2026-08-01')).toBeCloseTo((7 / 15) * 100, 6);
  });

  test('дата за границами обрезается, а не уезжает за полосу', () => {
    expect(markPosition(from, to, '2026-07-01')).toBe(0);
    expect(markPosition(from, to, '2026-12-31')).toBe(100);
  });

  test('вырожденный период не даёт NaN', () => {
    expect(markPosition(from, from, from)).toBe(0);
  });
});

describe('clusterMarks', () => {
  const m = (at: number, tone: 'today' | 'risk' | 'income' | 'due' | 'fx', label: string) => ({
    at,
    tone,
    label,
    key: `${tone}${at}`,
  });

  test('близкие метки сливаются в одну: подписи не наезжают друг на друга', () => {
    const groups = clusterMarks([m(2, 'income', 'Зарплата'), m(4, 'due', 'Рента')], 7);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hidden).toBe(1);
  });

  test('далёкие метки остаются отдельными', () => {
    const groups = clusterMarks([m(0, 'income', 'Зарплата'), m(60, 'due', 'Рента')], 7);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.at)).toEqual([0, 60]);
  });

  test('в группе главной остаётся важнейшая метка, а не первая по дате', () => {
    const groups = clusterMarks([m(10, 'due', 'Интернет'), m(12, 'risk', 'деньги кончатся')], 7);
    expect(groups[0]?.lead.tone).toBe('risk');
    // Позиция группы — от главной метки: точка риска должна стоять на своей дате.
    expect(groups[0]?.at).toBe(12);
  });

  test('порядок групп — по позиции, входной порядок не важен', () => {
    const groups = clusterMarks([m(80, 'due', 'B'), m(10, 'income', 'A')], 7);
    expect(groups.map((g) => g.lead.label)).toEqual(['A', 'B']);
  });

  test('пустой вход — пустой выход', () => {
    expect(clusterMarks([], 7)).toEqual([]);
  });
});

/**
 * Зазор подписей на оси (issue #87). Раньше он был константой в процентах — 9% оси. На ноутбуке
 * это 130px и подписи не спорили, на телефоне те же 9% превращались в 31px, и «01 · Utilities
 * 8,200 RSD», «Сегодня» и «Internet + mobile» печатались друг поверх друга.
 */
describe('axisMinGapPct', () => {
  test('на широкой оси зазор — доля от неё, подписи почти не схлопываются', () => {
    const pct = axisMinGapPct(1390);
    expect(pct).toBeGreaterThan(8);
    expect(pct).toBeLessThan(14);
  });

  test('на телефоне зазор растёт настолько, что рядом стоящие подписи схлопнутся', () => {
    const pct = axisMinGapPct(342);
    expect(pct).toBeGreaterThan(30);
  });

  test('чем уже ось, тем больше зазор — никогда наоборот', () => {
    const widths = [1440, 1024, 768, 560, 390, 320];
    const pcts = widths.map(axisMinGapPct);
    for (let i = 1; i < pcts.length; i += 1) {
      expect(pcts[i]!).toBeGreaterThanOrEqual(pcts[i - 1]!);
    }
  });

  test('нулевая или неизмеренная ширина не даёт делить на ноль', () => {
    expect(Number.isFinite(axisMinGapPct(0))).toBe(true);
    expect(axisMinGapPct(0)).toBeLessThanOrEqual(100);
  });

  test('зазор не превышает всей оси: иначе схлопнется даже единственная метка группы', () => {
    expect(axisMinGapPct(120)).toBeLessThanOrEqual(100);
  });
});
