/**
 * Подготовка пропущенных строк импорта к показу.
 *
 * Найдено прогоном настоящего файла владельца (5047 строк) 17.08.2026: восемнадцать строк не
 * переехали, а продукт сообщал только их число. Среди них были восемь с суммой, попавшей в колонку
 * «Продукт» — около 14 000 ₽ реальных трат — и одна с битой датой при живой сумме.
 *
 * Число без номеров бесполезно: в пяти тысячах строк человек их не найдёт. Догадываться за него —
 * тоже нельзя: сумма из чужой колонки это предположение, а не данные, и продукт не вправе тихо
 * записать её как факт. Остаётся честное: сказать, где смотреть, и назвать причину.
 */

export interface SkippedRowDto {
  readonly sourceRow: number;
  readonly reason: string;
}

export interface SkippedGroup {
  readonly reason: string;
  /** Номера строк, обрезанные до читаемого числа. */
  readonly rows: number[];
  /** Сколько строк с этой причиной ВСЕГО — обрезка не должна занижать масштаб. */
  readonly total: number;
}

/** Сколько номеров показываем: длиннее подсказка не читается, а короче — уже не помогает искать. */
const SHOWN_ROWS = 10;

export function skippedGroups(skipped: readonly SkippedRowDto[]): SkippedGroup[] {
  const byReason = new Map<string, number[]>();
  for (const row of skipped) {
    const list = byReason.get(row.reason) ?? [];
    list.push(row.sourceRow);
    byReason.set(row.reason, list);
  }

  return [...byReason.entries()].map(([reason, rows]) => {
    // По возрастанию: человек идёт по файлу сверху вниз, а не в порядке нашего разбора.
    const sorted = [...rows].sort((a, b) => a - b);
    return { reason, rows: sorted.slice(0, SHOWN_ROWS), total: sorted.length };
  });
}
