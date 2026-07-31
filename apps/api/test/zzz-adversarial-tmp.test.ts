import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, onboarded } from './client.ts';

const PAST_DAYS = ['2026-06-26', '2026-06-11', '2026-05-27', '2026-05-12'];

describe('adversarial: горизонт медианы против явного ?periods (как его шлёт веб)', () => {
  test('настройка medianPeriods=2 игнорируется, если пришёл ?periods=6', async () => {
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

    await expectOk(await client.patch('/v1/workspace/settings', { signals: { medianPeriods: 2 } }));

    const withoutParam = await expectOk<{ categoryId: string; series: unknown[] }[]>(
      await client.get('/v1/analytics/categories'),
    );
    const webLike = await expectOk<{ categoryId: string; series: unknown[]; periods: number }[]>(
      // Ровно то, что отправляет apps/web (useCategoryAnalytics(6)).
      await client.get('/v1/analytics/categories?periods=6'),
    );

    // eslint-disable-next-line no-console
    console.log(
      'без параметра:',
      withoutParam.find((r) => r.categoryId === food)!.series.length,
      '| как шлёт веб (?periods=6):',
      webLike.find((r) => r.categoryId === food)!.series.length,
    );
    expect(withoutParam.find((r) => r.categoryId === food)!.series).toHaveLength(2);
    expect(webLike.find((r) => r.categoryId === food)!.series.length).toBeGreaterThan(2);
  });
});
