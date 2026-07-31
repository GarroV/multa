/**
 * Раскладка чека по категориям (01-domain-model §Receipt): many positions → many categories.
 *
 * Железные свойства, закреплённые тестами:
 * 1. **Сумма раскладки всегда равна итогу чека.** Деньги не исчезают и не появляются: если
 *    позиции не сходятся с итогом (пакет на кассе, скидка на чек), разница честно уходит в
 *    «Общее» или раскладка сжимается пропорционально.
 * 2. **Не распознали — в «Общее», а не в тишину.** Правило фоллбека из спеки: вся сумма одним
 *    тапом, без принуждения разбирать позиции.
 * 3. **Уверенность считаем по деньгам, а не по числу позиций:** одна дорогая непонятная строка
 *    важнее пяти дешёвых распознанных, потому что именно она искажает бюджет.
 */

export interface ReceiptItem {
  readonly name: string;
  readonly amountMinor: bigint;
}

export interface SplitCategory {
  readonly id: string;
  readonly name: string;
  /** Слова-приметы; сопоставление по началу слова, регистр не важен. */
  readonly keywords: readonly string[];
}

export interface ReceiptSplit {
  readonly byCategory: readonly { categoryId: string; amountMinor: bigint }[];
  /** low — больше половины суммы не распознано: экран ревью обязателен. */
  readonly confidence: 'high' | 'low';
}

export interface SplitReceiptInput {
  readonly items: readonly ReceiptItem[];
  readonly categories: readonly SplitCategory[];
  /** Куда складывать непонятное — системная категория «Общее». */
  readonly fallbackCategoryId: string;
  /** Итог чека: он первичен, позиции лишь объясняют его состав. */
  readonly totalMinor: bigint;
}

/**
 * Грубый стем: первые 5 букв. Русские падежи («молоко» / «молока») отличаются хвостом, а
 * морфологию тащить в ядро ради чеков — перебор; ошибку легко поправить на экране ревью.
 */
const stem = (word: string): string => (word.length > 5 ? word.slice(0, 5) : word);

/** Первая категория, чьё слово-примета встречается в названии позиции. */
function matchCategory(name: string, categories: readonly SplitCategory[]): string | null {
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const category of categories) {
    for (const keyword of category.keywords) {
      const key = keyword.toLowerCase();
      const hit = words.some(
        (w) => w.startsWith(key) || key.startsWith(w) || (w.length >= 4 && stem(w) === stem(key)),
      );
      if (hit) return category.id;
    }
  }
  return null;
}

export function splitReceipt(input: SplitReceiptInput): ReceiptSplit {
  const { items, categories, fallbackCategoryId, totalMinor } = input;
  if (totalMinor <= 0n) return { byCategory: [], confidence: 'low' };
  if (items.length === 0) {
    return {
      byCategory: [{ categoryId: fallbackCategoryId, amountMinor: totalMinor }],
      confidence: 'low',
    };
  }

  const sums = new Map<string, bigint>();
  let itemsTotal = 0n;
  let matchedMinor = 0n;
  for (const item of items) {
    if (item.amountMinor <= 0n) continue;
    itemsTotal += item.amountMinor;
    const hit = matchCategory(item.name, categories);
    const key = hit ?? fallbackCategoryId;
    if (hit) matchedMinor += item.amountMinor;
    sums.set(key, (sums.get(key) ?? 0n) + item.amountMinor);
  }

  if (itemsTotal === 0n) {
    return {
      byCategory: [{ categoryId: fallbackCategoryId, amountMinor: totalMinor }],
      confidence: 'low',
    };
  }

  const byCategory = [...sums].map(([categoryId, amountMinor]) => ({ categoryId, amountMinor }));

  if (itemsTotal > totalMinor) {
    // Скидка на весь чек: сжимаем пропорционально, остаток от округления — в последнюю строку.
    let distributed = 0n;
    const scaled = byCategory.map((row, index) => {
      if (index === byCategory.length - 1) {
        return { categoryId: row.categoryId, amountMinor: totalMinor - distributed };
      }
      const part = (row.amountMinor * totalMinor) / itemsTotal;
      distributed += part;
      return { categoryId: row.categoryId, amountMinor: part };
    });
    return { byCategory: scaled, confidence: matchedMinor * 2n >= totalMinor ? 'high' : 'low' };
  }

  if (itemsTotal < totalMinor) {
    // Итог больше суммы позиций (пакет, весовой товар) — разницу не теряем.
    const rest = totalMinor - itemsTotal;
    sums.set(fallbackCategoryId, (sums.get(fallbackCategoryId) ?? 0n) + rest);
    const withRest = [...sums].map(([categoryId, amountMinor]) => ({ categoryId, amountMinor }));
    return { byCategory: withRest, confidence: matchedMinor * 2n >= totalMinor ? 'high' : 'low' };
  }

  return { byCategory, confidence: matchedMinor * 2n >= totalMinor ? 'high' : 'low' };
}
