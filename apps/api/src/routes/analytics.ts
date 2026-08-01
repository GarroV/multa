import { categoryVerdict, compareProviders, type CategoryVerdictKind } from '@multa/core';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import {
  categories,
  exchangeOps,
  payPeriods,
  plannedItems,
  transactions,
} from '../db/schema/domain.ts';
import { requireWorkspace, type AppVariables, type Workspace } from '../middleware.ts';
import { currentPeriodFor } from '../plan/assemble.ts';
import { settingsOf } from '../settings/store.ts';
import { analyticsQuerySchema, spreadQuerySchema } from '../validation.ts';

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
  // Горизонт: параметр запроса важнее настройки (экран может попросить другой), настройка —
  // значение по умолчанию для этого воркспейса (issue #49).
  const requested = analyticsQuerySchema.parse(c.req.query());
  const periods = c.req.query('periods') ? requested.periods : settingsOf(ws).signals.medianPeriods;
  return c.json(await categoryAnalytics(ws, periods));
});

/**
 * Категорийная аналитика как функция: её читает и ручка, и движок сигналов (issue #50). Считать
 * медиану во второй раз своим кодом было бы прямым путём к двум разным цифрам на одном экране.
 */
export async function categoryAnalytics(ws: Workspace, periods: number) {
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

  return rows;
}

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

/**
 * Дата на N месяцев раньше, YYYY-MM-DD. Считаем по календарю, а не «месяц = 31 день»: горизонт
 * «полгода» должен означать полгода, а не 186 дней, иначе граница выборки съезжает от месяца к
 * месяцу. Переполнение дня (31 марта − 1 месяц) UTC-конструктор сам сносит на конец февраля.
 */
function monthsBefore(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
}

/**
 * Сравнение провайдеров размена (issue #53). Считает ядро (`compareProviders`) — это доменное
 * правило: там же решается, когда совет молчит (один провайдер, единичная сделка, разные валюты).
 */
analyticsRoute.get('/analytics/spread', async (c) => {
  const ws = c.get('workspace')!;
  const { months } = spreadQuerySchema.parse(c.req.query());
  const since = monthsBefore(today(ws.timezone), months);

  const rows = await db
    .select({
      provider: exchangeOps.provider,
      fromCurrency: exchangeOps.fromCurrency,
      toCurrency: exchangeOps.toCurrency,
      fromMinor: exchangeOps.fromMinor,
      spreadPct: exchangeOps.spreadPct,
      spreadMinor: exchangeOps.spreadMinor,
      occurredOn: exchangeOps.occurredOn,
    })
    .from(exchangeOps)
    .where(and(eq(exchangeOps.workspaceId, ws.id), gte(exchangeOps.occurredOn, since)));

  const comparison = compareProviders(
    rows.map((r) => ({
      provider: r.provider,
      pair: `${r.fromCurrency}→${r.toCurrency}`,
      fromMinor: r.fromMinor,
      spreadPct: r.spreadPct,
      lostMinor: r.spreadMinor,
      occurredOn: r.occurredOn,
    })),
  );

  const serializeStats = (stats: (typeof comparison.providers)[number]) => ({
    provider: stats.provider,
    deals: stats.deals,
    avgSpreadPct: Number(stats.avgSpreadPct.toFixed(4)),
    volumeMinor: Object.fromEntries(
      [...stats.volumeMinorByCurrency].map(([ccy, v]) => [ccy, v.toString()]),
    ),
    lostMinor: Object.fromEntries(
      [...stats.lostMinorByCurrency].map(([ccy, v]) => [ccy, v.toString()]),
    ),
  });

  return c.json({
    months,
    providers: comparison.providers.map(serializeStats),
    best: comparison.best ? serializeStats(comparison.best) : null,
    worst: comparison.worst ? serializeStats(comparison.worst) : null,
    // Совет показывается только при повторяемости: единичная сделка — не привычка.
    confident: comparison.confident,
    savingMinor: comparison.savingMinor.toString(),
    savingCurrency: comparison.savingCurrency,
  });
});
