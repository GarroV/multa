import { formatDate, formatMinor } from './format.ts';

/**
 * Строка «понял так» под умным полем ввода (issue #100, расширена по #138).
 *
 * Разбор фразы молча раскладывает поля формы, и подмена валюты или даты остаётся незамеченной:
 * человек проверяет сумму, а остальное принимает на веру. Эта строка — единственное место, где
 * видно, ЧТО именно уйдёт в запись.
 *
 * Заметка входит в сводку намеренно. Владелец спросил: «в чём смысл писать название и потом ещё и
 * заметка? как заметка будет отображаться?» — и был прав дважды: сама фраза нигде не сохраняется, а
 * заметку, вытащенную из неё разбором, было негде увидеть до отправки. Показать её здесь дешевле,
 * чем объяснять подписями, чем два поля отличаются.
 */

export interface ParsedForSummary {
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredOn: string;
  readonly categoryName?: string | null;
  readonly note?: string | null;
}

export function parsedSummary(parsed: ParsedForSummary, locale: string): string {
  const parts = [
    `${formatMinor(parsed.amountMinor, parsed.currency, locale)} ${parsed.currency}`,
    formatDate(parsed.occurredOn),
  ];
  if (parsed.categoryName) parts.push(parsed.categoryName);
  /*
   * Заметка в кавычках, а не просто через точку: без них «250 · 20.08 · Кафе · кофе на вынос»
   * читается как ещё одна категория. Пробелы обрезаем — заметка из одних пробелов это не заметка.
   */
  const note = parsed.note?.trim();
  if (note) parts.push(`«${note}»`);
  return parts.join(' · ');
}
