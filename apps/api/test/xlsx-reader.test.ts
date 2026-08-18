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

/**
 * Минимальная книга вокруг готового XML листа: ловушки формата удобнее проверять разметкой, а не
 * бинарной фикстурой, которую нельзя прочитать глазами при разборе упавшего теста.
 */
function zipOf(sheetXml: string): Buffer {
  const files: { name: string; data: Buffer }[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Лист" sheetId="1"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Транспорт</t></si></sst>',
        'utf8',
      ),
    },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ];

  // Пишем zip без сжатия (stored): ридер такие записи принимает, а тесту не нужен deflate.
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + file.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

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

/**
 * Пустые ячейки со стилем (issue #125).
 *
 * Excel записывает любую отформатированную пустую ячейку самозакрывающимся тегом со ссылкой на
 * стиль: `<c r="I4" s="8"/>`. В настоящем файле владельца таких 650 из 1471 — то есть это не
 * экзотика формата, а его обычное состояние.
 *
 * Жадная регулярка на таком теге уходила во вторую альтернативу и добирала ближайший `</c>`, то
 * есть конец СЛЕДУЮЩЕЙ ячейки: её значение попадало в пустую, а сама она из разбора выпадала.
 * Сверка с сырым XML показала переезд значения на шесть колонок влево. Ошибка молчаливая — числа
 * остаются правдоподобными, поэтому проверять её должен тест, а не глаз.
 */
describe('пустые ячейки со стилем не крадут соседей', () => {
  /** Собирает лист из готового XML: ловушка живёт именно в разметке, а не в данных. */
  function sheetOf(cellsXml: string): string[][] {
    const rows = `<row r="1">${cellsXml}</row>`;
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
    return readXlsx(zipOf(sheet)).sheets[0]!.rows;
  }

  test('одна пустая ячейка перед значением не забирает его себе', () => {
    const rows = sheetOf('<c r="A1" s="8"/><c r="B1"><v>10</v></c>');
    expect(rows[0]).toEqual(['', '10']);
  });

  test('подряд идущие пустые не сдвигают значение влево', () => {
    // Ровно форма из файла владельца: две пустые со стилем, потом значение.
    const rows = sheetOf('<c r="A1" s="8"/><c r="B1" s="8"/><c r="C1" s="8"><v>5000.0</v></c>');
    expect(rows[0]).toEqual(['', '', '5000.0']);
  });

  test('значение остаётся в своей колонке через длинную череду пустых', () => {
    /*
     * В файле владельца 16017 лежит в R4, а прочитано было в L4 — на шесть колонок левее. Столько
     * же пустых воспроизводим здесь: смещение на дальнюю дистанцию и есть худший случай, потому что
     * деньги уезжают в чужой период целиком.
     */
    const empties = ['A', 'B', 'C', 'D', 'E', 'F'].map((col) => `<c r="${col}1" s="9"/>`).join('');
    const rows = sheetOf(`${empties}<c r="G1" s="8"><v>16017.0</v></c>`);
    expect(rows[0]).toEqual(['', '', '', '', '', '', '16017.0']);
  });

  test('пустая строковая ячейка со стилем не крадёт следующую строку', () => {
    const rows = sheetOf('<c r="A1" s="8" t="s"/><c r="B1" t="s"><v>0</v></c>');
    expect(rows[0]).toEqual(['', 'Транспорт']);
  });
});
