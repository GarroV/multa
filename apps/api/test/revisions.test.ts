import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, getPlan, onboarded, type TestClient } from './client.ts';

/**
 * История ревизий плана (issue #52). Пересборка уже писалась в `plan_revisions` — по ней
 * ранжируются варианты «как обычно». Теперь история видна наружу и её можно откатить.
 *
 * Правило, которое здесь проверяется главным: **история не переписывается**. Откат — это ещё одна
 * ревизия, а не удаление прежней; иначе «как обычно» будет считаться по вычищенному прошлому.
 */

interface RevisionDto {
  id: string;
  reason: string;
  createdAt: string;
  undone: boolean;
  moves: {
    fromKind: string;
    fromId: string;
    fromName: string | null;
    toKind: string;
    toId: string;
    toName: string | null;
    amountMinor: string;
  }[];
}

/** Категория с бюджетом: пересборка переносит деньги между строками плана. */
async function withBudgets(client: TestClient): Promise<{ from: string; to: string }> {
  const from = await categoryId(client, 'Транспорт');
  const to = await categoryId(client, 'Продукты');
  await expectOk(
    await client.put(`/v1/plan/current/categories/${from}`, { plannedMinor: '5000000' }),
  );
  await expectOk(
    await client.put(`/v1/plan/current/categories/${to}`, { plannedMinor: '3000000' }),
  );
  return { from, to };
}

async function move(
  client: TestClient,
  from: string,
  to: string,
  amountMinor: string,
): Promise<void> {
  // fromKind обязателен в контракте: сервер всё равно перепроверяет вид строки по базе, но
  // запрос без него — это неполный запрос, а не «догадайся сам».
  await expectOk(
    await client.post('/v1/plan/current/rebalance', {
      fromKind: 'category',
      fromId: from,
      toId: to,
      amountMinor,
    }),
  );
}

describe('история ревизий', () => {
  test('пересборка попадает в историю с суммой, направлением и именами строк', async () => {
    const client = await onboarded();
    const { from, to } = await withBudgets(client);
    await move(client, from, to, '1500000');

    const list = await expectOk<RevisionDto[]>(await client.get('/v1/plan/current/revisions'));
    expect(list).toHaveLength(1);
    const first = list[0]!;
    expect(first.undone).toBe(false);
    expect(first.moves[0]?.amountMinor).toBe('1500000');
    expect(first.moves[0]?.fromId).toBe(from);
    expect(first.moves[0]?.toId).toBe(to);
    // Имена нужны, чтобы строка читалась без второго запроса: «+15 000 в Продукты из Транспорта».
    expect(first.moves[0]?.fromName).toBe('Транспорт');
    expect(first.moves[0]?.toName).toBe('Продукты');
  });

  test('откат возвращает суммы и сам становится ревизией', async () => {
    const client = await onboarded();
    const { from, to } = await withBudgets(client);
    await move(client, from, to, '1500000');

    const before = await getPlan(client);
    const fromBefore = before.allocations.find((a) => a.targetId === from)!;
    const toBefore = before.allocations.find((a) => a.targetId === to)!;
    expect(BigInt(fromBefore.allocatedMinor)).toBe(3_500_000n);
    expect(BigInt(toBefore.allocatedMinor)).toBe(4_500_000n);

    const [revision] = await expectOk<RevisionDto[]>(
      await client.get('/v1/plan/current/revisions'),
    );
    await expectOk(await client.post(`/v1/plan/current/revisions/${revision!.id}/undo`));

    const after = await getPlan(client);
    expect(BigInt(after.allocations.find((a) => a.targetId === from)!.allocatedMinor)).toBe(
      5_000_000n,
    );
    expect(BigInt(after.allocations.find((a) => a.targetId === to)!.allocatedMinor)).toBe(
      3_000_000n,
    );

    // История не переписывается: прежняя ревизия помечена откатанной, сам откат добавлен строкой.
    const list = await expectOk<RevisionDto[]>(await client.get('/v1/plan/current/revisions'));
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.id === revision!.id)?.undone).toBe(true);
    expect(list.some((r) => r.reason === 'manual' && r.moves[0]?.toId === from)).toBe(true);
  });

  test('повторный откат той же ревизии отклоняется', async () => {
    const client = await onboarded();
    const { from, to } = await withBudgets(client);
    await move(client, from, to, '1000000');
    const [revision] = await expectOk<RevisionDto[]>(
      await client.get('/v1/plan/current/revisions'),
    );

    await expectOk(await client.post(`/v1/plan/current/revisions/${revision!.id}/undo`));
    expect((await client.post(`/v1/plan/current/revisions/${revision!.id}/undo`)).status).toBe(409);
  });

  test('откат невозможен, если строка ушла бы в минус — честная ошибка, а не тихий ноль', async () => {
    const client = await onboarded();
    const { from, to } = await withBudgets(client);
    await move(client, from, to, '2000000');
    const [revision] = await expectOk<RevisionDto[]>(
      await client.get('/v1/plan/current/revisions'),
    );

    // Деньги, которые нужно вернуть, уже ушли дальше: в «Продуктах» осталось меньше перенесённого.
    // Получателю нужен бюджет периода — переносить можно только в строку, которая в плане есть.
    const home = await categoryId(client, 'Дом');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${home}`, { plannedMinor: '1000000' }),
    );
    await move(client, to, home, '4500000');

    const res = await client.post(`/v1/plan/current/revisions/${revision!.id}/undo`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'undo_would_go_negative' });

    // План не тронут: неудачный откат ничего не меняет.
    const plan = await getPlan(client);
    expect(BigInt(plan.allocations.find((a) => a.targetId === from)!.allocatedMinor)).toBe(
      3_000_000n,
    );
  });

  test('чужую историю не видно и откатить нельзя', async () => {
    const alice = await onboarded();
    const { from, to } = await withBudgets(alice);
    await move(alice, from, to, '1000000');
    const [revision] = await expectOk<RevisionDto[]>(await alice.get('/v1/plan/current/revisions'));

    const bob = await onboarded();
    const bobList = await expectOk<RevisionDto[]>(await bob.get('/v1/plan/current/revisions'));
    expect(bobList).toHaveLength(0);
    expect((await bob.post(`/v1/plan/current/revisions/${revision!.id}/undo`)).status).toBe(404);
  });
});

describe('пересборка из обязательства (находка аудита)', () => {
  /** Доход 30 000, категория 20 000, две цели по 5 000 — свободных денег нет. */
  async function tightPlan(client: TestClient) {
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '20000000' }),
    );
    const goalA = await expectOk<{ id: string }>(
      await client.post('/v1/goals', {
        name: 'Мотоцикл',
        currency: 'RUB',
        targetMinor: '40000000',
        plannedPerPeriodMinor: '5000000',
      }),
      201,
    );
    const goalB = await expectOk<{ id: string }>(
      await client.post('/v1/goals', {
        name: 'Отпуск',
        currency: 'RUB',
        targetMinor: '40000000',
        plannedPerPeriodMinor: '5000000',
      }),
      201,
    );
    await getPlan(client);
    return { food, goalA: goalA.id, goalB: goalB.id };
  }

  test('перенос из цели уменьшает именно её, а не все цели пропорционально', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const { food, goalA, goalB } = await tightPlan(client);

    await expectOk(
      await client.post('/v1/plan/current/rebalance', {
        fromKind: 'goal',
        fromId: goalA,
        toId: food,
        amountMinor: '2000000',
      }),
    );

    const plan = await getPlan(client);
    const a = plan.allocations.find((x) => x.targetId === goalA)!;
    const b = plan.allocations.find((x) => x.targetId === goalB)!;
    const cat = plan.allocations.find((x) => x.targetId === food)!;
    // Уступила выбранная цель. Раньше списание затиралось пересборкой из таблицы целей, дефицит
    // закрывал каскад — и «Отпуск», который никто не выбирал, терял половину.
    expect(BigInt(a.allocatedMinor)).toBe(3_000_000n);
    expect(BigInt(b.allocatedMinor)).toBe(5_000_000n);
    expect(BigInt(cat.allocatedMinor)).toBe(22_000_000n);
    expect(BigInt(plan.compressedMinor)).toBe(0n);
  });

  test('прибавка выживает и при порядке сжатия «категории первыми»', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const { food, goalA } = await tightPlan(client);
    await expectOk(
      await client.patch('/v1/workspace/settings', {
        cascade: { compressOrder: ['category', 'envelope', 'goal'] },
      }),
    );

    await expectOk(
      await client.post('/v1/plan/current/rebalance', {
        fromKind: 'goal',
        fromId: goalA,
        toId: food,
        amountMinor: '2000000',
      }),
    );

    const plan = await getPlan(client);
    // Жест обязан что-то менять: раньше при этой настройке каскад срезал категории первыми и
    // съедал ровно ту прибавку, ради которой пересборку и делали.
    expect(BigInt(plan.allocations.find((x) => x.targetId === food)!.allocatedMinor)).toBe(
      22_000_000n,
    );
    expect(BigInt(plan.compressedMinor)).toBe(0n);
  });

  test('откат возвращает взнос цели к её собственной сумме', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const { food, goalA, goalB } = await tightPlan(client);
    await expectOk(
      await client.post('/v1/plan/current/rebalance', {
        fromKind: 'goal',
        fromId: goalA,
        toId: food,
        amountMinor: '2000000',
      }),
    );
    const [revision] = await expectOk<RevisionDto[]>(
      await client.get('/v1/plan/current/revisions'),
    );
    await expectOk(await client.post(`/v1/plan/current/revisions/${revision!.id}/undo`));

    const plan = await getPlan(client);
    expect(BigInt(plan.allocations.find((x) => x.targetId === goalA)!.allocatedMinor)).toBe(
      5_000_000n,
    );
    /*
     * Переопределение периода снято, а не «заморожено» на прежней сумме. Проверяем это так: после
     * добавления третьей цели денег не хватает, и обе прежние цели обязаны уступить ОДИНАКОВО —
     * если бы у goalA осталась метка правки, каскад её не тронул бы, и весь дефицит лёг на goalB.
     */
    await expectOk(
      await client.post('/v1/goals', {
        name: 'Ещё цель',
        currency: 'RUB',
        targetMinor: '1000000',
        plannedPerPeriodMinor: '1000000',
      }),
      201,
    );
    const after = await getPlan(client);
    const a2 = BigInt(after.allocations.find((x) => x.targetId === goalA)!.allocatedMinor);
    const b2 = BigInt(after.allocations.find((x) => x.targetId === goalB)!.allocatedMinor);
    expect(a2).toBeLessThan(5_000_000n);
    // Разница в одну копейку законна: метод наибольшего остатка отдаёт неделимый остаток одной из
    // строк, чтобы сумма долей точно совпала с дефицитом.
    const diff = a2 > b2 ? a2 - b2 : b2 - a2;
    expect(diff).toBeLessThanOrEqual(1n);
  });
});
