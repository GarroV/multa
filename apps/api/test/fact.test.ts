import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, getPlan, onboarded, seedRate, type PlanDto } from './client.ts';

/**
 * Факт трат (Спринт 3): остаток по категориям и дневной темп считаются от факта, а не от плана.
 * Отдельно закреплено то, на чём уже ломались: агрегация по датам периода (а не по period_id)
 * и иммутабельный снапшот курса в транзакции (правило 2).
 */

function row(plan: PlanDto, targetId: string) {
  const hit = plan.allocations.find((a) => a.targetId === targetId);
  if (!hit) throw new Error(`строки ${targetId} нет в плане`);
  return hit;
}

/** Дата внутри текущего периода: сегодня, как его видит сервер в таймзоне воркспейса. */
async function periodOf(client: Awaited<ReturnType<typeof onboarded>>) {
  const plan = await getPlan(client);
  return plan.period;
}

describe('факт трат в плане', () => {
  test('трата уменьшает остаток категории и остаток на жизнь', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const food = await categoryId(client, 'Продукты');
    await expectOk<PlanDto>(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '4000000' }),
    );

    await expectOk(
      await client.post('/v1/transactions', {
        amountMinor: '150000',
        currency: 'RUB',
        categoryId: food,
      }),
      201,
    );

    const plan = await getPlan(client);
    expect(BigInt(row(plan, food).spentMinor)).toBe(150_000n);
    expect(BigInt(row(plan, food).remainingMinor)).toBe(3_850_000n);
    expect(BigInt(plan.spentLivingMinor)).toBe(150_000n);
    expect(BigInt(plan.remainingLivingMinor)).toBe(30_000_000n - 150_000n);
  });

  test('перерасход категории показывается отдельно, остаток не уходит в минус скрытно', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const cafe = await categoryId(client, 'Кафе');
    await expectOk<PlanDto>(
      await client.put(`/v1/plan/current/categories/${cafe}`, { plannedMinor: '500000' }),
    );

    await expectOk(
      await client.post('/v1/transactions', {
        amountMinor: '800000',
        currency: 'RUB',
        categoryId: cafe,
      }),
      201,
    );

    const plan = await getPlan(client);
    expect(BigInt(row(plan, cafe).spentMinor)).toBe(800_000n);
    expect(BigInt(row(plan, cafe).overspentMinor)).toBe(300_000n);
    expect(BigInt(row(plan, cafe).remainingMinor)).toBe(-300_000n);
  });

  test('дневной темп = остаток на жизнь ÷ дней до конца периода', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const plan = await getPlan(client);
    const expected = BigInt(plan.remainingLivingMinor) / BigInt(plan.daysLeft);
    expect(BigInt(plan.canSpendPerDayMinor)).toBe(expected);
  });

  test('трата задним числом попадает в свой период, а не в текущий', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const period = await periodOf(client);
    // День до начала текущего периода: чужой период, значит в текущем факта быть не должно.
    const before = new Date(new Date(`${period.startsOn}T00:00:00Z`).getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);

    await expectOk(
      await client.post('/v1/transactions', {
        amountMinor: '700000',
        currency: 'RUB',
        occurredOn: before,
      }),
      201,
    );

    const plan = await getPlan(client);
    expect(BigInt(plan.spentLivingMinor)).toBe(0n);

    // Список по умолчанию — тоже текущий период; явный диапазон должен её находить.
    const current = await expectOk<{ transactions: unknown[] }>(
      await client.get('/v1/transactions'),
    );
    expect(current.transactions).toHaveLength(0);
    const explicit = await expectOk<{ transactions: { occurredOn: string }[] }>(
      await client.get(`/v1/transactions?from=${before}&to=${period.startsOn}`),
    );
    expect(explicit.transactions.map((t) => t.occurredOn)).toEqual([before]);
  });

  test('трата в чужой валюте хранит снапшот курса и сумму в базовой', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const period = await periodOf(client);
    await seedRate('EUR', 'RUB', '100', period.startsOn);

    const tx = await expectOk<{
      amountMinor: string;
      baseAmountMinor: string;
      rate: string;
      rateSource: string;
      rateDate: string;
    }>(
      await client.post('/v1/transactions', {
        amountMinor: '1000',
        currency: 'EUR',
        occurredOn: period.startsOn,
      }),
      201,
    );

    expect(tx.amountMinor).toBe('1000');
    expect(tx.baseAmountMinor).toBe('100000');
    // numeric отдаётся с хвостом нулей — сравниваем значение, а не его запись.
    expect(Number(tx.rate)).toBe(100);
    expect(tx.rateSource).toBe('cbr');
    expect(tx.rateDate).toBe(period.startsOn);

    // Курс потом уточнили — история не пересчитывается (правило 2).
    await seedRate('EUR', 'RUB', '120', period.startsOn);
    const list = await expectOk<{ transactions: { baseAmountMinor: string; rate: string }[] }>(
      await client.get('/v1/transactions'),
    );
    expect(list.transactions[0]?.baseAmountMinor).toBe('100000');
    expect(list.transactions[0]?.rate).toBe(tx.rate);
  });

  test('без курса на дату трата в чужой валюте не записывается', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const res = await client.post('/v1/transactions', { amountMinor: '5000', currency: 'JPY' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'rate_unavailable' });
  });

  test('внеплановый приход поднимает доход периода и не требует категории', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const withCategory = await client.post('/v1/transactions', {
      kind: 'income',
      amountMinor: '2000000',
      currency: 'RUB',
      categoryId: await categoryId(client, 'Продукты'),
    });
    expect(withCategory.status).toBe(400);

    await expectOk(
      await client.post('/v1/transactions', {
        kind: 'income',
        amountMinor: '2000000',
        currency: 'RUB',
      }),
      201,
    );
    const plan = await getPlan(client);
    expect(BigInt(plan.extraIncomeMinor)).toBe(2_000_000n);
    expect(BigInt(plan.incomeMinor)).toBe(32_000_000n);
  });

  test('удаление траты возвращает остаток на место', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const food = await categoryId(client, 'Продукты');
    const tx = await expectOk<{ id: string }>(
      await client.post('/v1/transactions', {
        amountMinor: '300000',
        currency: 'RUB',
        categoryId: food,
      }),
      201,
    );
    expect((await client.del(`/v1/transactions/${tx.id}`)).status).toBe(204);

    const plan = await getPlan(client);
    expect(BigInt(plan.spentLivingMinor)).toBe(0n);
  });
});

describe('разбор фразы', () => {
  test('regex-парсер узнаёт сумму и категорию, ничего не записывая', async () => {
    const client = await onboarded();
    const parsed = await expectOk<{
      source: string;
      amountMinor: string;
      currency: string;
      categoryId: string | null;
      categoryName: string | null;
    }>(await client.post('/v1/transactions/parse', { text: '250 продукты' }));

    expect(parsed.source).toBe('regex');
    expect(parsed.amountMinor).toBe('25000');
    expect(parsed.currency).toBe('RUB');
    expect(parsed.categoryId).toBe(await categoryId(client, 'Продукты'));

    // Разбор — это ещё не факт: транзакция появляется только по подтверждению.
    const list = await expectOk<{ transactions: unknown[] }>(await client.get('/v1/transactions'));
    expect(list.transactions).toHaveLength(0);
  });

  test('фраза без суммы и без ключа OpenAI отвечает 422, а не случайной тратой', async () => {
    const client = await onboarded();
    const res = await client.post('/v1/transactions/parse', { text: 'что-то потратил' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'not_understood' });
  });
});

describe('офлайн-очередь: повтор попытки (Спринт 6)', () => {
  /*
   * Трата, записанная без сети, лежит в очереди клиента и отправляется повторно при появлении
   * связи. Клиент не может знать, дошла ли первая попытка: ответ мог не вернуться при уже
   * записанной трате. Без ключа попытки повтор создавал бы вторую такую же трату — человек увидел
   * бы двойной расход и не понял бы, откуда он.
   */
  const attempt = '11111111-2222-3333-4444-555555555555';

  test('вторая отправка с тем же ключом отдаёт ту же трату, а не создаёт новую', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const body = {
      amountMinor: '125000',
      currency: 'RUB',
      occurredOn: '2026-08-01',
      clientKey: attempt,
    };

    const first = await expectOk<{ id: string }>(await client.post('/v1/transactions', body), 201);
    // 200, а не 201: это не ошибка и не новая запись, а «уже сделано».
    const second = await expectOk<{ id: string }>(await client.post('/v1/transactions', body), 200);
    expect(second.id).toBe(first.id);

    const list = await expectOk<{ transactions: unknown[] }>(
      await client.get('/v1/transactions?from=2026-01-01&to=2027-01-01'),
    );
    expect(list.transactions).toHaveLength(1);
  });

  test('без ключа две одинаковые траты остаются двумя: человек мог купить кофе дважды', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const body = { amountMinor: '125000', currency: 'RUB', occurredOn: '2026-08-01' };
    await expectOk(await client.post('/v1/transactions', body), 201);
    await expectOk(await client.post('/v1/transactions', body), 201);

    const list = await expectOk<{ transactions: unknown[] }>(
      await client.get('/v1/transactions?from=2026-01-01&to=2027-01-01'),
    );
    expect(list.transactions).toHaveLength(2);
  });

  test('ключ чужого воркспейса не мешает: он уникален внутри своего', async () => {
    const alice = await onboarded({ payoutMinor: '30000000' });
    const bob = await onboarded({ payoutMinor: '30000000' });
    const body = {
      amountMinor: '125000',
      currency: 'RUB',
      occurredOn: '2026-08-01',
      clientKey: attempt,
    };
    await expectOk(await alice.post('/v1/transactions', body), 201);
    await expectOk(await bob.post('/v1/transactions', body), 201);
  });
});
