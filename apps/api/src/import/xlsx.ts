import { inflateRawSync } from 'node:zlib';

/**
 * Минимальное чтение .xlsx (issue #76).
 *
 * Из файла нужны ровно три вещи: имена листов, таблица общих строк и ячейки. Готовая библиотека
 * (exceljs) умеет писать, стилизовать и считать формулы — и тянет в прод-образ десятки
 * транзитивных зависимостей ради того, что здесь занимает сотню строк. Поэтому читаем сами:
 * распаковка zip через встроенный zlib, разбор SpreadsheetML — регулярками по нужным узлам.
 *
 * Сознательные ограничения (лучше отказать явно, чем прочитать неверно):
 * - только несжатые и deflate-записи; zip64, шифрование и «многотомники» отвергаются;
 * - формулы не вычисляются — берётся кэшированное значение `<v>`, то есть то, что человек видел;
 * - даты остаются серийными числами Excel: их смысл знает ядро (`excelSerialToISO`).
 */

export interface XlsxSheet {
  name: string;
  /** Матрица ячеек как строки: смысл (даты, деньги) разбирает ядро. */
  rows: string[][];
}

export interface XlsxBook {
  sheets: XlsxSheet[];
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Распаковывает нужные записи zip. Читаем central directory, а не «сканируем локальные шапки». */
function readZip(buffer: Buffer, wanted: (name: string) => boolean): ZipEntry[] {
  if (buffer.length < 22) throw new Error('not_a_zip');

  // End of central directory лежит в конце и может быть прикрыт комментарием — ищем с конца.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65_557; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not_a_zip');

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error('not_xlsx: zip64 не поддерживается');

  const entries: ZipEntry[] = [];
  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > buffer.length) throw new Error('not_a_zip');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    // Размеры берём здесь, а не из локальной шапки: при потоковой записи (так пишет Excel) там
    // нули, а настоящие значения лежат в data descriptor после данных. Первая версия ридера
    // читала локальную шапку и падала на настоящих файлах с Z_BUF_ERROR.
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (!wanted(name)) continue;
    entries.push({ name, data: readLocalEntry(buffer, localOffset, compressedSize, name) });
  }
  return entries;
}

function readLocalEntry(
  buffer: Buffer,
  localOffset: number,
  compressedSize: number,
  name: string,
): Buffer {
  if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('not_a_zip');
  const flags = buffer.readUInt16LE(localOffset + 6);
  // Бит 0 — шифрование: расшифровать мы не сможем и не должны делать вид, что прочитали.
  if ((flags & 0x1) !== 0) throw new Error(`not_xlsx: ${name} зашифрован`);
  const method = buffer.readUInt16LE(localOffset + 8);
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + compressedSize);

  if (method === 0) return Buffer.from(raw);
  if (method === 8) return inflateRawSync(raw);
  throw new Error(`not_xlsx: способ сжатия ${method} не поддерживается`);
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(value: string): string {
  return value
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

/** Текст узла со всеми вложенными `<t>`: у форматированной строки их несколько. */
function textOf(xml: string): string {
  const parts = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1] ?? ''));
  return parts.join('');
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1] ?? ''));
}

/** «C3» → 2: индекс колонки. Без него пропущенная ячейка сдвигала бы соседние значения. */
function columnIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, '').toUpperCase();
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    /*
     * Атрибуты ленивым квантификатором (issue #125). Жадный `[^>]*` съедал `/` перед `>`, поэтому
     * на самозакрывающейся пустой ячейке (`<c r="I4" s="8"/>` — так Excel пишет любую
     * отформатированную пустую) первая альтернатива не срабатывала: разбор уходил во вторую и
     * добирал ближайший `</c>`, то есть конец СЛЕДУЮЩЕЙ ячейки. Её значение попадало в пустую, а
     * сама она из строки выпадала — на настоящем файле деньги переезжали на шесть колонок влево,
     * молча и правдоподобно.
     */
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

      let value = '';
      if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1');
        value = shared[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else {
        // Формулы не считаем: берём кэшированное значение — ровно то, что человек видел в таблице.
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** Имена листов в порядке книги: разбор смысла зависит от того, какой лист выбрал человек. */
function parseSheetNames(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*\/?>/g)].map((m) =>
    unescapeXml(m[1] ?? ''),
  );
}

export function readXlsx(buffer: Buffer): XlsxBook {
  const wanted = (name: string): boolean =>
    name === 'xl/workbook.xml' ||
    name === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name);

  const entries = readZip(buffer, wanted);
  const byName = new Map(entries.map((e) => [e.name, e.data.toString('utf8')]));
  const workbook = byName.get('xl/workbook.xml');
  if (!workbook) throw new Error('not_xlsx: нет xl/workbook.xml');

  const names = parseSheetNames(workbook);
  const shared = parseSharedStrings(byName.get('xl/sharedStrings.xml'));

  const sheets: XlsxSheet[] = [];
  for (let i = 0; i < names.length; i += 1) {
    const xml = byName.get(`xl/worksheets/sheet${i + 1}.xml`);
    // Лист без данных (например, только диаграмма) отдаём пустым, а не роняем чтение книги.
    sheets.push({ name: names[i] ?? `Sheet${i + 1}`, rows: xml ? parseSheet(xml, shared) : [] });
  }
  return { sheets };
}
