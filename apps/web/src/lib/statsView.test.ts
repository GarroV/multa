import { describe, expect, test } from 'vitest';
import { currencyMix, lockedSplit, planVsFact, spreadAverage } from './statsView.ts';
import type { ExchangeOp, PlanAllocation, PlanDto } from './queries.ts';

/**
 * Агрегаты экрана «Статистика». Все они отвечают на вопросы деньгами и процентами, поэтому
 * проверяются тестами: доли обязаны сходиться, пустые данные не должны давать NaN, а знак
 * отклонения плана от факта — путать перерасход с экономией.
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

function op(over: Partial<ExchangeOp>): ExchangeOp {
  return {
    id: 'op',
    occurredOn: '2026-07-20',
    fromCurrency: 'RUB',
    toCurrency: 'EUR',
    fromMinor: '100000',
    toMinor: '1000',
    actualRate: '100',
    officialRate: '98',
    spreadMinor: '2000',
    spreadPct: '2.00',
    note: null,
    ...over,
  } as ExchangeOp;
}

describe('lockedSplit', () => {
  test('обязательное и гибкое считаются от раздачи: категории гибкие, остальное — нет', () => {
    const split = lockedSplit(
      plan({
        allocations: [
          alloc({ targetKind: 'debt', allocatedMinor: '30000' }),
          alloc({ targetKind: 'category', allocatedMinor: '10000' }),
        ],
      }),
    );
    expect(split.lockedMinor).toBe(30_000n);
    expect(split.flexibleMinor).toBe(10_000n);
    expect(split.lockedPct).toBeCloseTo(75, 6);
  });

  test('пустой план не делит на ноль', () => {
    const split = lockedSplit(plan({}));
    expect(split.lockedPct).toBe(0);
    expect(split.flexibleMinor).toBe(0n);
  });
});

describe('currencyMix', () => {
  test('доли по валюте обязательств, от большей к меньшей', () => {
    const mix = currencyMix(
      plan({
        allocations: [
          alloc({ sourceCurrency: 'RSD', allocatedMinor: '20000' }),
          alloc({ sourceCurrency: 'EUR', allocatedMinor: '60000' }),
          alloc({ sourceCurrency: 'RSD', allocatedMinor: '20000' }),
        ],
      }),
    );
    expect(mix.map((m) => m.currency)).toEqual(['EUR', 'RSD']);
    expect(mix[0]?.pct).toBeCloseTo(60, 6);
    expect(mix.reduce((s, m) => s + m.pct, 0)).toBeCloseTo(100, 6);
  });

  test('строки без суммы не превращаются в валюту с нулевой долей', () => {
    const mix = currencyMix(
      plan({ allocations: [alloc({ sourceCurrency: 'GEL', allocatedMinor: '0' })] }),
    );
    expect(mix).toEqual([]);
  });
});

describe('planVsFact', () => {
  test('перерасход даёт положительное отклонение, экономия — отрицательное', () => {
    const over = planVsFact(
      plan({ allocations: [alloc({ allocatedMinor: '10000', spentMinor: '12000' })] }),
    );
    expect(over.deltaPct).toBeCloseTo(20, 6);

    const saved = planVsFact(
      plan({ allocations: [alloc({ allocatedMinor: '10000', spentMinor: '9000' })] }),
    );
    expect(saved.deltaPct).toBeCloseTo(-10, 6);
  });

  test('считается только по категориям: долг не «перерасход», пока не оплачен', () => {
    const res = planVsFact(
      plan({
        allocations: [
          alloc({ targetKind: 'debt', allocatedMinor: '50000', spentMinor: '0' }),
          alloc({ allocatedMinor: '10000', spentMinor: '10000' }),
        ],
      }),
    );
    expect(res.deltaPct).toBe(0);
    expect(res.plannedMinor).toBe(10_000n);
  });

  test('без бюджета отклонение не считается, а не показывается как −100%', () => {
    expect(planVsFact(plan({})).deltaPct).toBeNull();
  });
});

describe('spreadAverage', () => {
  test('среднее по операциям с известным спредом', () => {
    const avg = spreadAverage([op({ spreadPct: '1.00' }), op({ spreadPct: '3.00' })]);
    expect(avg?.pct).toBeCloseTo(2, 6);
    expect(avg?.count).toBe(2);
  });

  test('операции без официального курса в среднее не попадают', () => {
    const avg = spreadAverage([
      op({ spreadPct: '2.00' }),
      op({ spreadPct: null, officialRate: null }),
    ]);
    expect(avg?.count).toBe(1);
    expect(avg?.pct).toBeCloseTo(2, 6);
  });

  test('нет данных — нет цифры, а не ноль процентов', () => {
    expect(spreadAverage([])).toBeNull();
    expect(spreadAverage([op({ spreadPct: null })])).toBeNull();
  });
});
