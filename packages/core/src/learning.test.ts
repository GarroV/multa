import { describe, expect, it } from 'vitest';
import { budgetAdvice, categoryVerdict } from './learning.ts';

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
    const advice = budgetAdvice({
      plannedMinor: 10000n,
      history: [20000n, 30000n, 24000n, 26000n],
    });

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

describe('categoryVerdict', () => {
  const planned = 20_000_00n;

  it('мало истории — «пока не знаем», а не выдуманный вердикт', () => {
    expect(categoryVerdict({ plannedMinor: planned, history: [20_000_00n] }).kind).toBe('unknown');
  });

  it('факт держится около плана — стабильно', () => {
    const v = categoryVerdict({
      plannedMinor: planned,
      history: [19_500_00n, 20_400_00n, 20_100_00n, 19_900_00n],
    });
    expect(v.kind).toBe('stable');
    expect(v.medianMinor).toBe(20_000_00n);
  });

  it('стабильно выше плана — поднять, и сумма равна медиане', () => {
    const v = categoryVerdict({
      plannedMinor: planned,
      history: [24_000_00n, 23_800_00n, 24_400_00n],
    });
    expect(v.kind).toBe('raise');
    expect(v.medianMinor).toBe(24_000_00n);
    expect(v.deltaPct).toBeGreaterThan(15);
  });

  it('стабильно ниже плана — снизить', () => {
    expect(
      categoryVerdict({ plannedMinor: planned, history: [12_000_00n, 13_000_00n, 12_500_00n] })
        .kind,
    ).toBe('lower');
  });

  it('разброс в обе стороны — «нестабильно»: такую статью не поднимают, а разбирают', () => {
    const v = categoryVerdict({
      plannedMinor: planned,
      history: [40_000_00n, 5_000_00n, 35_000_00n, 6_000_00n],
    });
    expect(v.kind).toBe('volatile');
  });

  it('без плана вердикт по факту не выносится, но медиана считается', () => {
    const v = categoryVerdict({ plannedMinor: 0n, history: [10_000_00n, 11_000_00n, 9_000_00n] });
    expect(v.kind).toBe('unplanned');
    expect(v.medianMinor).toBe(10_000_00n);
    expect(v.deltaPct).toBeNull();
  });

  it('вердикт согласован с советом: где совет молчит, вердикт не требует правки плана', () => {
    const input = { plannedMinor: planned, history: [20_400_00n, 19_800_00n, 20_100_00n] };
    expect(budgetAdvice(input)).toBeNull();
    expect(['stable', 'volatile']).toContain(categoryVerdict(input).kind);
  });
});

describe('нестабильность — свойство ряда, а не его положения относительно плана (#82)', () => {
  /*
   * Симптом, с которого начался issue: у категории план 2 500, медиана факта 7 750 → вердикт
   * «поднять план». Человек поднимает — и тот же экран отвечает «статья скачет, поднимать рано».
   * Совет противоречил сам себе, потому что разброс мерился от плана: при заниженном плане все
   * точки лежали выше него, и разброса «не было».
   */
  const jumpy = [12_000_00n, 2_000_00n, 11_000_00n, 1_500_00n];

  it('один и тот же ряд нестабилен при любом плане', () => {
    for (const plannedMinor of [1_000_00n, 6_500_00n, 20_000_00n]) {
      expect(categoryVerdict({ plannedMinor, history: jumpy }).kind).toBe('volatile');
    }
  });

  it('поднятие плана до медианы не превращает совет в свою противоположность', () => {
    // Ровный ряд: при заниженном плане советуем поднять, после поднятия — «стабильно», и точка.
    const steady = [10_000_00n, 10_500_00n, 9_800_00n, 10_200_00n];
    const before = categoryVerdict({ plannedMinor: 5_000_00n, history: steady });
    expect(before.kind).toBe('raise');

    const after = categoryVerdict({ plannedMinor: before.medianMinor, history: steady });
    expect(after.kind).toBe('stable');
  });

  it('совет по нестабильной статье молчит независимо от плана', () => {
    // Иначе сигнал предложил бы «поднять план» по медиане ряда, в котором никакой привычки нет.
    for (const plannedMinor of [1_000_00n, 6_500_00n, 20_000_00n]) {
      expect(budgetAdvice({ plannedMinor, history: jumpy })).toBeNull();
    }
  });
});
