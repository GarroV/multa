import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { readXlsx } from '../src/import/xlsx.ts';

/**
 * Чтение .xlsx своими силами (issue #76): из файла нужны ровно три вещи — имена листов,
 * общие строки и ячейки. Готовая библиотека тянула бы десятки транзитивных зависимостей в
 * прод-образ ради этого; свой ридер — сотня строк, но он обязан быть проверен на настоящих
 * ловушках формата, а не «на счастливом пути».
 *
 * Фикстура собрана Excel-совместимым zip'ом и содержит: строки из sharedStrings, числа,
 * inline-строку, пропущенную колонку (C3 без B3) и второй лист.
 */

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/minimal.xlsx', import.meta.url)));

describe('readXlsx', () => {
  test('имена листов читаются в порядке книги', () => {
    const book = readXlsx(fixture);
    expect(book.sheets.map((s) => s.name)).toEqual(['История_Затраты', 'Словарь']);
  });

  test('строки из sharedStrings подставляются, числа остаются числами', () => {
    const [journal] = readXlsx(fixture).sheets;
    expect(journal!.rows[0]).toEqual(['Дата', 'Категория', 'Сумма']);
    expect(journal!.rows[1]).toEqual(['44896', 'Транспорт', '130']);
  });

  test('пропущенная колонка не сдвигает остальные', () => {
    // В файле у третьей строки нет ячейки B: без учёта ссылки «C3» сумма уехала бы в категорию.
    const [journal] = readXlsx(fixture).sheets;
    expect(journal!.rows[2]).toEqual(['44897', '', '250.5']);
  });

  test('inline-строки читаются наравне с общими', () => {
    const [journal] = readXlsx(fixture).sheets;
    expect(journal!.rows[3]?.[0]).toBe('строкой');
  });

  test('второй лист доступен по имени', () => {
    const book = readXlsx(fixture);
    const dict = book.sheets.find((s) => s.name === 'Словарь')!;
    expect(dict.rows[0]?.[0]).toBe('Гигиена');
    expect(dict.rows[1]?.[0]).toBe('Зубная паста');
  });

  test('не-xlsx отвергается понятной ошибкой, а не падением на разборе', () => {
    expect(() => readXlsx(Buffer.from('это не таблица'))).toThrow(/not_a_zip|not_xlsx/);
  });

  test('пустой буфер тоже отвергается', () => {
    expect(() => readXlsx(Buffer.alloc(0))).toThrow();
  });
});

describe('файлы, как их пишет Excel', () => {
  /*
   * Настоящие .xlsx часто пишутся потоково: в локальной шапке записи размеры нулевые, а реальные
   * лежат в data descriptor после данных. Первая версия ридера брала размер оттуда и падала на
   * файлах основателя с Z_BUF_ERROR — то есть работала только на фикстуре, собранной питоном.
   */
  const streamed = readFileSync(
    fileURLToPath(new URL('./fixtures/data-descriptor.xlsx', import.meta.url)),
  );

  test('читается запись с нулевыми размерами в локальной шапке', () => {
    const book = readXlsx(streamed);
    expect(book.sheets[0]?.name).toBe('Лист');
    expect(book.sheets[0]?.rows[0]).toEqual(['Дата', 'Сумма']);
    expect(book.sheets[0]?.rows[1]).toEqual(['44896', '777.77']);
  });
});
