/**
 * Сериализация в CSV (Спринт 6, экспорт данных).
 *
 * Формат выбран не за красоту, а за то, что открывается везде без плясок: Excel, Numbers, Google
 * Sheets, любой скрипт. Человек должен уметь забрать свои деньги из продукта и уйти — это условие
 * доверия, а не подарок.
 *
 * Экранирование по RFC 4180: поле берётся в кавычки, если содержит запятую, кавычку или перевод
 * строки; внутренняя кавычка удваивается. Это не педантизм — в заметках к тратам живут запятые
 * («кофе, большой»), а одна неэкранированная сдвигает строку на колонку, и файл выглядит целым,
 * оставаясь испорченным.
 */

export type CsvValue = string | number | bigint | null | undefined;

/** Ячейка → безопасное поле CSV. Пустое и отсутствующее — пустая ячейка, а не слово «undefined». */
function cell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Строки объектов → CSV. Порядок колонок задаёт `columns`: полагаться на порядок ключей объекта
 * нельзя — он зависит от того, как строка собиралась, и однажды поедет.
 *
 * Разделитель строк — CRLF по RFC 4180: с ним корректно открывают и старые Excel под Windows.
 */
export function toCsv<T extends Record<string, CsvValue>>(
  columns: readonly (keyof T & string)[],
  rows: readonly T[],
): string {
  const head = columns.map(cell).join(',');
  const body = rows.map((row) => columns.map((c) => cell(row[c])).join(','));
  return [head, ...body].join('\r\n');
}
