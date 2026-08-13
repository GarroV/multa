import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { OfflineBar } from './components/OfflineBar.tsx';
import { I18nProvider } from './lib/i18n.tsx';
import { router } from './router.tsx';
import { applyTheme, initialTheme } from './lib/theme.ts';
import './styles.css';

// До первого кадра: сохранённая тема не должна мигать тёмной на загрузке.
applyTheme(initialTheme());

const queryClient = new QueryClient({
  // Мутации инвалидируют свои запросы сами; авто-рефетч (фокус/реконнект) не нужен и мог бы
  // «перекинуть» гейт онбординга в приложение до завершения шагов 3-4 (ритм и источники уже
  // записаны после шага 2, но 'me' намеренно не инвалидируется до финиша).
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, refetchOnReconnect: false },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root не найден');

/*
 * Регистрация service worker (Спринт 6): приложение должно открываться без сети.
 *
 * Только в прод-сборке: в деве worker перехватывал бы ассеты и отдавал вчерашние — отладка
 * превращается в охоту за призраками. Регистрация после `load`, чтобы не соревноваться за сеть с
 * первым рендером, и без падения наружу: не установился — приложение работает как обычно.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

createRoot(rootEl).render(
  <StrictMode>
    {/*
      Граница снаружи провайдеров: упасть может и словарь, и клиент запросов, и тогда экран ошибки
      внутри них не отрисовался бы вовсе — остался бы прежний белый лист.
    */}
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          {/* Выше гейта: без сети гейт показывает вход, и полоса внутри оболочки не появлялась. */}
          <OfflineBar />
          <RouterProvider router={router} />
        </I18nProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
