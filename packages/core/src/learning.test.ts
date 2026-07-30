import { describe, expect, it } from 'vitest';
import { budgetAdvice } from './learning.ts';

describe('budgetAdvice — обучение плана на факте (Спринт 4)', () => {
  it('три периода подряд перерасход — предлагает поднять план до медианы факта', () => {
    // План 20 000, факт 24 000 / 26 000 / 25 000 → медиана 25 000.
    const advice = budgetAdvice({ plannedMinor: 20000n, history: [24000n, 26000n, 25000n] });

    expect(advice).toEqual({ kind: 'raise', suggestedMinor: 25000n, periods: 3 });
  });

  it('меньше трёх периодов — молчим: два случая это не привычка', () => {
    expect(budgetAdvice({ plannedMinor: 20000n, history: [24000n, 26000n] })).toBeNull();
  });

  it('стабильный недорасход — предлагает опустить план и освободить деньги', () => {
    const advice = budgetAdvice({ plannedMinor: 20000n, history: [12000n, 11000n, 13000n] });

    expect(advice).toEqual({ kind: 'lower', suggestedMinor: 12000n, periods: 3 });
  });

  it('факт около плана — не трогаем: шум в пределах 10% не повод переписывать бюджет', () => {
    expect(budgetAdvice({ plannedMinor: 20000n, history: [19000n, 21000n, 20500n] })).toBeNull();
  });

  it('медиана чётного числа периодов — среднее двух средних', () => {
    const advice = budgetAdvice({ plannedMinor: 10000n, history: [20000n, 30000n, 24000n, 26000n] });

    expect(advice?.suggestedMinor).toBe(25000n); // (24000 + 26000) / 2
  });

  it('план на нуле: советуем ровно медиану факта, а не «поднять на процент»', () => {
    const advice = budgetAdvice({ plannedMinor: 0n, history: [5000n, 6000n, 5500n] });

    expect(advice).toEqual({ kind: 'raise', suggestedMinor: 5500n, periods: 3 });
  });

  it('разброс без направления — совета нет: система не гадает', () => {
    // Скачет вокруг плана: и выше, и ниже — привычки не видно.
    expect(budgetAdvice({ plannedMinor: 20000n, history: [30000n, 8000n, 21000n] })).toBeNull();
  });

  it('пустая история — нечему учиться', () => {
    expect(budgetAdvice({ plannedMinor: 20000n, history: [] })).toBeNull();
  });
});
