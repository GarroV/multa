import { createTranslator, type Locale } from '@multa/i18n';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: ReturnType<typeof createTranslator>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('ru');
  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: createTranslator(locale) }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('I18nProvider отсутствует');
  return ctx;
}
