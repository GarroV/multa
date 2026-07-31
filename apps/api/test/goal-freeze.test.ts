import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded, type TestClient } from './client.ts';

/**
 * Заморозка цели на период (issue #54). Пропуск взноса — осознанное решение, а не сжатие каскада и
 * не удаление цели: деньги этого периода уходят на другое, накопленное остаётся, срок сдвигается.
 *
 * Домен просит не молчать о пропусках (01-domain-model §Исполнение), поэтому заморозка попадает в
 * историю правок и снимается тем же способом, каким включена.
 */

interface GoalRow {
  id: string;
  name: string;
}

interface RevisionDto {
  id: string;
  kind: 'move' | 'freeze' | 'unfreeze';
  moves: { fromName: string | null; amountMinor: string }[];
}

async function addGoal(client: TestClient, plannedPerPeriodMinor: string): Promise<GoalRow> {
  return expectOk<GoalRow>(
    await client.post('/v1/goals', {
      name: 'Мотоцикл',
      currency: 'RUB',
      targetMinor: '40000000',
      plannedPerPeriodMinor,
    }),
    201,
  );
}

describe('заморозка цели', () => {
  test('замороженная цель не получает взнос, а деньги остаются свободными', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(client, '5000000');

    const before = await getPlan(client);
    expect(BigInt(before.allocations.find((a) => a.targetId === goal.id)!.allocatedMinor)).toBe(
      5_000_000n,
    );
    const freeBefore = BigInt(before.freeMinor);

    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/freeze`));

    const after = await getPlan(client);
    const row = after.allocations.find((a) => a.targetId === goal.id)!;
    expect(BigInt(row.allocatedMinor)).toBe(0n);
    expect(row.frozen).toBe(true);
    // Освободившиеся деньги не исчезают: они видны как свободные к концу периода.
    expect(BigInt(after.freeMinor)).toBe(freeBefore + 5_000_000n);
  });

  test('накопленное не обнуляется, а цель не удаляется', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(client, '5000000');
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/freeze`));

    const goals = await expectOk<{ id: string; savedMinor: string }[]>(
      await client.get('/v1/goals'),
    );
    const stored = goals.find((g) => g.id === goal.id);
    expect(stored).toBeDefined();
    expect(BigInt(stored!.savedMinor)).toBe(0n);
  });

  test('заморозка и снятие попадают в историю правок', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(client, '5000000');

    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/freeze`));
    const afterFreeze = await expectOk<RevisionDto[]>(
      await client.get('/v1/plan/current/revisions'),
    );
    expect(afterFreeze[0]?.kind).toBe('freeze');
    expect(afterFreeze[0]?.moves[0]?.fromName).toBe('Мотоцикл');
    expect(afterFreeze[0]?.moves[0]?.amountMinor).toBe('5000000');

    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/unfreeze`));
    const afterUnfreeze = await expectOk<RevisionDto[]>(
      await client.get('/v1/plan/current/revisions'),
    );
    expect(afterUnfreeze[0]?.kind).toBe('unfreeze');
    expect(afterUnfreeze).toHaveLength(2);
  });

  test('снятие заморозки возвращает взнос в план', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(client, '5000000');
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/freeze`));
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/unfreeze`));

    const plan = await getPlan(client);
    const row = plan.allocations.find((a) => a.targetId === goal.id)!;
    expect(BigInt(row.allocatedMinor)).toBe(5_000_000n);
    expect(row.frozen).toBe(false);
  });

  test('повторная заморозка не плодит записей истории', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(client, '5000000');
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/freeze`));
    expect((await client.post(`/v1/plan/current/items/goal/${goal.id}/freeze`)).status).toBe(409);

    const list = await expectOk<RevisionDto[]>(await client.get('/v1/plan/current/revisions'));
    expect(list).toHaveLength(1);
  });

  test('заморозить можно только цель: у долга и корзины такого выбора нет', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const debt = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Кредит',
        currency: 'RUB',
        principalMinor: '10000000',
        remainingMinor: '10000000',
        paymentMinor: '1000000',
      }),
      201,
    );
    await getPlan(client);
    // Долги и валютные корзины автоматика не трогает никогда — руками тоже не пропускаем.
    expect((await client.post(`/v1/plan/current/items/debt/${debt.id}/freeze`)).status).toBe(400);
  });

  test('нельзя заморозить взнос, который уже отложен', async () => {
    // Деньги отложены и транзакция расхода существует: «освобождение» этой суммы показало бы её
    // свободной второй раз (найдено адверсарным аудитом).
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(client, '5000000');
    await getPlan(client);
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/confirm`, {}));

    const res = await client.post(`/v1/plan/current/items/goal/${goal.id}/freeze`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'freeze_after_execution' });

    // Сначала отмена исполнения, потом заморозка — оба жеста осознанные.
    await expectOk(await client.post(`/v1/plan/current/items/goal/${goal.id}/skip`, {}));
    expect((await client.post(`/v1/plan/current/items/goal/${goal.id}/freeze`, {})).status).toBe(
      200,
    );
  });

  test('чужую цель заморозить нельзя', async () => {
    const alice = await onboarded({ payoutMinor: '30000000' });
    const goal = await addGoal(alice, '5000000');
    await getPlan(alice);

    const bob = await onboarded({ payoutMinor: '30000000' });
    expect((await bob.post(`/v1/plan/current/items/goal/${goal.id}/freeze`)).status).toBe(404);
  });
});
