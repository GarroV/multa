import { describe, expect, it } from 'vitest';
import { parseEntry } from './parseEntry.ts';

const ctx = { baseCurrency: 'RUB', today: '2026-07-30', categories: ['Продукты', 'Кафе', 'Транспорт', 'Общее'] };

describe('parseEntry — умное поле ввода (04-web-ux §Ввод)', () => {
  it('«250 еда» — сумма в базовой валюте, категория угадана по слову', () => {
    const r = parseEntry('250 продукты', ctx);

    expect(r.kind).toBe('expense');
    expect(r.amountMinor).toBe(25000n); // 250 RUB
    expect(r.currency).toBe('RUB');
    expect(r.categoryName).toBe('Продукты');
    expect(r.occurredOn).toBe('2026-07-30');
  });

  it('сумма может стоять после слов', () => {
    expect(parseEntry('кафе 480', ctx).amountMinor).toBe(48000n);
    expect(parseEntry('кафе 480', ctx).categoryName).toBe('Кафе');
  });

  it('дробная сумма — и с точкой, и с запятой', () => {
    expect(parseEntry('4.5 кафе', ctx).amountMinor).toBe(450n);
    expect(parseEntry('4,50 кафе', ctx).amountMinor).toBe(450n);
  });

  it('разделитель тысяч пробелом — так пишут люди', () => {
    expect(parseEntry('магазин 1 250,50 продукты', ctx).amountMinor).toBe(125050n);
    expect(parseEntry('30 000 аренда', ctx).amountMinor).toBe(3000000n);
    // Узкий и неразрывный пробелы (копипаст из банка) тоже считаются разделителями.
    expect(parseEntry('1\u00A0250 кафе', ctx).amountMinor).toBe(125000n);
  });

  it('валюта словом или кодом — сумма считается в её exponent', () => {
    const eur = parseEntry('кофе 4.5 eur', ctx);
    expect(eur.currency).toBe('EUR');
    expect(eur.amountMinor).toBe(450n);

    expect(parseEntry('такси 1200 rsd', ctx).currency).toBe('RSD');
    expect(parseEntry('обед 900 ¥', { ...ctx, categories: ['Общее'] }).currency).toBe('JPY');
  });

  it('JPY без дробной части: 900 иен это 900 minor, а не 90 000', () => {
    expect(parseEntry('обед 900 jpy', ctx).amountMinor).toBe(900n);
  });

  it('«вчера» и «позавчера» сдвигают дату', () => {
    expect(parseEntry('кафе 300 вчера', ctx).occurredOn).toBe('2026-07-29');
    expect(parseEntry('кафе 300 позавчера', ctx).occurredOn).toBe('2026-07-28');
    expect(parseEntry('coffee 300 yesterday', ctx).occurredOn).toBe('2026-07-29');
  });

  it('явная дата числом месяца остаётся в прошлом, а не улетает в будущее', () => {
    // «12.07» в конце июля — это 12 июля этого года, а не следующего.
    expect(parseEntry('аренда 30000 12.07', ctx).occurredOn).toBe('2026-07-12');
    // Число из будущего трактуем как прошлый месяц: 31.08 в июле — это 31 августа прошлого года? Нет:
    // будущее в вводе факта бессмысленно, поэтому берём ближайшую прошлую дату.
    expect(parseEntry('аренда 30000 31.08', ctx).occurredOn).toBe('2025-08-31');
  });

  it('«+» или слово-приход делают запись доходом', () => {
    expect(parseEntry('+15000 подработка', ctx).kind).toBe('income');
    expect(parseEntry('пришло 15000', ctx).kind).toBe('income');
    expect(parseEntry('got 500 eur', ctx).kind).toBe('income');
  });

  it('приход не получает категорию даже если слово похоже', () => {
    expect(parseEntry('+500 кафе', ctx).categoryName).toBeUndefined();
  });

  it('категория ищется без учёта регистра и по началу слова', () => {
    expect(parseEntry('300 ПРОДУКТЫ', ctx).categoryName).toBe('Продукты');
    expect(parseEntry('300 транспорт метро', ctx).categoryName).toBe('Транспорт');
  });

  it('нет суммы — не гадаем, отдаём ошибку', () => {
    expect(parseEntry('просто текст', ctx).amountMinor).toBeNull();
    expect(parseEntry('', ctx).amountMinor).toBeNull();
  });

  it('заметка — остаток строки без суммы, валюты, даты и названия категории', () => {
    expect(parseEntry('450 кафе с Аней', ctx).note).toBe('с Аней');
    expect(parseEntry('450 кафе', ctx).note).toBeUndefined();
  });

  it('ноль и минус не принимаем: знак несёт вид операции', () => {
    expect(parseEntry('0 кафе', ctx).amountMinor).toBeNull();
    expect(parseEntry('-100 кафе', ctx).amountMinor).toBeNull();
  });
});
