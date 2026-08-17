import { describe, expect, it } from 'vitest';
import { skippedGroups } from './importView.ts';

/**
 * Пропущенные строки импорта называются по номерам, а не одним числом.
 *
 * Найдено прогоном настоящего файла владельца (5047 строк) 17.08.2026: 18 строк не переехали, и
 * среди них восемь с суммой в колонке «Продукт» — около 14 000 ₽ реальных трат — плюс одна с битой
 * датой. Продукт знал и номер строки, и причину (обе приходят в ответе), а показывал «не переедут:
 * 18».
 *
 * В файле из пяти тысяч строк это число бесполезно: найти их человек не может. Угадывать сумму из
 * чужой колонки продукт не вправе — это выдумывание данных. Единственный честный выход — сказать,
 * ГДЕ смотреть.
 */
describe('группы пропущенных строк', () => {
  it('собирает номера по причинам', () => {
    const groups = skippedGroups([
      { sourceRow: 145, reason: 'no_amount' },
      { sourceRow: 298, reason: 'no_amount' },
      { sourceRow: 4876, reason: 'no_date' },
    ]);
    expect(groups).toEqual([
      { reason: 'no_amount', rows: [145, 298], total: 2 },
      { reason: 'no_date', rows: [4876], total: 1 },
    ]);
  });

  it('номера идут по возрастанию: человек ищет их сверху вниз', () => {
    const groups = skippedGroups([
      { sourceRow: 900, reason: 'no_amount' },
      { sourceRow: 12, reason: 'no_amount' },
    ]);
    expect(groups[0]!.rows).toEqual([12, 900]);
  });

  it('длинный список обрезается, но счёт остаётся полным', () => {
    /*
     * Двадцать номеров в строке подсказки не читаются. Показываем первые десять и говорим общее
     * число — иначе обрезка соврала бы про размер проблемы.
     */
    const many = Array.from({ length: 20 }, (_, i) => ({ sourceRow: i + 1, reason: 'no_amount' }));
    const groups = skippedGroups(many);
    expect(groups[0]!.rows).toHaveLength(10);
    expect(groups[0]!.total).toBe(20);
  });

  it('пустой список не даёт групп', () => {
    expect(skippedGroups([])).toEqual([]);
  });
});
