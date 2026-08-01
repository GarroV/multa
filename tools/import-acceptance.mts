/**
 * Приёмка импорта на настоящих таблицах основателя (`reference-data/`, приватные — в .gitignore).
 *
 * Запуск: `npx tsx tools/import-acceptance.mts` из корня. Без файлов не работает, поэтому в CI не
 * ходит: там путь проверяется юнит-тестами на тех же формах данных. Смысл — приёмка на реальном
 * объёме (около 4800 строк за четыре года), где вылезли три дефекта, которых не было видно на
 * синтетике: служебная строка ритма в статьях, нулевая медиана редких платежей и потеря строк без
 * проставленного итога.
 *
 * Первая версия скрипта читала файлы питоном и **сдвигала колонки** на строках с пропущенными
 * ячейками, засчитывая цену как сумму: «эталон» показывал 4822 строки и 4 987 189 ₽, что было
 * неправдой. Теперь путь ровно тот же, что в продукте: наш ридер → ядро разбора.
 *
 * Наружу печатаются только агрегаты — сами позиции не выводятся.
 */
import { readFileSync } from 'node:fs';
import { readXlsx } from '../apps/api/src/import/xlsx.ts';
import {
  parseCategoryDictionary,
  parseMasterGrid,
  parseSpendJournal,
} from '../packages/core/src/importXlsx.ts';

const fin = readXlsx(readFileSync('reference-data/Финмодель основная.xlsx'));
const journalSheet = fin.sheets.find((s) => s.name === 'История_Затраты');
const dictSheet = fin.sheets.find((s) => s.name === 'Словарь');
if (!journalSheet || !dictSheet) throw new Error('в файле нет ожидаемых листов');

const journal = parseSpendJournal(journalSheet.rows, { currency: 'RUB' });
const dict = parseCategoryDictionary(dictSheet.rows);
const total = journal.rows.reduce((sum, r) => sum + r.amountMinor, 0n);
const named = journal.rows.filter((r) => r.item !== null);
const matched = named.filter((r) => dict.has(r.item!.toLowerCase())).length;
const withCategory = journal.rows.filter((r) => r.category !== null).length;
const categories = new Set(journal.rows.map((r) => r.category).filter(Boolean));

console.log('ЖУРНАЛ:', journal.rows.length, 'строк | отброшено', journal.skipped.length);
console.log(
  '  сумма',
  (Number(total) / 100).toLocaleString('ru-RU'),
  'RUB |',
  journal.rows[0]?.occurredOn,
  '→',
  journal.rows.at(-1)?.occurredOn,
);
/*
 * Главный сигнал переноса — колонка «Категория»: она заполнена почти в каждой строке. Словарь
 * нужен только там, где категории нет, поэтому его покрытие честно считать от строк, у которых
 * вообще есть название позиции (у половины строк файла в этой колонке лежит число).
 */
console.log(
  '  с категорией',
  `${((withCategory / journal.rows.length) * 100).toFixed(1)}%`,
  `(${categories.size} категорий)`,
);
console.log(
  '  с названием позиции',
  named.length,
  '| словарь',
  dict.size,
  'позиций | опознаёт',
  `${named.length ? ((matched / named.length) * 100).toFixed(1) : '0'}%`,
);

const ketchup = readXlsx(readFileSync('reference-data/Кетчуп в Химках.xlsx'));
const grid = parseMasterGrid(ketchup.sheets[0]!.rows, { currency: 'RUB' });
console.log('МАСТЕР-СЕТКА:', grid.periods.length, 'периодов |', grid.lines.length, 'статей');
console.log(
  '  медианы:',
  grid.lines
    .slice(0, 6)
    .map((l) => `${l.name} ${Number(l.medianMinor) / 100} (платили ${l.paidPeriods})`)
    .join(' · '),
);
