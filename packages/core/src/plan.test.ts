import { describe, expect, it } from 'vitest';
import {
  assemblePlan,
  categorySpending,
  executionOf,
  orderPlanItems,
  PLAN_PRIORITY,
  summarizeFact,
  summarizePlan,
} from './plan.ts';
import { cascade, type PlanItem } from './cascade.ts';

const item = (
  targetKind: PlanItem['targetKind'],
  targetId: string,
  plannedMinor: bigint,
  isProtected = false,
): PlanItem => ({ targetKind, targetId, plannedMinor, protected: isProtected });

describe('orderPlanItems — порядок каскада', () => {
  it('раскладывает по приоритету debt→bucket→envelope→category→goal', () => {
    const shuffled = [
      item('goal', 'moto', 5000n),
      item('category', 'food', 20000n),
      item('debt', 'ozon', 20000n),
      item('bucket', 'eur', 60000n),
      item('envelope', 'invest', 8000n),
    ];
    const kinds = orderPlanItems(shuffled).map((i) => i.targetKind);
    expect(kinds).toEqual(['debt', 'bucket', 'envelope', 'category', 'goal']);
    expect([...PLAN_PRIORITY]).toEqual(kinds);
  });

  it('внутри одного уровня сохраняет исходный порядок (стабильность) и не мутирует вход', () => {
    const input = [item('category', 'b', 1n), item('category', 'a', 1n)];
    const out = orderPlanItems(input);
    expect(out.map((i) => i.targetId)).toEqual(['b', 'a']);
    expect(input.map((i) => i.targetId)).toEqual(['b', 'a']); // вход не тронут
  });
});

describe('summarizePlan — производные ага-момента', () => {
  it('к размену = сумма корзин; свободно и цифра дня из живого остатка', () => {
    const plan = [
      item('debt', 'ozon', 20000n),
      item('bucket', 'eur', 60000n),
      item('bucket', 'rsd', 40000n),
      item('category', 'food', 20000n),
    ];
    const r = cascade(160000n, plan); // free = 20000
    const s = summarizePlan(r, { daysInPeriod: 20 });
    expect(s.toExchangeMinor).toBe(100000n); // 60000 + 40000
    expect(s.freeMinor).toBe(20000n);
    expect(s.livingMinor).toBe(40000n); // category 20000 + free 20000
    expect(s.canSpendPerDayMinor).toBe(2000n); // 40000 / 20
  });

  it('дней 0 → цифра дня 0 (без деления на ноль)', () => {
    const r = cascade(1000n, [item('category', 'x', 500n)]);
    expect(summarizePlan(r, { daysInPeriod: 0 }).canSpendPerDayMinor).toBe(0n);
  });

  it('нехватка на обязательства → free < 0, living и цифра дня не уходят в минус', () => {
    const plan = [item('debt', 'a', 100000n), item('bucket', 'b', 50000n)];
    const r = cascade(120000n, plan); // долги+корзины не режутся → free = -30000
    const s = summarizePlan(r, { daysInPeriod: 15 });
    expect(s.freeMinor).toBe(-30000n);
    expect(s.livingMinor).toBe(0n);
    expect(s.canSpendPerDayMinor).toBe(0n);
  });
});

describe('summarizeFact — цифра дня от факта (Спринт 3)', () => {
  const living = (livingMinor: bigint) => summarizePlan(cascade(livingMinor, [item('category', 'food', livingMinor)]), { daysInPeriod: 16 });

  it('без трат делит остаток на ОСТАВШИЕСЯ дни, а не на длину периода', () => {
    // Регрессия: цифра дня делилась на daysInPeriod (16) и в середине периода занижала темп.
    const f = summarizeFact(living(35000n), { spentLivingMinor: 0n, daysLeft: 12 });

    expect(f.remainingLivingMinor).toBe(35000n);
    expect(f.canSpendPerDayMinor).toBe(2916n); // 35000 / 12, а не 35000 / 16
  });

  it('потраченное уменьшает остаток и темп', () => {
    const f = summarizeFact(living(35000n), { spentLivingMinor: 11000n, daysLeft: 12 });

    expect(f.spentLivingMinor).toBe(11000n);
    expect(f.remainingLivingMinor).toBe(24000n);
    expect(f.canSpendPerDayMinor).toBe(2000n); // 24000 / 12
    expect(f.overspentMinor).toBe(0n);
  });

  it('перерасход показывает честный минус, но цифру дня не уводит ниже нуля', () => {
    const f = summarizeFact(living(35000n), { spentLivingMinor: 40000n, daysLeft: 12 });

    expect(f.remainingLivingMinor).toBe(-5000n);
    expect(f.overspentMinor).toBe(5000n);
    expect(f.canSpendPerDayMinor).toBe(0n);
  });

  it('последний день периода (осталось 0) → цифра дня 0, без деления на ноль', () => {
    const f = summarizeFact(living(35000n), { spentLivingMinor: 0n, daysLeft: 0 });

    expect(f.canSpendPerDayMinor).toBe(0n);
    expect(f.remainingLivingMinor).toBe(35000n);
  });

  it('делит вниз: остаток не размазывается больше, чем есть', () => {
    const f = summarizeFact(living(100n), { spentLivingMinor: 0n, daysLeft: 3 });

    expect(f.canSpendPerDayMinor).toBe(33n); // 100 / 3 = 33.33 → 33
    expect(f.canSpendPerDayMinor * 3n).toBeLessThanOrEqual(f.remainingLivingMinor);
  });
});

describe('categorySpending — остаток по категории', () => {
  it('остаток = бюджет − факт; перерасход отдаётся отдельно', () => {
    expect(categorySpending(20000n, 12000n)).toEqual({ spentMinor: 12000n, remainingMinor: 8000n, overspentMinor: 0n });
    expect(categorySpending(20000n, 26000n)).toEqual({ spentMinor: 26000n, remainingMinor: -6000n, overspentMinor: 6000n });
  });

  it('категория без бюджета: любая трата — перерасход', () => {
    expect(categorySpending(0n, 500n)).toEqual({ spentMinor: 500n, remainingMinor: -500n, overspentMinor: 500n });
  });
});

describe('assemblePlan — сборка целиком', () => {
  it('упорядочивает, гоняет каскад и считает сводку; инвариант 3 (Σ ≤ доход)', () => {
    const plan = [
      item('goal', 'moto', 30000n),
      item('debt', 'ozon', 20000n),
      item('category', 'food', 20000n),
      item('bucket', 'eur', 60000n),
    ];
    const { result, summary } = assemblePlan(100000n, plan, { daysInPeriod: 20 });
    // порядок строк — по приоритету
    expect(result.allocations.map((a) => a.targetKind)).toEqual(['debt', 'bucket', 'envelope', 'category', 'goal'].filter((k) => plan.some((p) => p.targetKind === k)));
    // 20000+60000+20000+30000 = 130000 > 100000 → цель режется первой на 30000
    expect(result.compressedMinor).toBe(30000n);
    expect(result.totalAllocatedMinor).toBeLessThanOrEqual(100000n); // инвариант 3
    expect(summary.toExchangeMinor).toBe(60000n);
  });
});

describe('executionOf — исполнение плановой строки (Спринт 3)', () => {
  it('полная сумма — исполнено, остатка нет', () => {
    expect(executionOf(45000n, 45000n)).toEqual({ status: 'confirmed', remainderMinor: 0n });
  });

  it('заплатили больше плана — всё равно исполнено, остаток не отрицательный', () => {
    expect(executionOf(45000n, 50000n)).toEqual({ status: 'confirmed', remainderMinor: 0n });
  });

  it('часть суммы — частично, остаток показывает недоданное', () => {
    expect(executionOf(45000n, 20000n)).toEqual({ status: 'partial', remainderMinor: 25000n });
  });

  it('ноль — ещё не сделано (pending), а не «частично на ноль»', () => {
    expect(executionOf(45000n, 0n)).toEqual({ status: 'pending', remainderMinor: 45000n });
  });

  it('строка без плана исполнять нечего — n_a', () => {
    expect(executionOf(0n, 0n)).toEqual({ status: 'n_a', remainderMinor: 0n });
  });
});
