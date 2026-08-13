import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded } from './client.ts';

/**
 * Займы: деньги, которые должны вернуть мне (issue #94, запрос владельца 10.08.2026).
 *
 * Главное свойство, ради которого написан этот файл: заём НЕ попадает в каскад. Долг — это деньги,
 * которые уходят, и каждый период под него откладывается платёж. Заём наоборот: деньги должны
 * прийти. Оставь его в раздаче — и она начнёт резервировать то, чего у человека нет, а цифра дня
 * уменьшится вместо роста. Числа при этом сойдутся, и ошибку никто не заметит.
 *
 * Отдельной таблицы у займа нет намеренно: колонки те же (сумма, остаток, срок, контрагент), а
 * четвёртая почти такая же таблица рядом с долгами, конвертами и целями разошлась бы поведением.
 */
describe('займы', () => {
  test('заём не забирает деньги из плана, а долг забирает', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const before = await getPlan(client);

    await expectOk(
      await client.post('/v1/debts', {
        name: 'Петя должен',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '1000000',
        direction: 'owed_to_me',
      }),
      201,
    );
    const withLoan = await getPlan(client);
    // Свободных денег ровно столько же: заём ничего не откладывает.
    expect(withLoan.freeMinor).toBe(before.freeMinor);
    expect(withLoan.allocations.some((a) => a.name === 'Петя должен')).toBe(false);

    await expectOk(
      await client.post('/v1/debts', {
        name: 'Банк',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '1000000',
      }),
      201,
    );
    const withDebt = await getPlan(client);
    // А обычный долг забирает: иначе тест не отличал бы «исключили заём» от «каскад не работает».
    expect(BigInt(withDebt.freeMinor)).toBeLessThan(BigInt(before.freeMinor));
  });

  test('займы отдаются списком отдельно от долгов', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Петя должен',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '0',
        direction: 'owed_to_me',
      }),
      201,
    );

    const all = await expectOk<{ id: string; name: string; direction: string }[]>(
      await client.get('/v1/debts'),
    );
    const loan = all.find((d) => d.name === 'Петя должен');
    expect(loan?.direction).toBe('owed_to_me');
  });

  test('направление по умолчанию — обычный долг: старые строки не меняют смысл', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Банк',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '1000000',
      }),
      201,
    );
    const all = await expectOk<{ name: string; direction: string }[]>(
      await client.get('/v1/debts'),
    );
    expect(all.find((d) => d.name === 'Банк')?.direction).toBe('owed_by_me');
  });

  test('возврат уменьшает остаток и записывается приходом', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const loan = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Петя должен',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '0',
        direction: 'owed_to_me',
      }),
      201,
    );

    await expectOk(await client.post(`/v1/debts/${loan.id}/repaid`, { amountMinor: '2000000' }));

    const all = await expectOk<{ id: string; remainingMinor: string }[]>(
      await client.get('/v1/debts'),
    );
    expect(all.find((d) => d.id === loan.id)?.remainingMinor).toBe('3000000');

    // Возврат — это факт прихода денег, а не правка числа в карточке.
    const txs = await expectOk<{ transactions: { kind: string; amountMinor: string }[] }>(
      await client.get('/v1/transactions?from=2020-01-01&to=2030-01-01'),
    );
    expect(txs.transactions.some((t) => t.kind === 'income' && t.amountMinor === '2000000')).toBe(
      true,
    );
  });

  test('вернуть больше, чем должны, нельзя', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const loan = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Петя должен',
        currency: 'RUB',
        principalMinor: '1000000',
        remainingMinor: '1000000',
        paymentMinor: '0',
        direction: 'owed_to_me',
      }),
      201,
    );
    const res = await client.post(`/v1/debts/${loan.id}/repaid`, { amountMinor: '9000000' });
    expect(res.status).toBe(422);
  });

  test('возврат по обычному долгу через эту ручку не проходит: это другая операция', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const debt = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Банк',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '1000000',
      }),
      201,
    );
    const res = await client.post(`/v1/debts/${debt.id}/repaid`, { amountMinor: '100000' });
    expect(res.status).toBe(422);
  });
});
