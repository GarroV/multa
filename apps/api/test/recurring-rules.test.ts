import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded, type TestClient } from './client.ts';

/**
 * Новые правила повтора платежа (issue #55): «N-й день недели месяца», «ежегодно», «в каждую
 * выплату», плюс срок жизни платежа и тумблер «показывать на карте периода».
 *
 * Главное, что здесь проверяется, — правило не должно молча не сработать. Пятого вторника в
 * месяце может не быть, поэтому «пятая неделя» хранится как «последняя»; отменённая подписка
 * перестаёт быть событием, но не исчезает из истории.
 */

interface RecurringDto {
  id: string;
  name: string;
  schedule: { kind: string; [k: string]: unknown };
  startsOn: string | null;
  endsOn: string | null;
  showOnMap: boolean;
}

interface ForecastDto {
  dueSoon: { id: string; name: string; on: string; showOnMap: boolean }[];
}

const create = async (client: TestClient, body: Record<string, unknown>): Promise<RecurringDto> =>
  expectOk<RecurringDto>(
    await client.post('/v1/recurring-items', {
      name: 'Платёж',
      amountMinor: '150000',
      currency: 'RUB',
      ...body,
    }),
    201,
  );

describe('правила повтора платежа', () => {
  test('«второй вторник месяца» принимается и сохраняется как есть', async () => {
    const client = await onboarded();
    const item = await create(client, {
      name: 'Уборка',
      schedule: { kind: 'monthly-nth-weekday', nth: 2, weekday: 2 },
    });
    expect(item.schedule).toEqual({ kind: 'monthly-nth-weekday', nth: 2, weekday: 2 });
  });

  test('«последний» хранится как -1, а «пятый» отклоняется', async () => {
    /*
     * Пятого вторника в июле нет, а в сентябре есть. Правило «пятый» молчало бы в половине
     * месяцев — платёж пропадал бы без сигнала, поэтому такого правила не существует вовсе.
     */
    const client = await onboarded();
    const last = await create(client, {
      schedule: { kind: 'monthly-nth-weekday', nth: -1, weekday: 2 },
    });
    expect(last.schedule).toMatchObject({ nth: -1 });

    const res = await client.post('/v1/recurring-items', {
      name: 'Пятый вторник',
      amountMinor: '100000',
      currency: 'RUB',
      schedule: { kind: 'monthly-nth-weekday', nth: 5, weekday: 2 },
    });
    expect(res.status).toBe(400);
  });

  test('«в каждую выплату» попадает в прогноз ровно один раз', async () => {
    const client = await onboarded();
    const plan = await getPlan(client);
    await create(client, { name: 'Аренда', schedule: { kind: 'each-payout' } });

    const forecast = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    const rent = forecast.dueSoon.filter((d) => d.name === 'Аренда');
    expect(rent).toHaveLength(1);
    // Дата — начало периода: ритм воркспейса уже учтён, платёж не считается дважды.
    expect(rent[0]?.on).toBe(plan.period.startsOn);
  });

  test('«ежегодно» принимается вместе с 29 февраля', async () => {
    const client = await onboarded();
    const item = await create(client, {
      name: 'Страховка',
      schedule: { kind: 'yearly', month: 2, day: 29 },
    });
    expect(item.schedule).toEqual({ kind: 'yearly', month: 2, day: 29 });
  });

  test('отменённый платёж перестаёт быть событием, но остаётся в списке', async () => {
    const client = await onboarded();
    const plan = await getPlan(client);
    const item = await create(client, { name: 'Подписка', schedule: { kind: 'each-payout' } });

    const before = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    expect(before.dueSoon.some((d) => d.name === 'Подписка')).toBe(true);

    // Отменяем вчерашним днём относительно начала периода — событие уходит.
    const dayBefore = new Date(`${plan.period.startsOn}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    await expectOk(
      await client.patch(`/v1/recurring-items/${item.id}`, {
        endsOn: dayBefore.toISOString().slice(0, 10),
      }),
    );

    const after = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    expect(after.dueSoon.some((d) => d.name === 'Подписка')).toBe(false);
    // Из списка платёж не исчез: это история, а не удаление.
    const list = await expectOk<RecurringDto[]>(await client.get('/v1/recurring-items'));
    expect(list.some((r) => r.id === item.id)).toBe(true);
  });

  test('платёж, начинающийся позже, в текущем периоде не показывается', async () => {
    const client = await onboarded();
    const plan = await getPlan(client);
    await create(client, {
      name: 'Будущая подписка',
      schedule: { kind: 'each-payout' },
      startsOn: plan.period.endsOn,
    });
    const forecast = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    expect(forecast.dueSoon.some((d) => d.name === 'Будущая подписка')).toBe(false);
  });

  test('тумблер карты прячет метку, но не само событие', async () => {
    const client = await onboarded();
    const item = await create(client, {
      name: 'Тихий платёж',
      schedule: { kind: 'each-payout' },
      showOnMap: false,
    });
    expect(item.showOnMap).toBe(false);

    const forecast = await expectOk<ForecastDto>(await client.get('/v1/forecast'));
    const quiet = forecast.dueSoon.find((d) => d.name === 'Тихий платёж');
    // Событие на месте — иначе «что впереди» врало бы в пользу пользователя.
    expect(quiet).toBeDefined();
    expect(quiet?.showOnMap).toBe(false);
  });

  test('старые расписания продолжают читаться после расширения union', async () => {
    // schedule лежит в jsonb: переименование вида сделало бы нечитаемыми уже сохранённые строки.
    const client = await onboarded();
    for (const schedule of [
      { kind: 'monthly-days', days: [5] },
      { kind: 'every-weeks', weeks: 2, startsOn: '2026-07-01' },
      { kind: 'one-off', date: '2026-08-01' },
      { kind: 'irregular' },
    ]) {
      const item = await create(client, { schedule });
      expect(item.schedule).toEqual(schedule);
    }
  });
});
