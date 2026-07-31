import { categoryVerdict, type CategoryVerdictKind } from '@multa/core';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import { categories, payPeriods, plannedItems, transactions } from '../db/schema/domain.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import { currentPeriodFor } from '../plan/assemble.ts';
import { analyticsQuerySchema } from '../validation.ts';

/**
 * Категорийная аналитика (issue #51): план текущего периода против медианы факта за прошлые
 * периоды, ряд значений для спарклайна и вердикт.
 *
 * Медиана, а не среднее — один месяц с ремонтом не должен задирать бюджет на год. Вердикт считает
 * ядро (`categoryVerdict`), потому что это доменное правило, а не отображение: у него есть
 * состояние «нестабильно», которое запрещает советовать «поднять план» там, где статью надо
 * разбирать.
 */
export const analyticsRoute = new Hono<{ Variables: AppVariables }>();
analyticsRoute.use('*', requireWorkspace);

interface SeriesPoint {
  startsOn: string;
  spentMinor: string;
}

analyticsRoute.get('/analytics/categories', async (c) => {
  const ws = c.get('workspace')!;
  const { periods } = analyticsQuerySchema.parse(c.req.query());
  const period = currentPeriodFor(ws, today(ws.timezone));

  const [catRows, factRows, plannedRows] = await Promise.all([
    db
      .select({ id: categories.id, name: categories.name, archived: categories.archived })
      .from(categories)
      .where(eq(categories.workspaceId, ws.id)),
    // Факт по прошлым периодам: текущий период ещё не закончился, и сравнивать с ним нечестно.
    db
      .select({
        categoryId: transactions.targetId,
        startsOn: payPeriods.startsOn,
        spentMinor: sql<string>`sum(${transactions.baseAmountMinor})`,
      })
      .from(transactions)
      .innerJoin(payPeriods, eq(payPeriods.id, transactions.periodId))
      .where(
        and(
          eq(transactions.workspaceId, ws.id),
          eq(transactions.kind, 'expense'),
          eq(transactions.targetKind, 'category'),
          lt(payPeriods.startsOn, period.startsOn),
        ),
      )
      .groupBy(transactions.targetId, payPeriods.startsOn)
      .orderBy(desc(payPeriods.startsOn)),
    // План текущего периода — то, с чем сравниваем медиану.
    db
      .select({ targetId: plannedItems.targetId, plannedMinor: plannedItems.plannedMinor })
      .from(plannedItems)
      .innerJoin(payPeriods, eq(payPeriods.id, plannedItems.periodId))
      .where(
        and(
          eq(plannedItems.workspaceId, ws.id),
          eq(plannedItems.targetKind, 'category'),
          eq(payPeriods.startsOn, period.startsOn),
        ),
      ),
  ]);

  const series = new Map<string, SeriesPoint[]>();
  for (const row of factRows) {
    if (!row.categoryId) continue;
    const list = series.get(row.categoryId) ?? [];
    // Горизонт режем здесь, а не в SQL: у категорий разное число периодов с тратами.
    if (list.length >= periods) continue;
    list.push({ startsOn: row.startsOn, spentMinor: BigInt(row.spentMinor ?? '0').toString() });
    series.set(row.categoryId, list);
  }
  const plannedByCategory = new Map(plannedRows.map((r) => [r.targetId, r.plannedMinor]));

  const rows = catRows
    // Архивные не показываем: их держат ради истории, а решений по ним не принимают.
    .filter((cat) => !cat.archived)
    .map((cat) => {
      const points = series.get(cat.id) ?? [];
      const history = points.map((p) => BigInt(p.spentMinor));
      const plannedMinor = plannedByCategory.get(cat.id) ?? 0n;
      const verdict = categoryVerdict({ plannedMinor, history });
      return {
        categoryId: cat.id,
        name: cat.name,
        plannedMinor: plannedMinor.toString(),
        medianMinor: verdict.medianMinor.toString(),
        deltaPct: verdict.deltaPct,
        verdict: verdict.kind satisfies CategoryVerdictKind,
        series: points,
        periods: verdict.periods,
      };
    })
    // Сначала то, что требует решения: нестабильные и требующие правки плана.
    .sort((a, b) => rank(a.verdict) - rank(b.verdict));

  return c.json(rows);
});

const VERDICT_ORDER: CategoryVerdictKind[] = [
  'volatile',
  'raise',
  'lower',
  'unplanned',
  'stable',
  'unknown',
];

function rank(kind: CategoryVerdictKind): number {
  const idx = VERDICT_ORDER.indexOf(kind);
  return idx === -1 ? VERDICT_ORDER.length : idx;
}
