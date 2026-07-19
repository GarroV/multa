import { en, type TranslationKey } from './en.ts';
import { ru } from './ru.ts';

export type Locale = 'ru' | 'en';

export type { TranslationKey };

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { en, ru };

export type InterpolationParams = Record<string, string | number>;

function interpolate(template: string, params?: InterpolationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  );
}

/** Перевод ключа в локали с интерполяцией {name}. Фоллбек на en, если ключа нет в локали. */
export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: InterpolationParams,
): string {
  const template = dictionaries[locale][key] ?? en[key];
  return interpolate(template, params);
}

/** Замыкает локаль: t = createTranslator('ru'); t('common.next'). */
export function createTranslator(locale: Locale) {
  return (key: TranslationKey, params?: InterpolationParams): string =>
    translate(locale, key, params);
}

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/** Множественное число по правилам локали (RU: one/few/many/other). */
export function plural(locale: Locale, n: number, forms: PluralForms): string {
  const category = new Intl.PluralRules(locale).select(n);
  return forms[category] ?? forms.other;
}
