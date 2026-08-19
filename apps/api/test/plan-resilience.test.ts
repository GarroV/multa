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

  test('доход в валюте без курса уходит в unresolved, а не в молчаливый ноль', async () => {
    /*
     * Инвариант 11 (01-domain-model §Инварианты): «курс недоступен → приход попадает в unresolved,
     * а не в молчаливый ноль». Ядро (`expectedIncomeForPeriod`) это соблюдает и покрыто тестом —
     * но связку с HTTP-ответом `/v1/plan/current` до этого теста не проверял никто: неверная
     * сериализация или потерянное поле по пути от ядра до DTO прошли бы незамеченными.
     *
     * Курс KZT намеренно не сидим заранее — источник в валюте, для которой котировки никогда не
     * было, тот же случай, что и «котировка пропала».
     */
    const client = await onboarded({ payoutMinor: '30000000' });
    await forgetRate('KZT', 'RUB');
    await expectOk(
      await client.post('/v1/income-sources', {
        label: 'Фриланс в тенге',
        currency: 'KZT',
        schedule: { kind: 'monthly-days', days: [10, 25] },
        amount: { kind: 'absolute', amountMinor: '5000000' },
        stability: 'variable',
      }),
      201,
    );

    const plan = await getPlan(client);
    const unresolved = plan.income.unresolved.find((e) => e.currency === 'KZT');
    expect(unresolved).toBeTruthy();
    expect(unresolved?.reason).toBe('rate_unavailable');

    // Событие видно в общем списке (не спрятано) — просто без суммы в базовой валюте.
    expect(plan.income.events.some((e) => e.currency === 'KZT')).toBe(true);

    /*
     * Доход основного источника (300 000 ₽ на 10 и 25) считается по нормальным событиям —
     * непрошедшая валюта не должна ни обнулить его молча, ни (что было бы другой ошибкой)
     * прибавить к нему выдуманную сумму.
     */
    expect(BigInt(plan.incomeMinor)).toBeGreaterThan(0n);
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
