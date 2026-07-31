import { useCallback, useEffect, useState } from 'react';

/**
 * Тема интерфейса. Обе темы описаны токенами (`styles.css`), поэтому переключатель делает ровно
 * одно: ставит `data-theme` на корень. Выбор запоминается — человек выбирает тему один раз, а не
 * каждый визит; системную настройку уважаем только пока выбора не было.
 */

export type Theme = 'dark' | 'light';

const KEY = 'multa.theme';

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    // Приватный режим может запретить localStorage — тема просто не запомнится.
    return null;
  }
}

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function initialTheme(): Theme {
  return stored() ?? systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, set] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    set(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Не смогли запомнить — не повод ломать переключение в текущей сессии.
    }
  }, []);

  return { theme, setTheme };
}
