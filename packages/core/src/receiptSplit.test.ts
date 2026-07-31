import { describe, expect, it } from 'vitest';
import { splitReceipt } from './receiptSplit.ts';

const categories = [
  { id: 'food', name: 'Продукты', keywords: ['хлеб', 'молоко', 'сыр'] },
  { id: 'home', name: 'Дом', keywords: ['порошок', 'салфетки'] },
];

describe('splitReceipt — позиции чека по категориям (Спринт 5)', () => {
  it('раскидывает позиции по ключевым словам категорий', () => {
    const r = splitReceipt({
      items: [
        { name: 'Хлеб бородинский', amountMinor: 8900n },
        { name: 'Порошок стиральный', amountMinor: 45000n },
      ],
      categories,
      fallbackCategoryId: 'general',
      totalMinor: 53900n,
    });

    expect(r.byCategory).toEqual([
      { categoryId: 'food', amountMinor: 8900n },
      { categoryId: 'home', amountMinor: 45000n },
    ]);
    expect(r.confidence).toBe('high');
  });

  it('нераспознанные позиции уходят в «Общее», а не теряются', () => {
    const r = splitReceipt({
      items: [
        { name: 'Молоко', amountMinor: 10000n },
        { name: 'Штуковина непонятная', amountMinor: 30000n },
      ],
      categories,
      fallbackCategoryId: 'general',
      totalMinor: 40000n,
    });

    expect(r.byCategory).toEqual([
      { categoryId: 'food', amountMinor: 10000n },
      { categoryId: 'general', amountMinor: 30000n },
    ]);
  });

  it('сумма раскладки всегда равна итогу чека — деньги не исчезают', () => {
    const r = splitReceipt({
      items: [
        { name: 'Хлеб', amountMinor: 8900n },
        { name: 'Молоко', amountMinor: 10000n },
      ],
      categories,
      fallbackCategoryId: 'general',
      // Итог больше суммы позиций (пакет, округление кассы) — разница идёт в «Общее».
      totalMinor: 20000n,
    });

    expect(r.byCategory.reduce((acc, a) => acc + a.amountMinor, 0n)).toBe(20000n);
    expect(r.byCategory.find((a) => a.categoryId === 'general')?.amountMinor).toBe(1100n);
  });

  it('позиций нет — вся сумма в «Общее» одним куском (правило фоллбека)', () => {
    const r = splitReceipt({
      items: [],
      categories,
      fallbackCategoryId: 'general',
      totalMinor: 234050n,
    });

    expect(r.byCategory).toEqual([{ categoryId: 'general', amountMinor: 234050n }]);
    expect(r.confidence).toBe('low');
  });

  it('больше половины суммы не распознано — уверенность низкая, нужен ревью', () => {
    const r = splitReceipt({
      items: [
        { name: 'Молоко', amountMinor: 10000n },
        { name: 'Загадка', amountMinor: 40000n },
      ],
      categories,
      fallbackCategoryId: 'general',
      totalMinor: 50000n,
    });

    expect(r.confidence).toBe('low');
  });

  it('позиции одной категории складываются в одну строку, а не дублируются', () => {
    const r = splitReceipt({
      items: [
        { name: 'Хлеб', amountMinor: 8900n },
        { name: 'Сыр', amountMinor: 30000n },
      ],
      categories,
      fallbackCategoryId: 'general',
      totalMinor: 38900n,
    });

    expect(r.byCategory).toEqual([{ categoryId: 'food', amountMinor: 38900n }]);
  });

  it('итог меньше суммы позиций (скидка на чек) — раскладка сжимается пропорционально', () => {
    const r = splitReceipt({
      items: [
        { name: 'Хлеб', amountMinor: 10000n },
        { name: 'Порошок', amountMinor: 10000n },
      ],
      categories,
      fallbackCategoryId: 'general',
      totalMinor: 10000n, // скидка 50%
    });

    expect(r.byCategory.reduce((acc, a) => acc + a.amountMinor, 0n)).toBe(10000n);
  });

  it('регистр и падежи по началу слова: «Молока 1л» тоже продукты', () => {
    const r = splitReceipt({
      items: [{ name: 'МОЛОКА 1Л', amountMinor: 9000n }],
      categories,
      fallbackCategoryId: 'general',
      totalMinor: 9000n,
    });

    expect(r.byCategory[0]?.categoryId).toBe('food');
  });
});
