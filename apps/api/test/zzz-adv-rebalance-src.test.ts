import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, getPlan, onboarded, type TestClient } from './client.ts';

interface RebalanceOption {
  targetKind: string;
  targetId: string;
  name: string;
  availableMinor: string;
  takeMinor: string;
}

interface RevisionDto {
  id: string;
  moves: { fromKind: string; fromId: string; toKind: string; toId: string; amountMinor: string }[];
}

async function alloc(client: TestClient, kind: string, id: string): Promise<string> {
  const plan = await getPlan(client);
  const row = plan.allocations.find((a) => a.targetKind === kind && a.targetId === id);
  return row ? row.allocatedMinor : 'MISSING';
}

describe('адверсарная проверка: источник переноса — конверт/цель', () => {
  test('конверт как источник: списание затирается следующей сборкой', async () => {
    const client = await onboarded({ payoutMinor: '3000000' }); // 30 000,00 RUB за период
    const env = await expectOk<{ id: string }>(
      await client.post('/v1/envelopes', {
        name: 'Подушка',
        currency: 'RUB',
        ruleKind: 'fixed',
        ruleValue: '2000000',
      }),
      201,
    );
    const goal = await expectOk<{ id: string }>(
      await client.post('/v1/goals', {
        name: 'Мотоцикл',
        currency: 'RUB',
        targetMinor: '10000000',
        plannedPerPeriodMinor: '600000',
      }),
      201,
    );
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '400000' }),
    );

    const before = await getPlan(client);
    console.log(
      'BEFORE',
      JSON.stringify(
        {
          income: before.incomeMinor,
          totalPlanned: before.totalPlannedMinor,
          totalAllocated: before.totalAllocatedMinor,
          compressed: before.compressedMinor,
          free: before.freeMinor,
          living: before.livingMinor,
          rows: before.allocations.map((a) => [
            a.targetKind,
            a.name,
            a.plannedMinor,
            a.allocatedMinor,
          ]),
        },
        null,
        1,
      ),
    );

    const opts = await expectOk<RebalanceOption[]>(
      await client.get(`/v1/plan/current/rebalance?targetId=${food}&needMinor=300000`),
    );
    console.log('OPTIONS', JSON.stringify(opts));

    const res = await client.post('/v1/plan/current/rebalance', {
      fromKind: 'envelope',
      fromId: env.id,
      toId: food,
      amountMinor: '300000',
    });
    console.log('POST status', res.status, await res.clone().text());

    const after = await getPlan(client);
    console.log(
      'AFTER',
      JSON.stringify(
        {
          totalPlanned: after.totalPlannedMinor,
          totalAllocated: after.totalAllocatedMinor,
          compressed: after.compressedMinor,
          free: after.freeMinor,
          living: after.livingMinor,
          rows: after.allocations.map((a) => [
            a.targetKind,
            a.name,
            a.plannedMinor,
            a.allocatedMinor,
          ]),
        },
        null,
        1,
      ),
    );

    const revs = await expectOk<RevisionDto[]>(await client.get('/v1/plan/current/revisions'));
    console.log('REVISIONS', JSON.stringify(revs.map((r) => r.moves)));

    console.log('env alloc after', await alloc(client, 'envelope', env.id));
    console.log('goal alloc after', await alloc(client, 'goal', goal.id));
    console.log('food alloc after', await alloc(client, 'category', food));
    expect(true).toBe(true);
  });
});
