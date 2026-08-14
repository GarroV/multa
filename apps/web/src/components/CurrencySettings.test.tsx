import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n.tsx';
import { CurrencySettings } from './CurrencySettings.tsx';

/**
 * Список валют воркспейса (issue #49, запрос владельца 06.08.2026).
 *
 * Настройка хранилась с самого начала и читалась выпадашками, но задать её было негде — у всех был
 * один зашитый набор. Здесь проверяется то, что легко сломать правкой: нельзя остаться без валют
 * вовсе и нельзя завести дубль.
 */
const SETTINGS = (list: string[]) => ({
  periods: { suggestRaises: true },
  currency: {
    list,
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
});

function show(list: string[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(SETTINGS(list)), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <CurrencySettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

const sent = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { currency: { list: string[] } });

describe('CurrencySettings', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('добавляет валюту трёхбуквенным кодом', async () => {
    const user = userEvent.setup();
    const fetchMock = show(['RUB', 'EUR']);
    const field = await screen.findByLabelText(/Добавить валюту|Add a currency/);
    await user.type(field, 'kzt');
    await user.click(screen.getByRole('button', { name: /^Добавить$|^Add$/ }));
    await waitFor(() => expect(sent(fetchMock).length).toBeGreaterThan(0));
    expect(sent(fetchMock).at(-1)!.currency.list).toEqual(['RUB', 'EUR', 'KZT']);
  });

  it('дубль не добавляется: список не должен множить одно и то же', async () => {
    const user = userEvent.setup();
    const fetchMock = show(['RUB', 'EUR']);
    const field = await screen.findByLabelText(/Добавить валюту|Add a currency/);
    await user.type(field, 'EUR');
    expect(screen.getByRole('button', { name: /^Добавить$|^Add$/ })).toBeDisabled();
    expect(sent(fetchMock)).toHaveLength(0);
  });

  it('последнюю валюту убрать нельзя: без неё нечего будет записать', async () => {
    show(['RUB']);
    const remove = await screen.findByRole('button', { name: /RUB/ });
    expect(remove).toBeDisabled();
  });

  it('лишнюю валюту убрать можно', async () => {
    const user = userEvent.setup();
    const fetchMock = show(['RUB', 'EUR']);
    await user.click(await screen.findByRole('button', { name: /EUR/ }));
    await waitFor(() => expect(sent(fetchMock).length).toBeGreaterThan(0));
    expect(sent(fetchMock).at(-1)!.currency.list).toEqual(['RUB']);
  });
});
