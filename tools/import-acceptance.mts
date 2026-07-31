/**
 * Приёмка ядра импорта на настоящих таблицах основателя (`reference-data/`, приватные — в .gitignore).
 *
 * Запуск: `npx tsx tools/import-acceptance.mts` из корня. Без файлов не работает, поэтому в CI не
 * ходит: там ядро проверяется юнит-тестами на тех же формах данных. Смысл скрипта — приёмка на
 * реальном объёме (около 4800 строк за четыре года), где и вылезли оба дефекта первой версии:
 * служебная строка ритма попадала в статьи, а медиана редких платежей выходила нулём.
 *
 * Наружу скрипт печатает только агрегаты (число строк, сумму, доли) — сами позиции не выводит.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  parseSpendJournal,
  parseCategoryDictionary,
  parseMasterGrid,
} from './packages/core/src/importXlsx.ts';

/** Читает лист xlsx как матрицу строк через python (zip+xml уже есть в системе). */
function sheet(file, index) {
  const script = `
import zipfile, json, sys
from xml.etree import ElementTree as ET
NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
z=zipfile.ZipFile(sys.argv[1]); shared=[]
if 'xl/sharedStrings.xml' in z.namelist():
    for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall(NS+'si'):
        shared.append(''.join(t.text or '' for t in si.iter(NS+'t')))
root=ET.fromstring(z.read('xl/worksheets/sheet'+sys.argv[2]+'.xml'))
out=[]
for row in root.iter(NS+'row'):
    cells=[]
    for c in row.findall(NS+'c'):
        v=c.find(NS+'v'); text=''
        if v is not None:
            text = shared[int(v.text)] if c.get('t')=='s' else (v.text or '')
        ref=c.get('r') or ''
        col=''.join(ch for ch in ref if ch.isalpha())
        idx=0
        for ch in col: idx = idx*26 + (ord(ch)-64)
        while len(cells) < idx-1: cells.append('')
        cells.append(text)
    out.append(cells)
print(json.dumps(out))
`;
  return JSON.parse(
    execFileSync('python3', ['-c', script, file, String(index)], { maxBuffer: 256 * 1024 * 1024 }),
  );
}

const journal = parseSpendJournal(sheet('reference-data/Финмодель основная.xlsx', 1), {
  currency: 'RUB',
});
const dict = parseCategoryDictionary(sheet('reference-data/Финмодель основная.xlsx', 3));
const grid = parseMasterGrid(sheet('reference-data/Кетчуп в Химках.xlsx', 1), { currency: 'RUB' });

const total = journal.rows.reduce((s, r) => s + r.amountMinor, 0n);
const matched = journal.rows.filter((r) => r.item && dict.has(r.item.toLowerCase())).length;
const cats = new Set(journal.rows.map((r) => r.category).filter(Boolean));

console.log(
  'ЖУРНАЛ: строк',
  journal.rows.length,
  '| отброшено',
  journal.skipped.length,
  '| сумма',
  (Number(total) / 100).toLocaleString('ru-RU'),
  'RUB',
);
console.log('  период:', journal.rows[0]?.occurredOn, '→', journal.rows.at(-1)?.occurredOn);
console.log(
  '  категорий в журнале:',
  cats.size,
  '| позиций в словаре:',
  dict.size,
  '| позиций журнала опознано словарём:',
  matched,
  `(${((matched / journal.rows.length) * 100).toFixed(1)}%)`,
);
console.log(
  '  причины отбрасывания:',
  [...new Set(journal.skipped.map((s) => s.reason))].join(', ') || 'нет',
);
console.log('МАСТЕР-СЕТКА: периодов', grid.periods.length, '| статей', grid.lines.length);
console.log(
  '  доход по периодам (первые 3):',
  grid.income?.amountsMinor.slice(0, 3).map((v) => Number(v) / 100),
);
console.log(
  '  статьи с медианой:',
  grid.lines
    .slice(0, 6)
    .map((l) => `${l.name}=${Number(l.medianMinor) / 100}`)
    .join(', '),
);
