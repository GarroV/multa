import { describe, expect, it } from 'vitest';
import { rebalanceOptions } from './rebalance.ts';

/** План: еда 20k (кончается), прочее 10k свободно, конверт 8k, цель 5k, долг 45k. */
const rows = [
  {
    targetKind: 'category' as const,
    targetId: 'food',
    name: 'Еда',
    allocatedMinor: 20000n,
    spentMinor: 20000n,
    protected: false,
  },
  {
    targetKind: 'category' as const,
    targetId: 'misc',
    name: 'Прочее',
    allocatedMinor: 10000n,
    spentMinor: 2000n,
    protected: false,
  },
  {
    targetKind: 'category' as const,
    targetId: 'rent',
    name: 'Аренда',
    allocatedMinor: 30000n,
    spentMinor: 0n,
    protected: true,
  },
  {
    targetKind: 'envelope' as const,
    targetId: 'inv',
    name: 'Инвестиции',
    allocatedMinor: 8000n,
    spentMinor: 0n,
    protected: false,
  },
  {
    targetKind: 'goal' as const,
    targetId: 'moto',
    name: 'Мотоцикл',
    allocatedMinor: 5000n,
    spentMinor: 0n,
    protected: false,
  },
  {
    targetKind: 'debt' as const,
    targetId: 'ozon',
    name: 'Озон',
    allocatedMinor: 45000n,
    spentMinor: 0n,
    protected: false,
  },
];

describe('rebalanceOptions — откуда взять денег (Спринт 4)', () => {
  it('предлагает источники в порядке «сначала цели, потом конверты, потом категории»', () => {
    const opts = rebalanceOptions({ rows, needMinor: 4000n, targetId: 'food' });

    expect(opts.map((o) => o.targetId)).toEqual(['moto', 'inv', 'misc']);
  });

  it('долги и корзины не предлагает никогда — их автоматика не трогает', () => {
    const opts = rebalanceOptions({ rows, needMinor: 4000n, targetId: 'food' });

    expect(opts.some((o) => o.targetKind === 'debt' || o.targetKind === 'bucket')).toBe(false);
  });

  it('защищённые категории не предлагает: их режут только вручную', () => {
    const opts = rebalanceOptions({ rows, needMinor: 4000n, targetId: 'food' });

    expect(opts.some((o) => o.targetId === 'rent')).toBe(false);
  });

  it('саму строку-получателя в источники не берёт', () => {
    const opts = rebalanceOptions({ rows, needMinor: 4000n, targetId: 'misc' });

    expect(opts.some((o) => o.targetId === 'misc')).toBe(false);
  });

  it('у категории доступно только неистраченное, у обязательства — вся аллокация', () => {
    const opts = rebalanceOptions({ rows, needMinor: 100000n, targetId: 'food' });

    expect(opts.find((o) => o.targetId === 'misc')?.availableMinor).toBe(8000n); // 10000 − 2000 факта
    expect(opts.find((o) => o.targetId === 'inv')?.availableMinor).toBe(8000n);
  });

  it('строку без свободных денег не предлагает', () => {
    const spentAll = rows.map((r) => (r.targetId === 'misc' ? { ...r, spentMinor: 10000n } : r));
    const opts = rebalanceOptions({ rows: spentAll, needMinor: 1000n, targetId: 'food' });

    expect(opts.some((o) => o.targetId === 'misc')).toBe(false);
  });

  it('покрытие: сколько реально можно взять из строки под запрошенную сумму', () => {
    const opts = rebalanceOptions({ rows, needMinor: 3000n, targetId: 'food' });

    expect(opts[0]).toMatchObject({ targetId: 'moto', takeMinor: 3000n }); // цель покрывает целиком
    expect(opts.find((o) => o.targetId === 'inv')?.takeMinor).toBe(3000n);
  });

  it('если сумма больше доступного — берём сколько есть, не выдумывая остаток', () => {
    const opts = rebalanceOptions({ rows, needMinor: 6000n, targetId: 'food' });

    expect(opts.find((o) => o.targetId === 'moto')?.takeMinor).toBe(5000n); // в цели всего 5000
  });

  it('нечего предложить — пустой список, а не выдуманный источник', () => {
    const onlyDebt = rows.filter((r) => r.targetKind === 'debt');
    expect(rebalanceOptions({ rows: onlyDebt, needMinor: 1000n, targetId: 'food' })).toEqual([]);
  });
});
