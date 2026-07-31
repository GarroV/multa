import { exponentOf } from './money.ts';

/**
 * Разбор таблиц, из которых человек переезжает в Multa (docs/00-vision §Референс-данные).
 *
 * Два формата, оба реальные:
 * 1. **Журнал позиций** («Финмодель основная», лист «История_Затраты»): дата, категория, продукт,
 *    цена, количество, сумма, комментарий. Плюс лист «Словарь» — готовая карта «позиция →
 *    категория», по которой работает автокатегоризация.
 * 2. **Мастер-сетка по полумесяцам** («Кетчуп в Химках»): столбцы — периоды выплат, строки —
 *    статьи, первая строка данных — доход.
 *
 * Здесь только чистый разбор: ячейки приходят матрицей строк, потому что чтение zip/xml — работа
 * api, а смысл таблицы — доменное правило, которое обязано проверяться на приёмочных данных.
 *
 * Правило денег соблюдается буквально: суммы становятся minor units через строковый разбор, без
 * умножения float на float (правило 1).
 */

export type Cell = string | number | null | undefined;
export type SheetRows = readonly (readonly Cell[])[];

/** Excel считает 1900 год високосным, поэтому серийная дата сдвинута относительно 1899-12-30. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export function excelSerialToISO(value: Cell): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // Дробная часть — время внутри суток; для даты она не нужна.
  const days = Math.floor(raw);
  const iso = new Date(EXCEL_EPOCH_MS + days * DAY_MS).toISOString().slice(0, 10);
  // Таблицы до 1990-го — почти наверняка не дата, а число, случайно попавшее в колонку даты.
  return iso >= '1990-01-01' ? iso : null;
}

/**
 * Денежная строка → minor units. Пробелы-разделители разрядов и запятая как десятичный разделитель
 * — норма для русских таблиц. Лишние знаки округляются к младшей единице валюты: отбрасывать их
 * молча значило бы терять копейки на каждой строке.
 */
export function parseAmount(value: Cell, currency: string): bigint | null {
  if (value === null || value === undefined) return null;
  const raw = String(value)
    .replace(/ | |\s/g, '')
    .replace(',', '.')
    .trim();
  if (raw === '' || !/^-?\d+(\.\d+)?$/.test(raw)) return null;

  const exp = exponentOf(currency);
  const negative = raw.startsWith('-');
  const [whole, frac = ''] = raw.replace('-', '').split('.');
  const padded = (frac + '0'.repeat(exp + 1)).slice(0, exp + 1);
  const scaled = BigInt(whole || '0') * 10n ** BigInt(exp + 1) + BigInt(padded || '0');
  // Округление к ближайшей младшей единице: последняя цифра — «половинка».
  const rounded = (scaled + 5n) / 10n;
  return negative ? -rounded : rounded;
}

const JOURNAL_HEADERS = {
  date: ['дата', 'date'],
  category: ['категория', 'category'],
  item: ['продукт', 'позиция', 'товар', 'item'],
  total: ['сумма', 'итого', 'total', 'amount'],
  note: ['комментарий', 'примечание', 'note', 'comment'],
} as const;

function normalize(cell: Cell): string {
  return String(cell ?? '')
    .trim()
    .toLowerCase();
}

interface JournalColumns {
  date: number;
  category: number;
  item: number;
  total: number;
  note: number;
  headerRow: number;
}

/** Заголовок ищем по названиям колонок: у выгрузок сверху бывает шапка отчёта и пустые строки. */
function findJournalColumns(rows: SheetRows): JournalColumns {
  for (let r = 0; r < Math.min(rows.length, 20); r += 1) {
    const cells = (rows[r] ?? []).map(normalize);
    const find = (variants: readonly string[]): number =>
      cells.findIndex((c) => variants.some((v) => c === v));
    const date = find(JOURNAL_HEADERS.date);
    const total = find(JOURNAL_HEADERS.total);
    if (date >= 0 && total >= 0) {
      return {
        date,
        total,
        category: find(JOURNAL_HEADERS.category),
        item: find(JOURNAL_HEADERS.item),
        note: find(JOURNAL_HEADERS.note),
        headerRow: r,
      };
    }
  }
  throw new Error('journal header not found: нужны колонки «Дата» и «Сумма»');
}

export interface JournalRow {
  occurredOn: string;
  /** null — категории в таблице нет; такая трата ложится в «Общее», как ручной «крупный мазок». */
  category: string | null;
  item: string | null;
  amountMinor: bigint;
  note: string | null;
  /** Номер строки в листе (1-based) — чтобы человек мог найти её в своём файле. */
  sourceRow: number;
}

export interface SkippedRow {
  sourceRow: number;
  reason: 'no_date' | 'no_amount';
}

export interface JournalParse {
  rows: JournalRow[];
  skipped: SkippedRow[];
}

/**
 * Журнал позиций → траты. Сумма берётся из колонки «Сумма»: цена и количество в таблице
 * справочные, а итог человек мог поправить руками, и правда — в итоге.
 */
export function parseSpendJournal(
  rows: SheetRows,
  opts: { readonly currency: string },
): JournalParse {
  const cols = findJournalColumns(rows);
  const parsed: JournalRow[] = [];
  const skipped: SkippedRow[] = [];

  for (let r = cols.headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    if (row.every((c) => normalize(c) === '')) continue;
    const sourceRow = r + 1;

    const occurredOn = excelSerialToISO(row[cols.date]);
    if (!occurredOn) {
      skipped.push({ sourceRow, reason: 'no_date' });
      continue;
    }
    const amountMinor = parseAmount(row[cols.total], opts.currency);
    if (amountMinor === null || amountMinor === 0n) {
      skipped.push({ sourceRow, reason: 'no_amount' });
      continue;
    }

    const text = (idx: number): string | null => {
      if (idx < 0) return null;
      const value = String(row[idx] ?? '').trim();
      return value === '' ? null : value;
    };
    parsed.push({
      occurredOn,
      category: text(cols.category),
      item: text(cols.item),
      amountMinor,
      note: text(cols.note),
      sourceRow,
    });
  }

  return { rows: parsed, skipped };
}

/**
 * Лист «Словарь» → карта «позиция → категория». Колонка озаглавлена категорией, ячейки под ней —
 * её позиции. Ключи в нижнем регистре: в журнале и словаре регистр совпадает не всегда.
 */
export function parseCategoryDictionary(rows: SheetRows): Map<string, string> {
  const map = new Map<string, string>();
  const header = rows[0] ?? [];
  for (let c = 0; c < header.length; c += 1) {
    const category = String(header[c] ?? '').trim();
    if (category === '') continue;
    for (let r = 1; r < rows.length; r += 1) {
      const item = String(rows[r]?.[c] ?? '').trim();
      if (item === '') continue;
      // Первое вхождение выигрывает: одна позиция не может принадлежать двум категориям.
      if (!map.has(item.toLowerCase())) map.set(item.toLowerCase(), category);
    }
  }
  return map;
}

export interface MasterLine {
  name: string;
  amountsMinor: bigint[];
  /**
   * Медиана по периодам, **в которых платили**: статья, которую платят раз в несколько периодов,
   * иначе получала бы медиану 0 и обнулялась при переносе в план (найдено на реальном файле).
   */
  medianMinor: bigint;
  /** В скольких периодах по статье вообще платили — по этому видно, регулярная она или разовая. */
  paidPeriods: number;
}

export interface MasterGridParse {
  /** Даты периодов из первой строки. */
  periods: string[];
  /** Строка дохода: в продукте это отдельная сущность, а не статья расходов. */
  income: MasterLine | null;
  lines: MasterLine[];
}

const INCOME_NAMES = ['доход', 'income', 'зарплата'];

function median(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

/**
 * Мастер-сетка «статьи × периоды выплат» → периоды и статьи. Пустая ячейка — ноль (в периоде
 * ничего не платили), а статья, пустая во всех периодах, отбрасывается: это заготовка, а не план.
 */
export function parseMasterGrid(
  rows: SheetRows,
  opts: { readonly currency: string },
): MasterGridParse {
  const header = rows[0] ?? [];
  const periodCols: number[] = [];
  const periods: string[] = [];
  for (let c = 1; c < header.length; c += 1) {
    const iso = excelSerialToISO(header[c]);
    if (iso) {
      periodCols.push(c);
      periods.push(iso);
    }
  }

  let income: MasterLine | null = null;
  const lines: MasterLine[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const name = String(row[0] ?? '').trim();
    if (name === '') continue;
    /*
     * Служебная строка ритма: у неё в первой ячейке дата, а в периодах — числа месяца (10 и 25).
     * Она не статья, хотя и выглядит как строка данных — на приёмке попадала в план с именем
     * «46222» и медианой 10 копеек.
     */
    if (excelSerialToISO(row[0]) !== null) continue;

    const amountsMinor = periodCols.map((c) => parseAmount(row[c], opts.currency) ?? 0n);
    const paid = amountsMinor.filter((v) => v !== 0n);
    if (paid.length === 0) continue;

    const line: MasterLine = {
      name,
      amountsMinor,
      medianMinor: median(paid),
      paidPeriods: paid.length,
    };
    if (INCOME_NAMES.includes(name.toLowerCase())) {
      income ??= line;
      continue;
    }
    lines.push(line);
  }

  return { periods, income, lines };
}
