import { describe, expect, it } from 'vitest';
import {
  excelSerialToISO,
  parseAmount,
  parseCategoryDictionary,
  parseMasterGrid,
  parseSpendJournal,
} from './importXlsx.ts';

/**
 * Разбор реальных таблиц основателя (docs/00-vision: «Финмодель основная» и «Кетчуп в Химках»).
 * Формы данных взяты с фактических листов, а не выдуманы: журнал позиций с колонками
 * «Дата / Категория / Продукт / Стоимость / Количество / Сумма / Комментарий», лист «Словарь», где
 * каждая колонка — категория, а ячейки под ней — её продукты, и мастер-сетка по полумесяцам.
 *
 * Ядро принимает уже прочитанные матрицы ячеек: чтение zip/xml — работа api, а разбор смысла —
 * чистая функция, которую можно проверить на приёмочных данных.
 */

describe('excelSerialToISO', () => {
  it('переводит серийную дату Excel в ISO', () => {
    // Проверено по фактическим файлам основателя: 44896 = 1 декабря 2022, 45566 = 1 октября 2024
    // (Excel считает 1900 год високосным, поэтому эпоха — 1899-12-30, а не 1900-01-01).
    expect(excelSerialToISO(44896)).toBe('2022-12-01');
    expect(excelSerialToISO(45566)).toBe('2024-10-01');
  });

  it('принимает строку и дробное значение (время в дате)', () => {
    expect(excelSerialToISO('44896.0')).toBe('2022-12-01');
    expect(excelSerialToISO(44896.75)).toBe('2022-12-01');
  });

  it('мусор и невозможные даты отбрасывает, а не превращает в 1899 год', () => {
    expect(excelSerialToISO('не дата')).toBeNull();
    expect(excelSerialToISO(0)).toBeNull();
    expect(excelSerialToISO(-5)).toBeNull();
  });
});

describe('parseAmount', () => {
  it('деньги превращаются в minor units без float', () => {
    expect(parseAmount('139.99', 'RUB')).toBe(13_999n);
    expect(parseAmount('130', 'RUB')).toBe(13_000n);
    // Запятая как разделитель — обычное дело в русских таблицах.
    expect(parseAmount('1 520,50', 'RUB')).toBe(152_050n);
  });

  it('лишние знаки округляются к копейке, а не отбрасываются молча', () => {
    expect(parseAmount('339.984', 'RUB')).toBe(33_998n);
    expect(parseAmount('339.985', 'RUB')).toBe(33_999n);
  });

  it('валюты без копеек считаются по своей экспоненте: 8200 JPY это 8200 minor', () => {
    // JPY и KRW — exponent 0. У RSD, вопреки бытовому ощущению, два знака (пара), и 8200 RSD =
    // 820 000 minor — ровно та ловушка, из-за которой в money.ts запрещено хардкодить «÷100».
    expect(parseAmount('8200', 'JPY')).toBe(8_200n);
    expect(parseAmount('8200', 'RSD')).toBe(820_000n);
  });

  it('пустое и нечисловое — null, а не ноль', () => {
    expect(parseAmount('', 'RUB')).toBeNull();
    expect(parseAmount('—', 'RUB')).toBeNull();
    expect(parseAmount('итого', 'RUB')).toBeNull();
  });
});

describe('parseSpendJournal', () => {
  const rows = [
    ['Дата', 'Категория', 'Продукт', 'Стоимость', 'Количество', 'Сумма', 'Комментарий'],
    ['44896.0', 'Транспорт', 'Автобус', '65.0', '2.0', '130', ''],
    ['44896.0', 'Продукты', 'Помидоры', '139.99', '1.0', '139.99', 'на борщ'],
    ['44897.0', 'Продукты', 'Говядина', '539.99', '1.0', '539.99', ''],
  ];

  it('строки становятся тратами с датой, категорией, позицией и суммой', () => {
    const result = parseSpendJournal(rows, { currency: 'RUB' });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual({
      occurredOn: '2022-12-01',
      category: 'Транспорт',
      item: 'Автобус',
      amountMinor: 13_000n,
      note: null,
      sourceRow: 2,
    });
    expect(result.rows[1]?.note).toBe('на борщ');
  });

  it('сумма берётся из колонки «Сумма», а не из цены за единицу', () => {
    // 65 × 2 = 130: цена и количество нужны только для проверки, итог считает таблица.
    expect(parseSpendJournal(rows, { currency: 'RUB' }).rows[0]?.amountMinor).toBe(13_000n);
  });

  it('строки без даты или суммы уходят в отброшенные с причиной, а не теряются', () => {
    const dirty = [
      rows[0]!,
      ['', 'Продукты', 'Хлеб', '50', '1', '50', ''],
      ['44896.0', 'Продукты', 'Молоко', '', '', 'итого', ''],
      ['44896.0', '', 'Без категории', '10', '1', '10', ''],
    ];
    const result = parseSpendJournal(dirty, { currency: 'RUB' });
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]).toMatchObject({ sourceRow: 2, reason: 'no_date' });
    expect(result.skipped[1]).toMatchObject({ sourceRow: 3, reason: 'no_amount' });
    // Трата без категории — не мусор: она попадёт в «Общее», как ручной ввод «крупным мазком».
    expect(result.rows[0]?.category).toBeNull();
  });

  it('заголовок ищется по названиям колонок, а не по номеру строки', () => {
    const shifted = [['Отчёт по затратам'], [], rows[0]!, rows[1]!];
    const result = parseSpendJournal(shifted, { currency: 'RUB' });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.category).toBe('Транспорт');
  });

  it('без узнаваемого заголовка — честная ошибка, а не пустой результат', () => {
    expect(() =>
      parseSpendJournal(
        [
          ['a', 'b'],
          ['1', '2'],
        ],
        { currency: 'RUB' },
      ),
    ).toThrow(/header/);
  });
});

describe('parseCategoryDictionary', () => {
  const dict = [
    ['Декор', 'Гигиена', 'Здоровье', 'Неизвестное'],
    ['Растения и утварь', 'Бритвенный станок', 'Витамины', ''],
    ['', 'Зубная паста', 'Врачи', ''],
  ];

  it('колонка — категория, ячейки под ней — её позиции', () => {
    const map = parseCategoryDictionary(dict);
    expect(map.get('зубная паста')).toBe('Гигиена');
    expect(map.get('витамины')).toBe('Здоровье');
    expect(map.get('растения и утварь')).toBe('Декор');
  });

  it('пустые ячейки и пустые колонки не создают мусорных правил', () => {
    const map = parseCategoryDictionary(dict);
    expect(map.has('')).toBe(false);
    expect([...map.values()]).not.toContain('Неизвестное');
  });

  it('сопоставление регистронезависимое: в журнале и словаре регистр не совпадает', () => {
    const map = parseCategoryDictionary([['Гигиена'], ['Зубная Паста']]);
    expect(map.get('зубная паста')).toBe('Гигиена');
  });
});

describe('parseMasterGrid', () => {
  // Форма «Кетчуп в Химках»: первая строка — даты периодов, вторая — числа месяца, дальше статьи.
  const grid = [
    ['Месяц', '45566.0', '45597.0', '45627.0'],
    ['46222', '10.0', '25.0', '10.0'],
    ['Доход', '110417.0', '46980.0', '101246.0'],
    ['Озон', '11507.0', '5000.0', '6507.0'],
    ['Сбер', '10000.0', '10000.0', ''],
    ['Оборудование', '', '', ''],
  ];

  it('периоды читаются как даты, а строки — как статьи с суммами', () => {
    const result = parseMasterGrid(grid, { currency: 'RUB' });
    expect(result.periods).toEqual(['2024-10-01', '2024-11-01', '2024-12-01']);
    const ozon = result.lines.find((l) => l.name === 'Озон')!;
    expect(ozon.amountsMinor).toEqual([1_150_700n, 500_000n, 650_700n]);
  });

  it('доход отделён от расходных статей: это разные сущности продукта', () => {
    const result = parseMasterGrid(grid, { currency: 'RUB' });
    expect(result.income?.amountsMinor[0]).toBe(11_041_700n);
    expect(result.lines.map((l) => l.name)).not.toContain('Доход');
  });

  it('пустые ячейки — ноль, а полностью пустая статья отбрасывается', () => {
    const result = parseMasterGrid(grid, { currency: 'RUB' });
    const sber = result.lines.find((l) => l.name === 'Сбер')!;
    expect(sber.amountsMinor).toEqual([1_000_000n, 1_000_000n, 0n]);
    expect(result.lines.map((l) => l.name)).not.toContain('Оборудование');
  });

  it('медиана статьи по периодам — основа переноса в план', () => {
    const result = parseMasterGrid(grid, { currency: 'RUB' });
    expect(result.lines.find((l) => l.name === 'Озон')?.medianMinor).toBe(650_700n);
  });

  it('служебная строка ритма (числа месяца) не становится статьёй', () => {
    // В настоящем файле первая ячейка этой строки — дата, а дальше 10 и 25: это ритм выплат.
    // На приёмке она попадала в статьи с именем «46222» и медианой 10 копеек.
    const result = parseMasterGrid(grid, { currency: 'RUB' });
    expect(result.lines.map((l) => l.name)).not.toContain('46222');
  });

  it('медиана считается по периодам, где платили: редкий платёж не получает ноль', () => {
    // Статья, которую платят раз в несколько периодов, имеет медиану своего платежа, а не 0 —
    // иначе перенос в план обнулял бы всё, что платится нерегулярно (найдено на реальном файле).
    const sparse = [
      ['Месяц', '45566.0', '45597.0', '45627.0', '45658.0'],
      ['Страховка', '', '12000.0', '', ''],
      ['Аренда', '30000.0', '30000.0', '30000.0', '30000.0'],
    ];
    const result = parseMasterGrid(sparse, { currency: 'RUB' });
    expect(result.lines.find((l) => l.name === 'Страховка')?.medianMinor).toBe(1_200_000n);
    expect(result.lines.find((l) => l.name === 'Аренда')?.medianMinor).toBe(3_000_000n);
    // Сколько периодов реально платили — важно для решения «регулярно или разово».
    expect(result.lines.find((l) => l.name === 'Страховка')?.paidPeriods).toBe(1);
  });
});
