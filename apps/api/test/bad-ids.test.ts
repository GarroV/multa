import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, onboarded } from './client.ts';

/**
 * Кривой id в пути — это «нет такого», а не сбой сервера.
 *
 * Найдено адверсарным аудитом: `DELETE /v1/exchange-ops/not-a-uuid` и `/v1/buckets/not-a-uuid`
 * отвечали 500, потому что Postgres бросает 22P02 на нечисловом uuid. Пятисотка и врёт клиенту
 * («у нас всё сломалось» вместо «такого нет»), и засоряет логи чужими ошибками, из-за чего в них
 * тонут настоящие аварии.
 *
 * Тест идёт по всем ручкам с `:id` сразу: дефект был классовым, и починка одной ручки его бы не
 * закрыла.
 */

const GARBAGE = ['not-a-uuid', '123', '../etc/passwd', '00000000-0000-0000-0000-00000000000'];

const ENDPOINTS: {
  method: 'get' | 'del' | 'patch' | 'post' | 'put';
  path: (id: string) => string;
}[] = [
  { method: 'del', path: (id) => `/v1/exchange-ops/${id}` },
  { method: 'del', path: (id) => `/v1/buckets/${id}` },
  { method: 'del', path: (id) => `/v1/debts/${id}` },
  { method: 'del', path: (id) => `/v1/envelopes/${id}` },
  { method: 'del', path: (id) => `/v1/goals/${id}` },
  { method: 'del', path: (id) => `/v1/transactions/${id}` },
  { method: 'del', path: (id) => `/v1/accounts/${id}` },
  { method: 'del', path: (id) => `/v1/categories/${id}` },
  { method: 'del', path: (id) => `/v1/income-sources/${id}` },
  { method: 'del', path: (id) => `/v1/income-receipts/${id}` },
  { method: 'del', path: (id) => `/v1/recurring-items/${id}` },
  { method: 'patch', path: (id) => `/v1/accounts/${id}` },
  { method: 'patch', path: (id) => `/v1/categories/${id}` },
  { method: 'patch', path: (id) => `/v1/income-sources/${id}` },
  { method: 'patch', path: (id) => `/v1/recurring-items/${id}` },
  { method: 'post', path: (id) => `/v1/receipts/${id}/confirm` },
  { method: 'post', path: (id) => `/v1/plan/current/revisions/${id}/undo` },
  { method: 'post', path: (id) => `/v1/plan/current/items/goal/${id}/freeze` },
  { method: 'post', path: (id) => `/v1/income-sources/${id}/received` },
  { method: 'put', path: (id) => `/v1/plan/current/categories/${id}` },
];

describe('кривой id в пути', () => {
  test('ни одна ручка не отвечает 500 на мусорный id', async () => {
    const client = await onboarded();
    const failures: string[] = [];

    for (const endpoint of ENDPOINTS) {
      for (const id of GARBAGE) {
        const path = endpoint.path(id);
        const res =
          endpoint.method === 'del'
            ? await client.del(path)
            : endpoint.method === 'get'
              ? await client.get(path)
              : endpoint.method === 'patch'
                ? await client.patch(path, {})
                : endpoint.method === 'put'
                  ? await client.put(path, { plannedMinor: '1000' })
                  : await client.post(path, { amountMinor: '1000', occurredOn: '2026-07-25' });
        // 400 (не прошла схема тела) и 404 (нет такого) допустимы; 500 — нет.
        if (res.status >= 500)
          failures.push(`${endpoint.method.toUpperCase()} ${path} → ${res.status}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

/*
 * Изоляция по чужому id у ручек, которые скоупят не сами, а через вызываемую функцию (перепись
 * 17.08.2026).
 *
 * Правило 7 проекта: ни один хендлер не принимает workspace_id от клиента, скоуп только из токена.
 * У большинства ручек проверка «чужое недоступно» уже есть; у правки бюджета категории и отметки
 * исполнения её не было — они делегируют скоуп внутрь `setCategoryBudget` / `setExecution`, и это
 * место легко потерять при рефакторинге, ничего не заметив.
 */
describe('чужие идентификаторы у делегирующих ручек', () => {
  test('чужую категорию нельзя перебюджетировать', async () => {
    const other = await onboarded();
    const foreignCategory = await categoryId(other, 'Продукты');

    const mine = await onboarded();
    const res = await mine.put(`/v1/plan/current/categories/${foreignCategory}`, {
      plannedMinor: '900000',
    });
    // Не найдено, а не «нельзя»: чужая строка для меня не существует.
    expect(res.status).toBe(404);

    // И у соседа ничего не поменялось.
    const plan = await expectOk<{ allocations: { targetId: string; plannedMinor: string }[] }>(
      await other.get('/v1/plan/current'),
    );
    expect(plan.allocations.find((a) => a.targetId === foreignCategory)?.plannedMinor).not.toBe(
      '900000',
    );
  });

  test('чужой долг нельзя отметить исполненным', async () => {
    const other = await onboarded();
    const debt = await expectOk<{ id: string }>(
      await other.post('/v1/debts', {
        name: 'Кредит соседа',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '800000',
      }),
      201,
    );

    const mine = await onboarded();
    expect((await mine.post(`/v1/plan/current/items/debt/${debt.id}/confirm`)).status).toBe(404);
    expect((await mine.post(`/v1/plan/current/items/debt/${debt.id}/unconfirm`)).status).toBe(404);

    // У соседа строка так и осталась неотмеченной.
    const plan = await expectOk<{
      allocations: { targetKind: string; executionStatus: string }[];
    }>(await other.get('/v1/plan/current'));
    expect(plan.allocations.find((a) => a.targetKind === 'debt')?.executionStatus).toBe('pending');
  });
});

/*
 * Изоляция по чужому id у остальных ручек с прямым скоупом в запросе (сверка 19.08.2026).
 *
 * У этих ручек `eq(table.workspaceId, ws.id)` стоит прямо в WHERE — в отличие от делегирующих
 * ручек выше, потерять скоуп рефакторингом здесь сложнее. Но тест на это был только один — на
 * мусорный id (`not-a-uuid`), который ловит опечатку в проверке `isUuid`, а не отсутствие
 * `eq(workspaceId, ...)`. Валидный UUID из ЧУЖОГО воркспейса — другой класс дефекта, и до этого
 * теста ни одна из следующих ручек его не проверяла.
 *
 * Табличный прогон, а не по тесту на ручку: дефект здесь классовый (см. коммит про метрики и
 * `resolvable()` выше), проверка должна идти по всем ручкам сразу, а не полагаться на то, что
 * кто-то вспомнит добавить новую ручку в список руками.
 */
describe('изоляция по чужому UUID (не мусорному) у ручек с прямым скоупом', () => {
  test('обязательства (долг/конверт/цель/корзина): чужую строку не видно и не трогают', async () => {
    const other = await onboarded();
    const mine = await onboarded();

    const entities: { path: string; body: Record<string, unknown> }[] = [
      {
        path: 'debts',
        body: {
          name: 'Чужой долг',
          currency: 'RUB',
          principalMinor: '1000000',
          remainingMinor: '1000000',
          paymentMinor: '100000',
        },
      },
      {
        path: 'envelopes',
        body: { name: 'Чужой конверт', currency: 'RUB', ruleKind: 'fixed', ruleValue: '5000' },
      },
      {
        path: 'goals',
        body: { name: 'Чужая цель', currency: 'RUB', targetMinor: '1000000' },
      },
      {
        path: 'buckets',
        body: {
          name: 'Чужая корзина',
          fromCurrency: 'RUB',
          toCurrency: 'EUR',
          amountMinor: '1000',
        },
      },
    ];

    for (const { path, body } of entities) {
      const created = await expectOk<{ id: string; name: string }>(
        await other.post(`/v1/${path}`, body),
        201,
      );

      const patchRes = await mine.patch(`/v1/${path}/${created.id}`, { name: 'Перехвачено' });
      expect(patchRes.status).toBe(404);

      const delRes = await mine.del(`/v1/${path}/${created.id}`);
      expect(delRes.status).toBe(404);

      // У соседа строка осталась целой и на месте — не переименована и не удалена.
      const stillThere = await expectOk<{ id: string; name: string }[]>(
        await other.get(`/v1/${path}`),
      );
      expect(stillThere.find((r) => r.id === created.id)?.name).toBe(body.name);
    }
  });

  test('счёт: чужой не правится и не удаляется', async () => {
    const other = await onboarded();
    const mine = await onboarded();
    const acc = await expectOk<{ id: string; name: string }>(
      await other.post('/v1/accounts', { name: 'Чужой счёт', currency: 'RUB', kind: 'cash' }),
      201,
    );

    expect((await mine.patch(`/v1/accounts/${acc.id}`, { name: 'Взлом' })).status).toBe(404);
    expect((await mine.del(`/v1/accounts/${acc.id}`)).status).toBe(404);

    const list = await expectOk<{ id: string; name: string }[]>(await other.get('/v1/accounts'));
    expect(list.find((a) => a.id === acc.id)?.name).toBe('Чужой счёт');
  });

  test('категория: чужая не правится и не удаляется', async () => {
    const other = await onboarded();
    const mine = await onboarded();
    const foreignCategory = await categoryId(other, 'Продукты');

    expect((await mine.patch(`/v1/categories/${foreignCategory}`, { name: 'Взлом' })).status).toBe(
      404,
    );
    expect((await mine.del(`/v1/categories/${foreignCategory}`)).status).toBe(404);

    const list = await expectOk<{ id: string; name: string }[]>(await other.get('/v1/categories'));
    expect(list.find((c) => c.id === foreignCategory)?.name).toBe('Продукты');
  });

  test('регулярный платёж: чужой не правится и не удаляется', async () => {
    const other = await onboarded();
    const mine = await onboarded();
    const item = await expectOk<{ id: string; name: string }>(
      await other.post('/v1/recurring-items', {
        kind: 'expense',
        name: 'Чужая подписка',
        amountMinor: '50000',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [1] },
      }),
      201,
    );

    expect((await mine.patch(`/v1/recurring-items/${item.id}`, { name: 'Взлом' })).status).toBe(
      404,
    );
    expect((await mine.del(`/v1/recurring-items/${item.id}`)).status).toBe(404);

    const list = await expectOk<{ id: string; name: string }[]>(
      await other.get('/v1/recurring-items'),
    );
    expect(list.find((r) => r.id === item.id)?.name).toBe('Чужая подписка');
  });

  test('источник дохода: чужой не правится и не удаляется', async () => {
    const other = await onboarded();
    const mine = await onboarded();
    const me = await expectOk<{ workspace: { id: string } | null }>(await other.get('/v1/me'));
    const sources = await expectOk<{ id: string; label: string }[]>(
      await other.get('/v1/income-sources'),
    );
    const source = sources[0]!;
    void me;

    expect((await mine.patch(`/v1/income-sources/${source.id}`, { label: 'Взлом' })).status).toBe(
      404,
    );
    expect((await mine.del(`/v1/income-sources/${source.id}`)).status).toBe(404);
    expect(
      (
        await mine.post(`/v1/income-sources/${source.id}/received`, {
          amountMinor: '1',
          occurredOn: '2026-08-19',
        })
      ).status,
    ).toBe(404);

    const list = await expectOk<{ id: string; label: string }[]>(
      await other.get('/v1/income-sources'),
    );
    expect(list.find((s) => s.id === source.id)?.label).toBe(source.label);
  });

  test('операция размена: чужая не удаляется', async () => {
    const other = await onboarded();
    const mine = await onboarded();
    const op = await expectOk<{ id: string }>(
      await other.post('/v1/exchange-ops', {
        fromCurrency: 'RUB',
        toCurrency: 'EUR',
        fromMinor: '10000',
        toMinor: '100',
        occurredOn: '2026-08-19',
      }),
      201,
    );

    expect((await mine.del(`/v1/exchange-ops/${op.id}`)).status).toBe(404);

    const list = await expectOk<{ ops: { id: string }[] }>(await other.get('/v1/exchange-ops'));
    expect(list.ops.find((o) => o.id === op.id)).toBeTruthy();
  });

  test('трата: чужая не удаляется', async () => {
    const other = await onboarded();
    const mine = await onboarded();
    const tx = await expectOk<{ id: string }>(
      await other.post('/v1/transactions', {
        kind: 'expense',
        amountMinor: '500',
        currency: 'RUB',
        occurredOn: '2026-08-19',
      }),
      201,
    );

    expect((await mine.del(`/v1/transactions/${tx.id}`)).status).toBe(404);

    const list = await expectOk<{ transactions: { id: string }[] }>(
      await other.get('/v1/transactions'),
    );
    expect(list.transactions.find((t) => t.id === tx.id)).toBeTruthy();
  });
});
