import { createTranslator, type Locale } from '@multa/i18n';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Язык интерфейса.
 *
 * Выбор запоминается и проставляется в `<html lang>`: без первого человек выбирает язык каждый
 * визит (тема при этом персистилась — расхождение нашёл адверсарный аудит), без второго браузер и
 * скринридер считают страницу русской при английском интерфейсе, что ломает переносы и произношение.
 *
 * Локаль воркспейса перетирает выбор один раз за сессию (нужно демо, оно всегда английское) — это
 * делает `App`; здесь только хранение и применение.
 */

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: ReturnType<typeof createTranslator>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const KEY = 'multa.locale';

function isLocale(value: unknown): value is Locale {
  return value === 'ru' || value === 'en';
}

function storedLocale(): Locale | null {
  try {
    const value = localStorage.getItem(KEY);
    return isLocale(value) ? value : null;
  } catch {
    // Приватный режим может запретить localStorage — язык просто не запомнится.
    return null;
  }
}

/** Язык браузера, если он нам известен: русскоязычному человеку не нужен английский интерфейс. */
function browserLocale(): Locale {
  const langs =
    typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  for (const lang of langs) {
    const short = String(lang).slice(0, 2).toLowerCase();
    if (isLocale(short)) return short;
  }
  return 'ru';
}

export function initialLocale(): Locale {
  return storedLocale() ?? browserLocale();
}

/** Человек уже выбирал язык сам — значит его выбор сильнее локали воркспейса. */
export function hasChosenLocale(): boolean {
  return storedLocale() !== null;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Не смогли запомнить — переключение в текущей сессии всё равно работает.
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: createTranslator(locale) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('I18nProvider отсутствует');
  return ctx;
}
