import { describe, expect, test } from 'vitest';
import { today } from '../src/clock.ts';
import { expectOk, onboarded, seedRate, type TestClient } from './client.ts';

/**
 * Счета и мультивалютные остатки (issue #45). Прототип открывает план цифрой «сколько всего денег
 * есть», разложенной по валютам. Здесь проверяется именно эта правда: сумма в базовой валюте по
 * курсу дня, разбивка по валютам и то, что архивный счёт из агрегата выпадает.
 */

interface AccountDto {
  id: string;
  name: string;
  currency: string;
  kind: 'cash' | 'card' | 'savings' | 'other';
  balanceMinor: string;
  archived: boolean;
}

interface BalancesDto {
  totalMinor: string | null;
  byCurrency: { currency: string; minor: string; baseMinor: string | null }[];
  unresolved: string[];
}

async function addAccount(
  client: TestClient,
  body: Partial<AccountDto> & { name: string; currency: string },
): Promise<AccountDto> {
  return expectOk<AccountDto>(
    await client.post('/v1/accounts', { kind: 'cash', balanceMinor: '0', ...body }),
    201,
  );
}

describe('счета', () => {
  test('создаются, правятся и архивируются вместо удаления', async () => {
    const client = await onboarded();
    const created = await addAccount(client, {
      name: 'Наличные',
      currency: 'RUB',
      balanceMinor: '5000000',
    });
    expect(created.kind).toBe('cash');
    expect(created.balanceMinor).toBe('5000000');

    const patched = await expectOk<AccountDto>(
      await client.patch(`/v1/accounts/${created.id}`, {
        balanceMinor: '7500000',
        name: 'Кошелёк',
      }),
    );
    expect(patched.balanceMinor).toBe('7500000');
    expect(patched.name).toBe('Кошелёк');

    // Архивация, а не удаление: к счёту привязаны транзакции, и терять их историю нельзя.
    const archived = await expectOk<AccountDto>(
      await client.patch(`/v1/accounts/${created.id}`, { archived: true }),
    );
    expect(archived.archived).toBe(true);

    const list = await expectOk<AccountDto[]>(await client.get('/v1/accounts'));
    expect(list.map((a) => a.id)).not.toContain(created.id);
    const withArchived = await expectOk<AccountDto[]>(
      await client.get('/v1/accounts?includeArchived=1'),
    );
    expect(withArchived.map((a) => a.id)).toContain(created.id);
  });

  test('мусорные значения отклоняются, а не превращаются в ноль', async () => {
    const client = await onboarded();
    expect(
      (await client.post('/v1/accounts', { name: '', currency: 'RUB', kind: 'cash' })).status,
    ).toBe(400);
    expect(
      (await client.post('/v1/accounts', { name: 'X', currency: 'RUBLE', kind: 'cash' })).status,
    ).toBe(400);
    expect(
      (await client.post('/v1/accounts', { name: 'X', currency: 'RUB', kind: 'crypto' })).status,
    ).toBe(400);
  });

  test('остаток по валютам и общая сумма считаются по курсу дня', async () => {
    const client = await onboarded({ baseCurrency: 'RUB' });
    // CHF, а не EUR: `fx_rates` — общая таблица (публичные котировки), и котировку EUR сеют другие
    // сценарии, включая демо. Тест обязан зависеть только от того, что положил сам.
    await seedRate('CHF', 'RUB', '100.0000000000', today(), 'cbr');

    await addAccount(client, { name: 'Рубли', currency: 'RUB', balanceMinor: '5000000' });
    await addAccount(client, {
      name: 'Карта',
      currency: 'RUB',
      balanceMinor: '2500000',
      kind: 'card',
    });
    await addAccount(client, {
      name: 'Франки',
      currency: 'CHF',
      balanceMinor: '21000',
      kind: 'cash',
    });

    const balances = await expectOk<BalancesDto>(await client.get('/v1/accounts/balances'));
    const rub = balances.byCurrency.find((b) => b.currency === 'RUB');
    const chf = balances.byCurrency.find((b) => b.currency === 'CHF');
    // Валюты складываются между собой, а не смешиваются: 50 000 + 25 000 рублей в одной строке.
    expect(rub?.minor).toBe('7500000');
    expect(chf?.minor).toBe('21000');
    // 210 CHF по курсу 100 = 21 000 RUB; общая сумма — 75 000 + 21 000.
    expect(chf?.baseMinor).toBe('2100000');
    expect(balances.totalMinor).toBe('9600000');
  });

  test('без курса валюта попадает в unresolved, а сумма не занижается молча', async () => {
    const client = await onboarded({ baseCurrency: 'RUB' });
    await addAccount(client, { name: 'Рубли', currency: 'RUB', balanceMinor: '1000000' });
    await addAccount(client, { name: 'Лари', currency: 'GEL', balanceMinor: '50000' });

    const balances = await expectOk<BalancesDto>(await client.get('/v1/accounts/balances'));
    expect(balances.unresolved).toContain('GEL');
    // Общей суммы нет вовсе: показать 10 000 вместо «10 000 + сколько-то лари» значило бы солгать.
    expect(balances.totalMinor).toBeNull();
  });

  test('архивный счёт не участвует в остатке', async () => {
    const client = await onboarded();
    const acc = await addAccount(client, {
      name: 'Старый',
      currency: 'RUB',
      balanceMinor: '3000000',
    });
    await expectOk(await client.patch(`/v1/accounts/${acc.id}`, { archived: true }));

    const balances = await expectOk<BalancesDto>(await client.get('/v1/accounts/balances'));
    expect(balances.totalMinor).toBe('0');
    expect(balances.byCurrency).toHaveLength(0);
  });

  test('чужие счета не видны и не правятся', async () => {
    const alice = await onboarded();
    const acc = await addAccount(alice, {
      name: 'Алиса',
      currency: 'RUB',
      balanceMinor: '1000000',
    });

    const bob = await onboarded();
    const bobList = await expectOk<AccountDto[]>(await bob.get('/v1/accounts'));
    expect(bobList.map((a) => a.id)).not.toContain(acc.id);
    expect((await bob.patch(`/v1/accounts/${acc.id}`, { balanceMinor: '0' })).status).toBe(404);
    expect((await bob.del(`/v1/accounts/${acc.id}`)).status).toBe(404);

    const bobBalances = await expectOk<BalancesDto>(await bob.get('/v1/accounts/balances'));
    expect(bobBalances.totalMinor).toBe('0');
  });
});
