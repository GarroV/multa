import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded, signedUp } from './client.ts';

/**
 * Прогноз-таймлайн (Спринт 4) и регулярные платежи (#21): «что впереди» должно включать
 * платежи, которых нет ни в обязательствах, ни в факте, — иначе лента врёт в пользу пользователя.
 */

interface ForecastDto {
  horizonPeriods: number;
  dueSoon: { id: string; name: string; amountMinor: string; currency: string; on: string }[];
  events: {
    kind: string;
    targetId: string;
    name: string;
    on: string;
    periodsAway: number;
    amountMinor: string | null;
  }[];
}

describe('прогноз', () => {
  test('долг закрывается через расчётное число периодов', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const debt = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Кредит',
        currency: 'RUB',
        principalMinor: '3000000',
        remainingMinor: '3000000',
        paymentMinor: '1000000',
      }),
      201,
    );

    const forecast = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    const closing = forecast.events.find((e) => e.targetId === debt.id);
    expect(closing?.kind).toBe('debt_closed');
    expect(closing?.periodsAway).toBe(3);
  });

  test('цель без взноса помечается риском, а не тихо пропускается', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const goal = await expectOk<{ id: string }>(
      await client.post('/v1/goals', {
        name: 'Отпуск',
        currency: 'RUB',
        targetMinor: '10000000',
      }),
      201,
    );

    const forecast = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    const risk = forecast.events.find((e) => e.targetId === goal.id);
    // Без взноса цель не соберётся на горизонте — показываем недостающую сумму, а не молчим.
    expect(risk?.kind).toBe('goal_at_risk');
    expect(risk?.amountMinor).toBe('10000000');
    expect(risk?.periodsAway).toBe(forecast.horizonPeriods);
  });

  test('регулярный платёж текущего периода виден в «скоро»', async () => {
    const client = await onboarded({ payoutMinor: '30000000', days: [10, 25] });
    const plan = await getPlan(client);
    // День внутри текущего периода — платёж должен попасть в dueSoon.
    const day = Number(plan.period.startsOn.slice(8, 10));
    const item = await expectOk<{ id: string }>(
      await client.post('/v1/recurring-items', {
        name: 'Подписка',
        amountMinor: '99900',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [day] },
      }),
      201,
    );

    const forecast = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    const due = forecast.dueSoon.find((d) => d.id === item.id);
    expect(due?.amountMinor).toBe('99900');
    expect(due?.on).toBe(plan.period.startsOn);
  });

  test('выключенный регулярный платёж из «скоро» исчезает', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const plan = await getPlan(client);
    const day = Number(plan.period.startsOn.slice(8, 10));
    const item = await expectOk<{ id: string }>(
      await client.post('/v1/recurring-items', {
        name: 'Уборка',
        amountMinor: '500000',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [day] },
      }),
      201,
    );
    await expectOk(await client.patch(`/v1/recurring-items/${item.id}`, { active: false }));

    const forecast = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    expect(forecast.dueSoon.some((d) => d.id === item.id)).toBe(false);
  });

  test('без воркспейса прогноз отвечает 409, а не пустой лентой', async () => {
    const client = await signedUp();
    const res = await client.get('/v1/forecast');
    expect(res.status).toBe(409);
  });
});

describe('регулярные платежи', () => {
  test('доход регулярным платежом не заводится: он живёт в источниках дохода', async () => {
    const client = await onboarded();
    const res = await client.post('/v1/recurring-items', {
      kind: 'income',
      name: 'Подработка',
      amountMinor: '1000000',
      currency: 'RUB',
      schedule: { kind: 'monthly-days', days: [5] },
    });
    expect(res.status).toBe(400);
  });

  test('CRUD: создание, правка суммы, удаление', async () => {
    const client = await onboarded();
    const created = await expectOk<{ id: string; amountMinor: string; active: boolean }>(
      await client.post('/v1/recurring-items', {
        name: 'Интернет',
        amountMinor: '120000',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [5] },
      }),
      201,
    );
    expect(created.active).toBe(true);

    const patched = await expectOk<{ amountMinor: string }>(
      await client.patch(`/v1/recurring-items/${created.id}`, { amountMinor: '150000' }),
    );
    expect(patched.amountMinor).toBe('150000');

    expect((await client.del(`/v1/recurring-items/${created.id}`)).status).toBe(204);
    const rest = await expectOk<unknown[]>(await client.get('/v1/recurring-items'));
    expect(rest).toHaveLength(0);
  });
});

describe('горизонт прогноза (#103)', () => {
  test('редкий платёж за пределами текущего периода виден заранее', async () => {
    /*
     * Лента звала recurringDueIn на ОДИН период при горизонте в 12 и потому дублировала карту
     * периода: ежегодная страховка через несколько месяцев не появлялась вовсе. Ради таких
     * предупреждений — «в декабре списание, готовься» — прогноз и существует.
     */
    const client = await onboarded();
    const on = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    await expectOk(
      await client.post('/v1/recurring-items', {
        name: 'Страховка',
        amountMinor: '4500000',
        currency: 'RUB',
        schedule: { kind: 'yearly', month: Number(on.slice(5, 7)), day: Number(on.slice(8, 10)) },
      }),
      201,
    );

    const forecast = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    expect(forecast.events.some((e) => e.kind === 'recurring_due' && e.name === 'Страховка')).toBe(
      true,
    );
  });

  test('ступень платежа сдвигает дату закрытия долга', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const debt = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Кредит',
        currency: 'RUB',
        principalMinor: '3000000',
        remainingMinor: '3000000',
        paymentMinor: '100000',
      }),
      201,
    );
    // По сегодняшнему платежу 3 000 000 / 100 000 = 30 периодов — за горизонтом, события нет.
    const before = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    expect(before.events.some((e) => e.targetId === debt.id)).toBe(false);

    const from = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await expectOk(
      await client.patch(`/v1/debts/${debt.id}`, {
        amountSteps: [{ from, amountMinor: '900000' }],
      }),
    );

    const after = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    expect(after.events.some((e) => e.kind === 'debt_closed' && e.targetId === debt.id)).toBe(true);
  });
});
