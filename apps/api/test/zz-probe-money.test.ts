import { describe, test } from 'vitest';
import { categoryId, expectOk, getPlan, onboarded } from './client.ts';

interface AnalyticsRow {
  name: string;
  plannedMinor: string;
  medianMinor: string;
  deltaPct: number | null;
  verdict: string;
  periods: number;
}

describe('ПРОБА 4', () => {
  test('аналитика до первой сборки плана', async () => {
    const client = await onboarded({ payoutMinor: '3000000' });
    const food = await categoryId(client, 'Продукты');
    // Бюджет задан через ручку бюджета (она сама собирает план) — значит planned_items есть.
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '400000' }),
    );
    const a1 = await expectOk<AnalyticsRow[]>(await client.get('/v1/analytics/categories'));
    console.log(
      'С бюджетом:',
      a1.filter((r) => r.name === 'Продукты'),
    );

    // Теперь чистый воркспейс: план ни разу не собирали.
    const fresh = await onboarded({ payoutMinor: '3000000' });
    const a2 = await expectOk<AnalyticsRow[]>(await fresh.get('/v1/analytics/categories'));
    console.log(
      'Без сборки плана (первые 3):',
      a2.slice(0, 3).map((r) => ({ n: r.name, p: r.plannedMinor, v: r.verdict })),
    );
    const plan = await getPlan(fresh);
    console.log(
      'после /plan/current, категорий в плане:',
      plan.allocations.filter((x) => x.targetKind === 'category').length,
    );
    const a3 = await expectOk<AnalyticsRow[]>(await fresh.get('/v1/analytics/categories'));
    console.log(
      'после сборки (первые 3):',
      a3.slice(0, 3).map((r) => ({ n: r.name, p: r.plannedMinor, v: r.verdict })),
    );
  });
});
