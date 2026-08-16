import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n.tsx';
import { Proposals } from './Proposals.tsx';

/**
 * Лента предложений правок (issue #83).
 *
 * Участник не пишет в план — он предлагает, владелец решает. Здесь проверяется то, что легко
 * сломать правкой: решение уходит на сервер той же кнопкой, которую видит человек, и пустая лента
 * не занимает место на экране.
 */
const PROPOSAL = {
  id: 'p-1',
  targetKind: 'category',
  targetId: 'c-1',
  startsOn: '2026-08-10',
  plannedMinor: '1500000',
  status: 'pending',
  createdAt: '2026-08-16T10:00:00.000Z',
};

function show(proposals: unknown[], role: 'owner' | 'member' = 'owner') {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url);
    const body = path.includes('/proposals')
      ? { proposals }
      : { user: null, workspace: null, role, onboardingComplete: true, today: '2026-08-16' };
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <Proposals base="RUB" />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

/** Какие решения ушли на сервер: проверяем вызовы, а не состояние компонента. */
const resolved = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => String(c[0]));

describe('Proposals', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('пустая лента не занимает места на экране', async () => {
    show([]);
    // Панели быть не должно вовсе: напоминание о неиспользуемой функции — визуальный шум.
    await waitFor(() => expect(screen.queryByText(/ПРЕДЛОЖЕНИЯ|PROPOSED/)).toBeNull());
  });

  it('владелец принимает предложение, и решение уходит на сервер', async () => {
    const user = userEvent.setup();
    const fetchMock = show([PROPOSAL]);

    await user.click(await screen.findByRole('button', { name: /^Принять$|^Accept$/ }));

    await waitFor(() => expect(resolved(fetchMock).length).toBeGreaterThan(0));
    expect(resolved(fetchMock).at(-1)).toContain('/v1/proposals/p-1/accept');
  });

  it('отклонение — своя ручка, а не то же самое действие', async () => {
    const user = userEvent.setup();
    const fetchMock = show([PROPOSAL]);

    await user.click(await screen.findByRole('button', { name: /^Отклонить$|^Decline$/ }));

    await waitFor(() => expect(resolved(fetchMock).length).toBeGreaterThan(0));
    expect(resolved(fetchMock).at(-1)).toContain('/v1/proposals/p-1/reject');
  });

  it('участник видит судьбу предложения, но решать не может', async () => {
    show([{ ...PROPOSAL, status: 'accepted' }], 'member');

    // Статус — то единственное, ради чего участнику эта лента нужна.
    expect(await screen.findByText(/принято|accepted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Принять$|^Accept$/ })).toBeNull();
  });
});
