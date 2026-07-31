import { describe, expect, test } from 'vitest';
import { anonymous, categoryId, expectOk, onboarded, signedUp } from './client.ts';

/**
 * Железное правило 7: скоуп воркспейса берётся только из токена. Здесь проверяется не код
 * middleware, а наблюдаемое поведение: чужой id, посланный клиентом, не даёт доступа ни к
 * чтению, ни к записи, ни к удалению.
 */
describe('изоляция workspace', () => {
  test('без сессии план не отдаётся', async () => {
    const res = await anonymous().get('/v1/plan/current');
    expect(res.status).toBe(401);
  });

  test('без воркспейса план отвечает 409 no_workspace, а не пустым планом', async () => {
    const client = await signedUp();
    const res = await client.get('/v1/plan/current');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_workspace' });
  });

  test('чужая транзакция не видна в списке и не удаляется по id', async () => {
    const alice = await onboarded();
    const bob = await onboarded();

    const created = await expectOk<{ id: string }>(
      await alice.post('/v1/transactions', { amountMinor: '150000', currency: 'RUB' }),
      201,
    );

    const bobList = await expectOk<{ transactions: { id: string }[] }>(
      await bob.get('/v1/transactions'),
    );
    expect(bobList.transactions.map((t) => t.id)).not.toContain(created.id);

    const deleted = await bob.del(`/v1/transactions/${created.id}`);
    expect(deleted.status).toBe(404);

    // Запись должна остаться живой: 404 без фактического удаления, а не «удалил и соврал».
    const aliceList = await expectOk<{ transactions: { id: string }[] }>(
      await alice.get('/v1/transactions'),
    );
    expect(aliceList.transactions.map((t) => t.id)).toContain(created.id);
  });

  test('трата в чужую категорию отклоняется', async () => {
    const alice = await onboarded();
    const bob = await onboarded();
    const aliceCategory = await categoryId(alice, 'Продукты');

    const res = await bob.post('/v1/transactions', {
      amountMinor: '100000',
      currency: 'RUB',
      categoryId: aliceCategory,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'category_not_found' });
  });

  test('бюджет чужой категории не ставится', async () => {
    const alice = await onboarded();
    const bob = await onboarded();
    const aliceCategory = await categoryId(alice, 'Кафе');

    const res = await bob.put(`/v1/plan/current/categories/${aliceCategory}`, {
      plannedMinor: '5000000',
    });
    expect(res.status).toBe(404);

    // У Алисы бюджет так и не появился — иначе Боб менял бы чужой план.
    const plan = await expectOk<{ allocations: { targetId: string; allocatedMinor: string }[] }>(
      await alice.get('/v1/plan/current'),
    );
    const row = plan.allocations.find((a) => a.targetId === aliceCategory);
    expect(row?.allocatedMinor ?? '0').toBe('0');
  });

  test('чужой регулярный платёж не патчится и не удаляется', async () => {
    const alice = await onboarded();
    const bob = await onboarded();
    const item = await expectOk<{ id: string; name: string }>(
      await alice.post('/v1/recurring-items', {
        name: 'Интернет',
        amountMinor: '120000',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [5] },
      }),
      201,
    );

    expect((await bob.patch(`/v1/recurring-items/${item.id}`, { name: 'Взломано' })).status).toBe(
      404,
    );
    expect((await bob.del(`/v1/recurring-items/${item.id}`)).status).toBe(404);

    const mine = await expectOk<{ id: string; name: string }[]>(
      await alice.get('/v1/recurring-items'),
    );
    expect(mine.find((r) => r.id === item.id)?.name).toBe('Интернет');
  });
});

describe('удаление обязательств честно отвечает (находка аудита)', () => {
  test('чужой и несуществующий id дают 404, а не «успешно удалено»', async () => {
    const alice = await onboarded();
    const bob = await onboarded();
    const debt = await expectOk<{ id: string }>(
      await bob.post('/v1/debts', {
        name: 'Кредит Боба',
        currency: 'RUB',
        principalMinor: '1000000',
        remainingMinor: '1000000',
        paymentMinor: '100000',
      }),
      201,
    );

    // Раньше ручка отвечала 204 и на чужой id: клиент считал, что долг удалён, а он оставался.
    expect((await alice.del(`/v1/debts/${debt.id}`)).status).toBe(404);
    expect((await alice.del('/v1/debts/11111111-1111-1111-1111-111111111111')).status).toBe(404);

    const bobDebts = await expectOk<{ id: string }[]>(await bob.get('/v1/debts'));
    expect(bobDebts.map((d) => d.id)).toContain(debt.id);
    // Свой — удаляется и отвечает 204.
    expect((await bob.del(`/v1/debts/${debt.id}`)).status).toBe(204);
  });
});
