import { describe, expect, it } from 'vitest';
import { cascade, type PlanItem } from './cascade.ts';

const item = (
  targetKind: PlanItem['targetKind'],
  targetId: string,
  plannedMinor: bigint,
  isProtected = false,
): PlanItem => ({ targetKind, targetId, plannedMinor, protected: isProtected });

const alloc = (result: ReturnType<typeof cascade>, id: string) =>
  result.allocations.find((a) => a.targetId === id)!;

describe('cascade — денег достаточно', () => {
  it('раздаёт план полностью, остаток идёт в свободные', () => {
    const plan = [
      item('debt', 'ozon', 20000n),
      item('bucket', 'eur', 60000n),
      item('envelope', 'invest', 8000n),
      item('category', 'food', 20000n),
      item('goal', 'moto', 5000n),
    ];
    const r = cascade(120000n, plan);
    expect(r.totalPlannedMinor).toBe(113000n);
    expect(r.totalAllocatedMinor).toBe(113000n);
    expect(r.compressedMinor).toBe(0n);
    expect(r.freeMinor).toBe(7000n);
    for (const a of r.allocations) expect(a.allocatedMinor).toBe(a.plannedMinor);
  });
});

describe('cascade — сжатие сверху вниз: цели → конверты → категории', () => {
  it('дефицит 3000 режет только цели поровну', () => {
    const plan = [
      item('goal', 'a', 5000n),
      item('goal', 'b', 5000n),
      item('envelope', 'invest', 8000n),
      item('category', 'food', 20000n),
      item('debt', 'ozon', 20000n),
    ];
    // sum = 58000, income 55000 → deficit 3000, весь из целей
    const r = cascade(55000n, plan);
    expect(r.compressedMinor).toBe(3000n);
    expect(alloc(r, 'a').allocatedMinor).toBe(3500n);
    expect(alloc(r, 'b').allocatedMinor).toBe(3500n);
    expect(alloc(r, 'invest').allocatedMinor).toBe(8000n);
    expect(alloc(r, 'food').allocatedMinor).toBe(20000n);
    expect(alloc(r, 'ozon').allocatedMinor).toBe(20000n);
    expect(r.freeMinor).toBe(0n);
  });

  it('дефицит переливается в конверты, когда цели обнулены', () => {
    const plan = [
      item('goal', 'moto', 4000n),
      item('envelope', 'invest', 8000n),
      item('category', 'food', 20000n),
      item('debt', 'ozon', 20000n),
    ];
    // sum 52000, income 45000 → deficit 7000: цели -4000, конверты -3000
    const r = cascade(45000n, plan);
    expect(alloc(r, 'moto').allocatedMinor).toBe(0n);
    expect(alloc(r, 'invest').allocatedMinor).toBe(5000n);
    expect(alloc(r, 'food').allocatedMinor).toBe(20000n);
    expect(alloc(r, 'ozon').allocatedMinor).toBe(20000n);
    expect(r.freeMinor).toBe(0n);
  });

  it('дефицит доходит до категорий; защищённые НЕ режутся автоматически', () => {
    const plan = [
      item('goal', 'moto', 2000n),
      item('envelope', 'invest', 3000n),
      item('category', 'food', 20000n),
      item('category', 'kid', 15000n, true), // защищённая
      item('bucket', 'eur', 10000n),
      item('debt', 'ozon', 20000n),
    ];
    // sum 70000, income 60000 → deficit 10000: цели -2000, конверты -3000, обычные категории -5000
    const r = cascade(60000n, plan);
    expect(alloc(r, 'moto').allocatedMinor).toBe(0n);
    expect(alloc(r, 'invest').allocatedMinor).toBe(0n);
    expect(alloc(r, 'food').allocatedMinor).toBe(15000n); // 20000 - 5000
    expect(alloc(r, 'kid').allocatedMinor).toBe(15000n); // защищённая — не тронута
    expect(alloc(r, 'eur').allocatedMinor).toBe(10000n);
    expect(alloc(r, 'ozon').allocatedMinor).toBe(20000n);
  });
});

describe('cascade — неприкосновенные (инварианты 3, 4)', () => {
  it('долги и корзины не режутся, даже если дефицит съел всё режущееся', () => {
    const plan = [
      item('goal', 'g', 1000n),
      item('envelope', 'e', 1000n),
      item('category', 'c', 2000n),
      item('debt', 'ozon', 50000n),
      item('bucket', 'eur', 30000n),
    ];
    // sum 84000, income 40000. Режущееся = 4000 < дефицит 44000
    const r = cascade(40000n, plan);
    expect(alloc(r, 'g').allocatedMinor).toBe(0n);
    expect(alloc(r, 'e').allocatedMinor).toBe(0n);
    expect(alloc(r, 'c').allocatedMinor).toBe(0n);
    expect(alloc(r, 'ozon').allocatedMinor).toBe(50000n); // долг цел
    expect(alloc(r, 'eur').allocatedMinor).toBe(30000n); // корзина цела
    expect(r.freeMinor).toBe(-40000n); // остаточный дефицит по обязательствам
  });

  it('защищённая категория не режется даже когда обычных категорий нет', () => {
    const plan = [
      item('goal', 'g', 1000n),
      item('envelope', 'e', 1000n),
      item('category', 'kid', 20000n, true),
      item('debt', 'ozon', 10000n),
    ];
    // sum 32000, income 28000, deficit 4000: цели -1000, конверты -1000, дальше только защищённая → стоп
    const r = cascade(28000n, plan);
    expect(alloc(r, 'kid').allocatedMinor).toBe(20000n);
    expect(alloc(r, 'ozon').allocatedMinor).toBe(10000n);
    expect(r.freeMinor).toBe(-2000n);
  });
});

describe('cascade — пропорциональное дробление уровня с остатком', () => {
  it('распределяет неделимый остаток детерминированно (первым — больший)', () => {
    const plan = [item('goal', 'x', 100n), item('goal', 'y', 100n), item('goal', 'z', 100n)];
    // sum 300, income 200, deficit 100 из целей: 100*100/300 = 33.33 → 34,33,33
    const r = cascade(200n, plan);
    expect(alloc(r, 'x').allocatedMinor).toBe(66n);
    expect(alloc(r, 'y').allocatedMinor).toBe(67n);
    expect(alloc(r, 'z').allocatedMinor).toBe(67n);
    expect(r.compressedMinor).toBe(100n);
  });
});

describe('настраиваемый порядок сжатия (issue #49)', () => {
  const plan: PlanItem[] = [
    { targetKind: 'debt', targetId: 'd', plannedMinor: 10_000_00n },
    { targetKind: 'bucket', targetId: 'b', plannedMinor: 10_000_00n },
    { targetKind: 'envelope', targetId: 'e', plannedMinor: 10_000_00n },
    { targetKind: 'category', targetId: 'c', plannedMinor: 10_000_00n },
    { targetKind: 'goal', targetId: 'g', plannedMinor: 10_000_00n },
  ];
  const byId = (r: ReturnType<typeof cascade>, id: string) =>
    r.allocations.find((a) => a.targetId === id)!.allocatedMinor;

  it('по умолчанию первыми уступают цели, затем конверты, затем категории', () => {
    const r = cascade(40_000_00n, plan);
    expect(byId(r, 'g')).toBe(0n);
    expect(byId(r, 'e')).toBe(10_000_00n);
  });

  it('порядок можно изменить: сначала категории, цели остаются целыми', () => {
    const r = cascade(40_000_00n, plan, {
      compressOrder: ['category', 'envelope', 'goal'],
    });
    expect(byId(r, 'c')).toBe(0n);
    expect(byId(r, 'g')).toBe(10_000_00n);
  });

  it('долги и корзины не режутся ни при каком порядке — инвариант неснимаем', () => {
    const r = cascade(5_000_00n, plan, {
      // Даже если порядок попросит резать долги, каскад обязан их сохранить.
      compressOrder: ['debt', 'bucket', 'goal', 'envelope', 'category'] as never,
    });
    expect(byId(r, 'd')).toBe(10_000_00n);
    expect(byId(r, 'b')).toBe(10_000_00n);
    // Нехватка честно уходит в минус свободного остатка, а не прячется срезом долга.
    expect(r.freeMinor).toBeLessThan(0n);
  });

  it('неполный порядок дополняется остальными уровнями, а не теряет их', () => {
    const r = cascade(20_000_00n, plan, { compressOrder: ['category'] });
    // Категорию срезали первой, но дефицит больше — конверты и цели тоже уступили.
    expect(byId(r, 'c')).toBe(0n);
    expect(byId(r, 'e') + byId(r, 'g')).toBeLessThan(20_000_00n);
  });

  it('защищённая категория не режется даже когда порядок ставит категории первыми', () => {
    const withProtected: PlanItem[] = [
      { targetKind: 'category', targetId: 'p', plannedMinor: 10_000_00n, protected: true },
      { targetKind: 'category', targetId: 'c', plannedMinor: 10_000_00n },
      { targetKind: 'goal', targetId: 'g', plannedMinor: 10_000_00n },
    ];
    const r = cascade(20_000_00n, withProtected, { compressOrder: ['category', 'goal'] });
    expect(byId(r, 'p')).toBe(10_000_00n);
    expect(byId(r, 'c')).toBe(0n);
  });
});
