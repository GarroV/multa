import { describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { transactions } from '../src/db/schema/domain.ts';
import { expectOk, forgetRate, getPlan, onboarded, seedRate, type TestClient } from './client.ts';

/**
 * Устойчивость сборки плана (находки адверсарного аудита).
 *
 * Главный экран продукта не имеет права ломаться навсегда. Здесь закреплены три пути, каждый из
 * которых раньше приводил к вечному 500 на `GET /v1/plan/current` — то есть к потере доступа ко
 * всему, что через него проходит: бюджетам, исполнению, пересборке, заморозке.
 */

async function addGoal(client: TestClient, plannedPerPeriodMinor: string, currency = 'RUB') {
  return expectOk<{ id: string }>(
    await client.post('/v1/goals', {
      name: 'Мотоцикл',
      currency,
      targetMinor: '40000000',
      plannedPerPeriodMinor,
    }),
    201,
  );
}

describe('сборка плана не ломается насмерть', () => {
  test('удаление обязательства после подтверждённого исполнения не роняет план', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(client, '5000000');
    await getPlan(client);

    // Подтвердили взнос: появляется транзакция, ссылающаяся на плановую строку.
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/confirm`, {}));
    // Передумали и удалили цель — плановая строка становится «исчезнувшей».
    expect((await client.del(`/v1/goals/${goal.id}`)).status).toBe(204);

    // Раньше здесь было 500 навсегда: DELETE плановой строки падал на FK из транзакции.
    const plan = await getPlan(client);
    expect(plan.allocations.every((a) => a.targetId !== goal.id)).toBe(true);
    /*
     * Факт исполнения не потерян — проверяем в базе, а не в списке транзакций: DTO отдаёт
     * `categoryId` только для категорий, и исполнение обязательства в нём неотличимо от прочего.
     * Важно именно то, что строка жива, а ссылка на исчезнувшую плановую строку обнулилась.
     */
    const executions = await db
      .select({ id: transactions.id, plannedItemId: transactions.plannedItemId })
      .from(transactions)
      .where(and(eq(transactions.targetKind, 'goal'), eq(transactions.targetId, goal.id)));
    expect(executions).toHaveLength(1);
    expect(executions[0]?.plannedItemId).toBeNull();
  });

  test('исчезнувший курс не роняет план после подтверждённого исполнения', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const on = new Date().toISOString().slice(0, 10);
    await seedRate('KZT', 'RUB', '0.2000000000', on, 'cbr');
    const goal = await addGoal(client, '1000000', 'KZT');
    await getPlan(client);
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/confirm`, {}));

    // Котировка пропала (переезд источника, чистка кэша) — обязательство уходит в unresolved и
    // выпадает из плана, а его плановая строка становится «исчезнувшей».
    await forgetRate('KZT', 'RUB');

    const plan = await getPlan(client);
    expect(plan.unresolved.some((u) => u.targetId === goal.id)).toBe(true);
  });

  test('повторные запросы плана остаются рабочими, а не залипают на ошибке', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(client, '5000000');
    await getPlan(client);
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/confirm`, {}));
    await client.del(`/v1/goals/${goal.id}`);

    for (let i = 0; i < 3; i += 1) {
      const res = await client.get('/v1/plan/current');
      expect(res.status).toBe(200);
    }
    // И соседние ручки, которые тоже возвращают план, работают.
    const other = await addGoal(client, '1000000');
    expect((await client.post(`/v1/plan/current/items/goal/${other.id}/freeze`, {})).status).toBe(
      200,
    );
  });
});
