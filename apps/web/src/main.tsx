import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './lib/i18n.tsx';
import { router } from './router.tsx';
import './styles.css';

const queryClient = new QueryClient({
  // Мутации инвалидируют свои запросы сами; фокус-рефетч не нужен и мог бы «перекинуть»
  // гейт онбординга в приложение до завершения шагов 3-4 (periodAnchors уже записаны после шага 2).
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root не найден');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
