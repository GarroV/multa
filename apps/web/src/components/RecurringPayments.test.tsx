import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n.tsx';
import { RecurringPayments } from './RecurringPayments.tsx';

/**
 * Валюта регулярного платежа (issue #115, найдено владельцем 16.08.2026: «где валюта? у всех
 * расходов может быть валюта разная»).
 *
 * Форма молча подставляла базовую валюту, хотя вся остальная цепочка валюту поддерживает: колонка
 * в БД обязательная, API принимает её и на создании, и на правке, список даже показывает ярлык при
 * отличии от базовой. Возможность была везде, кроме единственного места, где валюту задают.
 *
 * Молчаливая подстановка опаснее пустого поля: «аренда 500» в Сербии это 500 EUR, а уходило 500 в
 * базовой — и ярлык отличия не показывался, ведь валюта «совпала». Ошибку не видно нигде.
 */
const SETTINGS = {
  periods: { suggestRaises: true },
  currency: {
    list: ['RUB', 'EUR', 'RSD'],
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
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const body = String(url).includes('/settings') ? SETTINGS : [];
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <RecurringPayments base="RUB" />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

/** Тело созданного платежа: что реально ушло на сервер, а не что показала форма. */
const created = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, string>);

describe('RecurringPayments', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('валюту платежа можно выбрать, а не только базовую', async () => {
    const user = userEvent.setup();
    const fetchMock = show();

    await user.type(await screen.findByLabelText(/Название|Name/), 'Аренда квартиры');
    await user.type(screen.getByLabelText(/Сумма|Amount/), '500');

    // Выбор валюты — тот же, что в листе траты: список воркспейса, не свободный ввод.
    const ccy = screen.getByLabelText(/Валюта|Currency/);
    await user.click(ccy);
    await user.click(await screen.findByRole('option', { name: 'EUR' }));

    await user.click(screen.getByRole('button', { name: /^Добавить$|^Add$/ }));

    await waitFor(() => expect(created(fetchMock).length).toBeGreaterThan(0));
    expect(created(fetchMock).at(-1)!.currency).toBe('EUR');
  });

  it('сумма разбирается в выбранной валюте, а не в базовой', async () => {
    const user = userEvent.setup();
    const fetchMock = show();

    await user.type(await screen.findByLabelText(/Название|Name/), 'Подписка');
    await user.type(screen.getByLabelText(/Сумма|Amount/), '500');

    const ccy = screen.getByLabelText(/Валюта|Currency/);
    await user.click(ccy);
    await user.click(await screen.findByRole('option', { name: 'RSD' }));

    await user.click(screen.getByRole('button', { name: /^Добавить$|^Add$/ }));

    /*
     * RSD и RUB оба с двумя знаками, поэтому число совпадает — проверяем именно то, что разбор шёл
     * по выбранной валюте: иначе на JPY/KRW (нет дробной части) и BHD/KWD (три знака) разряды
     * поедут молча, а это прямой запрет из правил проекта.
     */
    await waitFor(() => expect(created(fetchMock).length).toBeGreaterThan(0));
    const sent = created(fetchMock).at(-1)!;
    expect(sent.currency).toBe('RSD');
    expect(sent.amountMinor).toBe('50000');
  });
});
