import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, getPlan, onboarded, type TestClient } from './client.ts';

/**
 * Категорийная аналитика (issue #51): план против медианы факта за N периодов, ряд для спарклайна и
 * вердикт. Проверяется то, ради чего экран существует: цифры считаются по истории, а не по одному
 * периоду, и статья с разбросом в обе стороны названа «нестабильной», а не «поднять план».
 */

interface CategoryAnalyticsRow {
  categoryId: string;
  name: string;
  plannedMinor: string;
  medianMinor: string;
  deltaPct: number | null;
  verdict: 'unknown' | 'stable' | 'raise' | 'lower' | 'volatile' | 'unplanned';
  series: { startsOn: string; spentMinor: string }[];
  periods: number;
}

/** Трата в прошлом периоде: аналитика смотрит на историю, а не на текущий период. */
async function spendOn(
  client: TestClient,
  category: string,
  amountMinor: string,
  occurredOn: string,
): Promise<void> {
  await expectOk(
    await client.post('/v1/transactions', {
      amountMinor,
      currency: 'RUB',
      categoryId: category,
      occurredOn,
    }),
    201,
  );
}

/** Даты прошлых периодов при ритме 10/25: берём по одной внутри каждого. */
const PAST_DAYS = ['2026-06-26', '2026-06-11', '2026-05-27', '2026-05-12'];

describe('аналитика категорий', () => {
  test('отдаёт план, медиану, ряд для спарклайна и вердикт', async () => {
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '2000000' }),
    );
    for (const day of PAST_DAYS) await spendOn(client, food, '2400000', day);

    const rows = await expectOk<CategoryAnalyticsRow[]>(
      await client.get('/v1/analytics/categories?periods=6'),
    );
    const row = rows.find((r) => r.categoryId === food)!;
    expect(row.name).toBe('Продукты');
    expect(row.plannedMinor).toBe('2000000');
    // Медиана факта, а не среднее: один дорогой период не должен задирать бюджет.
    expect(row.medianMinor).toBe('2400000');
    expect(row.verdict).toBe('raise');
    expect(row.deltaPct).toBeCloseTo(20, 1);
    // Ряд для спарклайна — по одному значению на период, свежие первыми.
    expect(row.series).toHaveLength(4);
    expect(row.series[0]!.startsOn > row.series[1]!.startsOn).toBe(true);
  });

  test('разброс в обе стороны — «нестабильно», а не совет поднять план', async () => {
    const client = await onboarded();
    const fun = await categoryId(client, 'Развлечения');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${fun}`, { plannedMinor: '2000000' }),
    );
    const amounts = ['4000000', '300000', '3800000', '250000'];
    for (const [i, day] of PAST_DAYS.entries()) await spendOn(client, fun, amounts[i]!, day);

    const rows = await expectOk<CategoryAnalyticsRow[]>(
      await client.get('/v1/analytics/categories'),
    );
    expect(rows.find((r) => r.categoryId === fun)?.verdict).toBe('volatile');
  });

  test('меньше трёх периодов — «пока не знаем»: два случая это совпадение', async () => {
    const client = await onboarded();
    const home = await categoryId(client, 'Дом');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${home}`, { plannedMinor: '1000000' }),
    );
    await spendOn(client, home, '1500000', PAST_DAYS[0]!);
    await spendOn(client, home, '1600000', PAST_DAYS[1]!);

    const rows = await expectOk<CategoryAnalyticsRow[]>(
      await client.get('/v1/analytics/categories'),
    );
    const row = rows.find((r) => r.categoryId === home)!;
    expect(row.verdict).toBe('unknown');
    expect(row.periods).toBe(2);
  });

  test('трата без бюджета видна как «без плана», а не выпадает из аналитики', async () => {
    const client = await onboarded();
    const health = await categoryId(client, 'Здоровье');
    for (const day of PAST_DAYS.slice(0, 3)) await spendOn(client, health, '900000', day);

    const rows = await expectOk<CategoryAnalyticsRow[]>(
      await client.get('/v1/analytics/categories'),
    );
    const row = rows.find((r) => r.categoryId === health)!;
    expect(row.verdict).toBe('unplanned');
    expect(row.plannedMinor).toBe('0');
    expect(row.deltaPct).toBeNull();
  });

  test('горизонт ограничен запрошенным числом периодов', async () => {
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    for (const day of PAST_DAYS) await spendOn(client, food, '1000000', day);

    const rows = await expectOk<CategoryAnalyticsRow[]>(
      await client.get('/v1/analytics/categories?periods=2'),
    );
    expect(rows.find((r) => r.categoryId === food)!.series).toHaveLength(2);
  });

  test('чужая аналитика недоступна', async () => {
    const alice = await onboarded();
    const food = await categoryId(alice, 'Продукты');
    for (const day of PAST_DAYS) await spendOn(alice, food, '2400000', day);
    await getPlan(alice);

    const bob = await onboarded();
    const rows = await expectOk<CategoryAnalyticsRow[]>(await bob.get('/v1/analytics/categories'));
    expect(rows.every((r) => r.series.length === 0)).toBe(true);
    expect(rows.map((r) => r.categoryId)).not.toContain(food);
  });

  test('мусорный горизонт отклоняется, а не молча превращается в дефолт', async () => {
    const client = await onboarded();
    expect((await client.get('/v1/analytics/categories?periods=0')).status).toBe(400);
    expect((await client.get('/v1/analytics/categories?periods=99')).status).toBe(400);
  });
});
