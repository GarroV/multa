import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n.tsx';
import { SignalSettings } from './SignalSettings.tsx';

/**
 * Пороги сигналов (issue #49, компонентный тест по #17).
 *
 * Проверяется одно свойство, которое дороже остальных: значение вне допустимых границ НЕ уходит на
 * сервер. Сервер его тоже отобьёт, но поле, которое молча не сохраняется, хуже поля, в которое
 * нельзя ввести лишнего: человек уверен, что настроил, а продукт продолжает жить по-старому.
 */
const SETTINGS = {
  periods: { suggestRaises: true },
  currency: {
    list: ['RUB'],
    rateSource: 'cbr',
    defaultSpreadBp: 0,
    defaultProvider: null,
    exchangeRoundingMajor: 0,
  },
  cascade: { bufferPct: 0, compressOrder: ['goal', 'envelope', 'category'] },
  signals: {
    burnThresholdDays: 3,
    medianPeriods: 6,
    runwayWarnDays: 14,
    lockedWarnPct: 60,
    maxSignals: 6,
  },
  sharing: {},
  tour: {},
};

function show() {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(SETTINGS), { headers: { 'content-type': 'application/json' } }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <SignalSettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

const patches = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');

describe('SignalSettings', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('показывает текущие пороги, а не пустые поля', async () => {
    show();
    const field = await screen.findByLabelText(/Темп|Pace/);
    expect(field).toHaveValue('3');
  });

  it('допустимое значение уходит на сервер', async () => {
    const user = userEvent.setup();
    const fetchMock = show();
    const field = await screen.findByLabelText(/Темп|Pace/);
    await user.clear(field);
    await user.type(field, '7');
    await waitFor(() => expect(patches(fetchMock).length).toBeGreaterThan(0));
    const body = JSON.parse(String((patches(fetchMock).at(-1)![1] as RequestInit).body));
    expect(body).toEqual({ signals: { burnThresholdDays: 7 } });
  });

  it('значение вне границ не отправляется вовсе', async () => {
    const user = userEvent.setup();
    const fetchMock = show();
    const field = await screen.findByLabelText(/Темп|Pace/);
    await user.clear(field);
    // 99 больше потолка в 14 дней: сервер бы отбил, но и спрашивать его незачем.
    await user.type(field, '99');
    const sent = patches(fetchMock).map((c) => JSON.parse(String((c[1] as RequestInit).body))) as {
      signals: { burnThresholdDays?: number };
    }[];
    expect(sent.some((b) => (b.signals.burnThresholdDays ?? 0) > 14)).toBe(false);
  });
});
