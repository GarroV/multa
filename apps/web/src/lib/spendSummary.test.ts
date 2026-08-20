import { describe, expect, it } from 'vitest';
import { parsedSummary } from './spendSummary.ts';

/**
 * «Понял так» — единственное место, где видно, что именно уйдёт в запись (issue #138, вопрос
 * владельца «в чём смысл писать название и потом ещё и заметка? как заметка будет отображаться?»).
 */
describe('parsedSummary', () => {
  const base = { amountMinor: '25000', currency: 'RUB', occurredOn: '2026-08-20' };

  it('складывает сумму, дату и категорию в человеческую строку', () => {
    expect(parsedSummary({ ...base, categoryName: 'Продукты' }, 'ru')).toBe(
      '250 RUB · 20.08 · Продукты',
    );
  });

  it('показывает заметку — иначе не видно, что из фразы сохранится', () => {
    expect(parsedSummary({ ...base, categoryName: 'Кафе', note: 'кофе на вынос' }, 'ru')).toBe(
      '250 RUB · 20.08 · Кафе · «кофе на вынос»',
    );
  });

  it('заметка без категории не съезжает на её место', () => {
    expect(parsedSummary({ ...base, note: 'подарок' }, 'ru')).toBe('250 RUB · 20.08 · «подарок»');
  });

  it('пустую заметку не показывает', () => {
    expect(parsedSummary({ ...base, note: '   ' }, 'ru')).toBe('250 RUB · 20.08');
    expect(parsedSummary({ ...base, note: null }, 'ru')).toBe('250 RUB · 20.08');
  });

  it('валюту с нулевым порядком не делит на сто', () => {
    /*
     * JPY exponent 0: 25000 минорных единиц — это 25 000 иен, а не 250. Пробелы нормализуем:
     * `Intl` разделяет разряды НЕРАЗРЫВНЫМ пробелом, и утверждение с обычным падало на невидимой
     * разнице — то есть проверяло бы вид пробела вместо порядка валюты.
     */
    const spaces = (s: string) => s.replace(/\s/g, ' ');
    expect(spaces(parsedSummary({ ...base, currency: 'JPY' }, 'ru'))).toBe('25 000 JPY · 20.08');
  });

  it('в английской локали даёт английский формат', () => {
    expect(parsedSummary({ ...base, note: 'coffee' }, 'en')).toBe('250 RUB · 20.08 · «coffee»');
  });
});
