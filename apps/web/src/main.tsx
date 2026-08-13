import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
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

createRoot(rootEl).render(
  <StrictMode>
    {/*
      Граница снаружи провайдеров: упасть может и словарь, и клиент запросов, и тогда экран ошибки
      внутри них не отрисовался бы вовсе — остался бы прежний белый лист.
    */}
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <RouterProvider router={router} />
        </I18nProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
