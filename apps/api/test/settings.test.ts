import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, getPlan, onboarded, type TestClient } from './client.ts';

/**
 * Настройки воркспейса (issue #49). Проверяется не «сохранилось ли поле», а то, что настройка
 * **меняет поведение**: буфер уменьшает дневной темп, порядок сжатия меняет, кто уступает первым,
 * горизонт медианы меняет аналитику, выключенные советы перестают приходить.
 *
 * Отдельно закреплён неснимаемый инвариант: какой бы порядок ни попросили, долги и валютные
 * корзины автоматика не режет (железное правило 3).
 */

interface SettingsDto {
  periods: { suggestRaises: boolean };
  currency: {
    rateSource: 'cbr' | 'ecb' | 'manual';
    defaultSpreadBp: number;
    defaultProvider: string | null;
  };
  cascade: { bufferPct: number; compressOrder: ('goal' | 'envelope' | 'category')[] };
  signals: { burnThresholdDays: number; medianPeriods: number };
}

const PAST_DAYS = ['2026-06-26', '2026-06-11', '2026-05-27', '2026-05-12'];

async function patch(client: TestClient, body: unknown): Promise<SettingsDto> {
  return expectOk<SettingsDto>(await client.patch('/v1/workspace/settings', body));
}

describe('настройки воркспейса', () => {
  test('дефолты отдаются сразу, до любой правки', async () => {
    const client = await onboarded();
    const settings = await expectOk<SettingsDto>(await client.get('/v1/workspace/settings'));
    expect(settings.cascade.bufferPct).toBe(0);
    // Порядок по умолчанию — решение основателя: первыми уступают цели.
    expect(settings.cascade.compressOrder).toEqual(['goal', 'envelope', 'category']);
    expect(settings.signals.medianPeriods).toBe(6);
    expect(settings.periods.suggestRaises).toBe(true);
  });

  test('правка частичная: тронутое меняется, остальное остаётся', async () => {
    const client = await onboarded();
    const updated = await patch(client, { cascade: { bufferPct: 10 } });
    expect(updated.cascade.bufferPct).toBe(10);
    // Порядок сжатия не передавали — он обязан остаться дефолтным, а не обнулиться.
    expect(updated.cascade.compressOrder).toEqual(['goal', 'envelope', 'category']);
    expect(updated.signals.medianPeriods).toBe(6);
  });

  test('буфер уменьшает дневной темп, но не остаток', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const before = await getPlan(client);
    const paceBefore = BigInt(before.canSpendPerDayMinor);
    const livingBefore = BigInt(before.livingMinor);

    await patch(client, { cascade: { bufferPct: 10 } });
    const after = await getPlan(client);

    expect(BigInt(after.canSpendPerDayMinor)).toBeLessThan(paceBefore);
    // Деньги не исчезли: остаток на жизнь тот же, отложенное показано отдельным полем.
    expect(BigInt(after.livingMinor)).toBe(livingBefore);
    expect(BigInt(after.bufferMinor)).toBeGreaterThan(0n);
  });

  test('порядок сжатия меняет, кто уступает первым', async () => {
    const client = await onboarded({ payoutMinor: '20000000' });
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '15000000' }),
    );
    await expectOk(
      await client.post('/v1/goals', {
        name: 'Мотоцикл',
        currency: 'RUB',
        targetMinor: '40000000',
        plannedPerPeriodMinor: '15000000',
      }),
      201,
    );

    const byDefault = await getPlan(client);
    const goalDefault = byDefault.allocations.find((a) => a.targetKind === 'goal')!;
    const catDefault = byDefault.allocations.find((a) => a.targetId === food)!;
    expect(BigInt(goalDefault.allocatedMinor)).toBeLessThan(BigInt(catDefault.allocatedMinor));

    await patch(client, { cascade: { compressOrder: ['category', 'envelope', 'goal'] } });
    const flipped = await getPlan(client);
    const goalFlipped = flipped.allocations.find((a) => a.targetKind === 'goal')!;
    const catFlipped = flipped.allocations.find((a) => a.targetId === food)!;
    expect(BigInt(catFlipped.allocatedMinor)).toBeLessThan(BigInt(goalFlipped.allocatedMinor));
  });

  test('долг не режется даже если настройка просит резать его первым', async () => {
    const client = await onboarded({ payoutMinor: '10000000' });
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Кредит',
        currency: 'RUB',
        principalMinor: '50000000',
        remainingMinor: '50000000',
        paymentMinor: '12000000',
      }),
      201,
    );
    // Пытаемся протащить неприкосновенный вид в порядок сжатия — схема обязана отказать.
    expect(
      (
        await client.patch('/v1/workspace/settings', {
          cascade: { compressOrder: ['debt', 'goal'] },
        })
      ).status,
    ).toBe(400);

    const plan = await getPlan(client);
    const debt = plan.allocations.find((a) => a.targetKind === 'debt')!;
    expect(BigInt(debt.allocatedMinor)).toBe(12_000_000n);
  });

  test('горизонт медианы из настроек применяется к аналитике', async () => {
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    for (const day of PAST_DAYS) {
      await expectOk(
        await client.post('/v1/transactions', {
          amountMinor: '1000000',
          currency: 'RUB',
          categoryId: food,
          occurredOn: day,
        }),
        201,
      );
    }

    await patch(client, { signals: { medianPeriods: 2 } });
    const rows = await expectOk<{ categoryId: string; series: unknown[] }[]>(
      await client.get('/v1/analytics/categories'),
    );
    expect(rows.find((r) => r.categoryId === food)!.series).toHaveLength(2);
  });

  test('горизонт из настроек и горизонт советов в плане — один и тот же', async () => {
    // Расхождение здесь означало бы два разных вердикта по одной категории на двух экранах:
    // «Статистика» просила ровно шесть периодов, пока настройка говорила другое (найдено аудитом).
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '1000000' }),
    );
    for (const day of PAST_DAYS) {
      await expectOk(
        await client.post('/v1/transactions', {
          amountMinor: '2400000',
          currency: 'RUB',
          categoryId: food,
          occurredOn: day,
        }),
        201,
      );
    }

    await patch(client, { signals: { medianPeriods: 3 } });
    const plan = await getPlan(client);
    const advice = plan.allocations.find((a) => a.targetId === food)?.advice;
    const rows = await expectOk<{ categoryId: string; periods: number }[]>(
      await client.get('/v1/analytics/categories'),
    );
    const row = rows.find((r) => r.categoryId === food)!;
    expect(advice?.periods).toBe(3);
    expect(row.periods).toBe(3);
  });

  test('выключенные советы перестают приходить в план', async () => {
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '1000000' }),
    );
    for (const day of PAST_DAYS.slice(0, 3)) {
      await expectOk(
        await client.post('/v1/transactions', {
          amountMinor: '2400000',
          currency: 'RUB',
          categoryId: food,
          occurredOn: day,
        }),
        201,
      );
    }
    const withAdvice = await getPlan(client);
    expect(withAdvice.allocations.find((a) => a.targetId === food)?.advice).toBeDefined();

    await patch(client, { periods: { suggestRaises: false } });
    const without = await getPlan(client);
    expect(without.allocations.find((a) => a.targetId === food)?.advice).toBeUndefined();
  });

  test('мусор отклоняется: буфер вне диапазона, неизвестный источник курса', async () => {
    const client = await onboarded();
    expect(
      (await client.patch('/v1/workspace/settings', { cascade: { bufferPct: 80 } })).status,
    ).toBe(400);
    expect(
      (await client.patch('/v1/workspace/settings', { currency: { rateSource: 'coinbase' } }))
        .status,
    ).toBe(400);
    expect(
      (await client.patch('/v1/workspace/settings', { signals: { medianPeriods: 1 } })).status,
    ).toBe(400);
  });

  test('настройки не протекают между воркспейсами', async () => {
    const alice = await onboarded();
    await patch(alice, { cascade: { bufferPct: 10 }, signals: { medianPeriods: 3 } });

    const bob = await onboarded();
    const bobSettings = await expectOk<SettingsDto>(await bob.get('/v1/workspace/settings'));
    expect(bobSettings.cascade.bufferPct).toBe(0);
    expect(bobSettings.signals.medianPeriods).toBe(6);
  });
});

test('список валют настраивается и по умолчанию покрывает валюты продукта', async () => {
  /*
   * Решение владельца 06.08.2026: валюту выбирают списком, а сам список задаётся в настройках — у
   * каждого он свой. Дефолт обязан быть непустым: пустой список означал бы выпадашку без единого
   * варианта, то есть невозможность завести строку.
   */
  const client = await onboarded();
  const initial = await expectOk<{ currency: { list: string[] } }>(
    await client.get('/v1/workspace/settings'),
  );
  expect(initial.currency.list).toEqual(['RUB', 'EUR', 'USD', 'KGS', 'KZT']);

  const patched = await expectOk<{ currency: { list: string[] } }>(
    await client.patch('/v1/workspace/settings', { currency: { list: ['rub', 'kzt', 'rub'] } }),
  );
  // Коды приводятся к верхнему регистру, дубли схлопываются: список — множество, а не журнал ввода.
  expect(patched.currency.list).toEqual(['RUB', 'KZT']);

  const empty = await client.patch('/v1/workspace/settings', { currency: { list: [] } });
  expect(empty.status).toBe(400);
});

describe('совет считается от плана, а не от урезанного каскадом (#97)', () => {
  /*
   * `adviceFields` вызывался с `allocatedMinor` — суммой ПОСЛЕ сжатия. В периоде, где денег не
   * хватило, медиана факта сравнивалась с урезанной цифрой, и получался совет «поднять» до суммы
   * МЕНЬШЕ текущего плана: кнопка «Поставить N» под ярлыком raise фактически опускала бюджет.
   * Совет к тому же не сходился — применил, в следующем сжатом периоде он появляется снова.
   *
   * Сжатие — это «в этом периоде не хватило», а не «столько тебе и надо». Учиться нужно на плане.
   */
  test('план уже равен медиане — совета нет, даже если каскад урезал строку', async () => {
    const client = await onboarded({ payoutMinor: '3000000' });
    const food = await categoryId(client, 'Продукты');
    // План ровно на медиану факта: поднимать нечего, совет обязан молчать.
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '2600000' }),
    );
    // Вторая крупная строка забирает деньги: каскаду нечем закрыть обе, начинается сжатие.
    const fun = await categoryId(client, 'Развлечения');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${fun}`, { plannedMinor: '2500000' }),
    );
    for (const day of PAST_DAYS.slice(0, 3)) {
      await expectOk(
        await client.post('/v1/transactions', {
          amountMinor: '2600000',
          currency: 'RUB',
          categoryId: food,
          occurredOn: day,
        }),
        201,
      );
    }

    const plan = await getPlan(client);
    const row = plan.allocations.find((a) => a.targetId === food)!;
    // Сжатие действительно случилось — иначе тест ничего не проверяет.
    expect(BigInt(row.allocatedMinor)).toBeLessThan(BigInt(row.plannedMinor));
    expect(row.advice).toBeUndefined();
  });
});
