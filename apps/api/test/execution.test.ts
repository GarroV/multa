import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, onboarded, type PlanDto, type TestClient } from './client.ts';

/**
 * Исполнение плановых строк (01-domain-model §Исполнение): «сделал» / «сделал частично» /
 * «пропустил». Статус живёт в БД и не выводится из суммы — «пропустил» суммой не выразить.
 */

function row(plan: PlanDto, targetId: string) {
  const hit = plan.allocations.find((a) => a.targetId === targetId);
  if (!hit) throw new Error(`строки ${targetId} нет в плане`);
  return hit;
}

async function withDebt(payoutMinor = '30000000', paymentMinor = '5000000') {
  const client = await onboarded({ payoutMinor });
  const debt = await expectOk<{ id: string }>(
    await client.post('/v1/debts', {
      name: 'Кредит',
      currency: 'RUB',
      principalMinor: '50000000',
      remainingMinor: '40000000',
      paymentMinor,
    }),
    201,
  );
  return { client, debtId: debt.id };
}

async function transactionCount(client: TestClient): Promise<number> {
  const list = await expectOk<{ transactions: unknown[] }>(await client.get('/v1/transactions'));
  return list.transactions.length;
}

describe('исполнение плановых строк', () => {
  test('подтверждение целиком закрывает строку и не оставляет остатка', async () => {
    const { client, debtId } = await withDebt();
    const plan = await expectOk<PlanDto>(await client.post(`/v1/plan/current/items/debt/${debtId}/confirm`));

    expect(row(plan, debtId).executionStatus).toBe('confirmed');
    expect(BigInt(row(plan, debtId).executedMinor)).toBe(5_000_000n);
    expect(BigInt(row(plan, debtId).remainderMinor)).toBe(0n);
  });

  test('частичное подтверждение оставляет видимый остаток', async () => {
    const { client, debtId } = await withDebt();
    const plan = await expectOk<PlanDto>(
      await client.post(`/v1/plan/current/items/debt/${debtId}/confirm`, { executedMinor: '2000000' }),
    );

    expect(row(plan, debtId).executionStatus).toBe('partial');
    expect(BigInt(row(plan, debtId).executedMinor)).toBe(2_000_000n);
    expect(BigInt(row(plan, debtId).remainderMinor)).toBe(3_000_000n);
  });

  test('пропуск ставит skipped с нулём, а не «исполнено на 0»', async () => {
    const { client, debtId } = await withDebt();
    const plan = await expectOk<PlanDto>(await client.post(`/v1/plan/current/items/debt/${debtId}/skip`));

    expect(row(plan, debtId).executionStatus).toBe('skipped');
    expect(BigInt(row(plan, debtId).executedMinor)).toBe(0n);
    // Строка остаётся в плане: пропущенный платёж должен быть виден, а не исчезать.
    expect(BigInt(row(plan, debtId).allocatedMinor)).toBe(5_000_000n);
  });

  test('повторное подтверждение не удваивает транзакцию', async () => {
    const { client, debtId } = await withDebt();
    await expectOk<PlanDto>(await client.post(`/v1/plan/current/items/debt/${debtId}/confirm`));
    expect(await transactionCount(client)).toBe(1);

    await expectOk<PlanDto>(await client.post(`/v1/plan/current/items/debt/${debtId}/confirm`));
    expect(await transactionCount(client)).toBe(1);
  });

  test('исправление на частичное переписывает сумму, а не добавляет вторую', async () => {
    const { client, debtId } = await withDebt();
    await expectOk<PlanDto>(await client.post(`/v1/plan/current/items/debt/${debtId}/confirm`));
    const plan = await expectOk<PlanDto>(
      await client.post(`/v1/plan/current/items/debt/${debtId}/confirm`, { executedMinor: '1000000' }),
    );

    expect(row(plan, debtId).executionStatus).toBe('partial');
    const list = await expectOk<{ transactions: { amountMinor: string }[] }>(await client.get('/v1/transactions'));
    expect(list.transactions).toHaveLength(1);
    expect(list.transactions[0]?.amountMinor).toBe('1000000');
  });

  test('пропуск после подтверждения убирает транзакцию исполнения', async () => {
    const { client, debtId } = await withDebt();
    await expectOk<PlanDto>(await client.post(`/v1/plan/current/items/debt/${debtId}/confirm`));
    await expectOk<PlanDto>(await client.post(`/v1/plan/current/items/debt/${debtId}/skip`));
    expect(await transactionCount(client)).toBe(0);
  });

  test('категория исполнения не требует: её факт приходит тратами', async () => {
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    await expectOk<PlanDto>(await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '4000000' }));

    const res = await client.post(`/v1/plan/current/items/category/${food}/confirm`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'execution_not_applicable' });
  });

  test('строки не в плане подтвердить нельзя', async () => {
    const client = await onboarded();
    const res = await client.post('/v1/plan/current/items/debt/00000000-0000-0000-0000-000000000000/confirm');
    expect(res.status).toBe(404);
  });
});

describe('пересборка плана', () => {
  /** Категория с бюджетом плюс долг в плане: обычный набор строк, из которого выбирают источник. */
  async function withCategoryAndDebt() {
    const { client, debtId } = await withDebt('30000000', '5000000');
    const food = await categoryId(client, 'Продукты');
    await expectOk<PlanDto>(await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '4000000' }));
    return { client, debtId, food };
  }

  test('перенос в обязательство отклоняется, деньги не списываются', async () => {
    // Сумма платежа приходит из самого долга, поэтому «добавить» ему нельзя: списание с
    // категории без прибавки платежу — тихая потеря денег пользователя.
    const { client, debtId, food } = await withCategoryAndDebt();
    const res = await client.post('/v1/plan/current/rebalance', {
      fromKind: 'category',
      fromId: food,
      toId: debtId,
      amountMinor: '1000000',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'target_not_adjustable' });

    const plan = await expectOk<PlanDto>(await client.get('/v1/plan/current'));
    expect(BigInt(row(plan, food).allocatedMinor)).toBe(4_000_000n);
    expect(BigInt(row(plan, debtId).allocatedMinor)).toBe(5_000_000n);
  });

  test('перенос в категорию поднимает её бюджет', async () => {
    const { client, food } = await withCategoryAndDebt();
    const cafe = await categoryId(client, 'Кафе');
    await expectOk<PlanDto>(await client.put(`/v1/plan/current/categories/${cafe}`, { plannedMinor: '1000000' }));

    const plan = await expectOk<PlanDto>(
      await client.post('/v1/plan/current/rebalance', {
        fromKind: 'category',
        fromId: food,
        toId: cafe,
        amountMinor: '500000',
      }),
    );

    expect(BigInt(row(plan, food).allocatedMinor)).toBe(3_500_000n);
    expect(BigInt(row(plan, cafe).allocatedMinor)).toBe(1_500_000n);
  });

  test('долг источником быть не может, даже если клиент назвал его категорией', async () => {
    const { client, debtId, food } = await withCategoryAndDebt();
    const res = await client.post('/v1/plan/current/rebalance', {
      // Подделка: тип источника взят с потолка, решение обязано приниматься по БД.
      fromKind: 'category',
      fromId: debtId,
      toId: food,
      amountMinor: '1000000',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'source_protected' });

    // Суммы не поехали ни на копейку.
    const plan = await expectOk<PlanDto>(await client.get('/v1/plan/current'));
    expect(BigInt(row(plan, debtId).allocatedMinor)).toBe(5_000_000n);
    expect(BigInt(row(plan, food).allocatedMinor)).toBe(4_000_000n);
  });

  test('защищённая категория источником быть не может', async () => {
    const { client, food } = await withCategoryAndDebt();
    const cafe = await categoryId(client, 'Кафе');
    await expectOk<PlanDto>(await client.put(`/v1/plan/current/categories/${cafe}`, { plannedMinor: '1000000' }));
    await expectOk(await client.patch(`/v1/categories/${food}`, { protected: true }));

    const res = await client.post('/v1/plan/current/rebalance', {
      fromKind: 'category',
      fromId: food,
      toId: cafe,
      amountMinor: '1000000',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'source_protected' });
  });

  test('больше, чем есть в источнике, не переносится', async () => {
    const { client, food } = await withCategoryAndDebt();
    const cafe = await categoryId(client, 'Кафе');
    await expectOk<PlanDto>(await client.put(`/v1/plan/current/categories/${cafe}`, { plannedMinor: '1000000' }));
    const res = await client.post('/v1/plan/current/rebalance', {
      fromKind: 'category',
      fromId: food,
      toId: cafe,
      amountMinor: '9000000',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'insufficient_source' });
  });

  test('перенос в самого себя отклоняется', async () => {
    const { client, food } = await withCategoryAndDebt();
    const res = await client.post('/v1/plan/current/rebalance', {
      fromKind: 'category',
      fromId: food,
      toId: food,
      amountMinor: '100000',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'same_target' });
  });

  test('варианты «откуда добавим» не предлагают долг и защищённую категорию', async () => {
    const { client, debtId, food } = await withCategoryAndDebt();
    const cafe = await categoryId(client, 'Кафе');
    await expectOk<PlanDto>(await client.put(`/v1/plan/current/categories/${cafe}`, { plannedMinor: '2000000' }));
    await expectOk(await client.patch(`/v1/categories/${cafe}`, { protected: true }));

    const options = await expectOk<{ targetKind: string; targetId: string }[]>(
      await client.get(`/v1/plan/current/rebalance?targetId=${debtId}&needMinor=1000000`),
    );
    const ids = options.map((o) => o.targetId);
    expect(ids).toContain(food);
    expect(ids).not.toContain(cafe);
    expect(ids).not.toContain(debtId);
  });
});
