import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n.tsx';
import { ObligationEdit } from './ObligationEdit.tsx';

/**
 * Разбивка платежа по выплатам в редакторе долга (issue #117, запрос владельца 16.08.2026: «плачу
 * я и с аванса и с зарплаты… разные суммы»).
 *
 * Серверная часть уже умеет `paymentsBySource`. Здесь проверяется то, что легко сломать правкой:
 * суммы уходят привязанными к своим источникам, а не перепутанными местами, и человек, который
 * разбивку не открывал, продолжает работать с одной суммой, как раньше.
 */
const SOURCES = [
  { id: 'a1111111-1111-1111-1111-111111111111', label: 'Аванс' },
  { id: 'b2222222-2222-2222-2222-222222222222', label: 'Зарплата' },
];

function show(paymentsBySource: { sourceId: string; amountMinor: string }[] = []) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const body = String(url).includes('/income-sources') ? SOURCES : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ObligationEdit
          entity="debts"
          id="d-1"
          name="Сбер"
          currency="RUB"
          fields={[
            { key: 'remainingMinor', label: 'obl.remaining', kind: 'minor', value: '8000000' },
            { key: 'paymentMinor', label: 'obl.payment', kind: 'minor', value: '2000000' },
          ]}
          steps={[]}
          paymentsBySource={paymentsBySource}
          onDone={() => {}}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

/** Тело правки, ушедшее на сервер: проверяем отправленное, а не состояние формы. */
const saved = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);

describe('разбивка платежа по выплатам', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('пока разбивку не открыли, правка идёт одной суммой — как раньше', async () => {
    const user = userEvent.setup();
    const fetchMock = show();

    await user.click(await screen.findByRole('button', { name: /^Сохранить$|^Save$/ }));

    await waitFor(() => expect(saved(fetchMock).length).toBeGreaterThan(0));
    const body = saved(fetchMock).at(-1)!;
    expect(body.paymentMinor).toBe('2000000');
    // Пустую разбивку не отправляем: она означала бы «долг не платится ни с чего».
    expect(body.paymentsBySource).toBeUndefined();
  });

  it('суммы уходят привязанными к своим выплатам, а не перепутанными', async () => {
    const user = userEvent.setup();
    const fetchMock = show();

    await user.click(await screen.findByRole('button', { name: /Разбить по выплатам|Split/ }));
    await user.type(await screen.findByLabelText('Аванс'), '5000');
    await user.type(screen.getByLabelText('Зарплата'), '15000');
    await user.click(screen.getByRole('button', { name: /^Сохранить$|^Save$/ }));

    await waitFor(() => expect(saved(fetchMock).length).toBeGreaterThan(0));
    expect(saved(fetchMock).at(-1)!.paymentsBySource).toEqual([
      { sourceId: SOURCES[0]!.id, amountMinor: '500000' },
      { sourceId: SOURCES[1]!.id, amountMinor: '1500000' },
    ]);
  });

  it('заведённая разбивка показывается сразу, без лишнего клика', async () => {
    show([{ sourceId: SOURCES[1]!.id, amountMinor: '1500000' }]);
    // Долг уже разбит — прятать это за кнопкой значило бы скрыть от человека его же настройку.
    expect(await screen.findByLabelText('Зарплата')).toHaveValue('15000');
  });

  it('выплата с пустым полем в разбивку не попадает', async () => {
    const user = userEvent.setup();
    const fetchMock = show();

    await user.click(await screen.findByRole('button', { name: /Разбить по выплатам|Split/ }));
    await user.type(await screen.findByLabelText('Зарплата'), '15000');
    await user.click(screen.getByRole('button', { name: /^Сохранить$|^Save$/ }));

    await waitFor(() => expect(saved(fetchMock).length).toBeGreaterThan(0));
    // Ноль и «не платим с этой выплаты» — разные вещи; пустое поле означает второе.
    expect(saved(fetchMock).at(-1)!.paymentsBySource).toEqual([
      { sourceId: SOURCES[1]!.id, amountMinor: '1500000' },
    ]);
  });
});
