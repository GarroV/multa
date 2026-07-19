import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './lib/i18n.tsx';
import { router } from './router.tsx';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000 } },
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
