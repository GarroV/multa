import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, getPlan, onboarded, type PlanDto } from './client.ts';

/**
 * Каскад приоритетов и сжатие при нехватке (железное правило 3):
 * раздача — debts → buckets → envelopes → categories → goals,
 * сжатие — обратным ходом: цели → конверты → категории; долги и корзины не режутся никогда.
 */

function row(plan: PlanDto, targetId: string) {
  const hit = plan.allocations.find((a) => a.targetId === targetId);
  if (!hit) throw new Error(`строки ${targetId} нет в плане`);
  return hit;
}

describe('сборка плана каскадом', () => {
  test('план собирается на доход периода и пресет-категории без бюджетов', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const plan = await getPlan(client);

    expect(plan.baseCurrency).toBe('RUB');
    expect(BigInt(plan.incomeMinor)).toBe(30_000_000n);
    // Бюджеты не заданы → всё свободно, ничего не сжато.
    expect(BigInt(plan.totalAllocatedMinor)).toBe(0n);
    expect(BigInt(plan.compressedMinor)).toBe(0n);
    expect(BigInt(plan.freeMinor)).toBe(30_000_000n);
    expect(plan.daysLeft).toBeGreaterThan(0);
  });

  test('долг и цель раздаются по приоритету, свободное уменьшается', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const debt = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Кредит',
        currency: 'RUB',
        principalMinor: '50000000',
        remainingMinor: '40000000',
        paymentMinor: '5000000',
      }),
      201,
    );
    const goal = await expectOk<{ id: string }>(
      await client.post('/v1/goals', {
        name: 'Отпуск',
        currency: 'RUB',
        targetMinor: '60000000',
        plannedPerPeriodMinor: '3000000',
      }),
      201,
    );

    const plan = await getPlan(client);
    expect(BigInt(row(plan, debt.id).allocatedMinor)).toBe(5_000_000n);
    expect(BigInt(row(plan, goal.id).allocatedMinor)).toBe(3_000_000n);
    expect(BigInt(plan.freeMinor)).toBe(30_000_000n - 8_000_000n);
  });

  test('при нехватке режется цель, а долг остаётся целым', async () => {
    // Доход меньше суммы обязательств: 10 000.00 против 9 000.00 долга + 5 000.00 цели.
    const client = await onboarded({ payoutMinor: '1000000' });
    const debt = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Кредит',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '900000',
      }),
      201,
    );
    const goal = await expectOk<{ id: string }>(
      await client.post('/v1/goals', {
        name: 'Отпуск',
        currency: 'RUB',
        targetMinor: '5000000',
        plannedPerPeriodMinor: '500000',
      }),
      201,
    );

    const plan = await getPlan(client);
    expect(BigInt(row(plan, debt.id).allocatedMinor)).toBe(900_000n);
    expect(BigInt(row(plan, debt.id).shortfallMinor)).toBe(0n);
    // Цель — последняя в раздаче и первая в сжатии: ей достаётся остаток дохода.
    expect(BigInt(row(plan, goal.id).allocatedMinor)).toBe(100_000n);
    expect(BigInt(row(plan, goal.id).shortfallMinor)).toBe(400_000n);
    expect(BigInt(plan.compressedMinor)).toBe(400_000n);
    expect(BigInt(plan.freeMinor)).toBe(0n);
  });

  test('бюджет категории ставится и снимается, план пересобирается сразу', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const food = await categoryId(client, 'Продукты');

    const withBudget = await expectOk<PlanDto>(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '4000000' }),
    );
    expect(BigInt(row(withBudget, food).allocatedMinor)).toBe(4_000_000n);
    // Категории — часть «на жизнь», а не отдельная строка сверху свободного остатка.
    expect(BigInt(withBudget.livingMinor)).toBe(30_000_000n);

    /*
     * Снятый бюджет зануляет строку, но не убирает её (пересмотрено 19.08.2026 — жалоба владельца
     * «продукты не добавляются»). Раньше категория без planned_items исчезала из allocations
     * целиком, включая только что заведённую: чтобы задать бюджет, нужна была строка, а строка
     * появлялась только после бюджета — замкнутый круг, тот же, что для долгов уже был закрыт в
     * issue #120 («в таблице чего-то долга не вижу»). Категория с нулём — категория, к которой
     * можно вернуться и что-то вписать, а не небытие.
     */
    const cleared = await expectOk<PlanDto>(
      await client.del(`/v1/plan/current/categories/${food}`),
    );
    expect(row(cleared, food).allocatedMinor).toBe('0');
    expect(BigInt(cleared.totalAllocatedMinor)).toBe(0n);
  });

  test('отрицательный бюджет категории отклоняется валидацией', async () => {
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    const res = await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '-1' });
    expect(res.status).toBe(400);
  });
});
