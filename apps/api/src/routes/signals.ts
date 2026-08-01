import { buildSignals, type SignalMetric, type SignalsInput } from '@multa/core';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import { getCurrentPlan } from '../plan/assemble.ts';
import { settingsOf } from '../settings/store.ts';
import { balancesOf } from './accounts.ts';
import { categoryAnalytics } from './analytics.ts';
import { forecastOf } from './forecast.ts';

/**
 * Сигналы (issue #50) — единственный список того, что требует решения прямо сейчас.
 *
 * Ручка ничего не считает сама: она собирает входы (план, прогноз, категорийная аналитика,
 * остатки по счетам) и отдаёт их движку ядра. Каждый источник берётся той же функцией, что
 * обслуживает свой экран, — иначе «долг закроется 18 августа» в сигнале и в ленте «Что впереди»
 * однажды разошлись бы на день, и верить перестали бы обоим.
 *
 * Наружу идут правило, severity, метрика и параметры — не текст: формулировку собирает клиент по
 * ключу `signal.<rule>.*` из словаря (правило 5).
 */
export const signalsRoute = new Hono<{ Variables: AppVariables }>();
signalsRoute.use('*', requireWorkspace);

/** Метрика в JSON: bigint в нём не живёт, поэтому деньги уезжают строкой. */
function serializeMetric(metric: SignalMetric) {
  return metric.kind === 'money'
    ? { kind: metric.kind, minor: metric.minor.toString(), currency: metric.currency }
    : metric;
}

signalsRoute.get('/signals', async (c) => {
  const ws = c.get('workspace')!;
  const asOf = today(ws.timezone);
  const settings = settingsOf(ws);

  let plan;
  try {
    plan = await getCurrentPlan(ws, asOf);
  } catch (err) {
    if (err instanceof Error && err.message === 'onboarding_incomplete') {
      return c.json({ error: 'onboarding_incomplete' }, 409);
    }
    throw err;
  }

  const [analytics, forecast, balances] = await Promise.all([
    categoryAnalytics(ws, settings.signals.medianPeriods),
    forecastOf(ws),
    balancesOf(ws),
  ]);

  /*
   * Связанные деньги = всё, кроме категорий: долги, корзины, конверты, цели. Категории — это и
   * есть жизнь, включать их в «связано обязательствами» значит показать 100% у любого плана.
   */
  const lockedMinor = plan.allocations
    .filter((a) => a.targetKind !== 'category')
    .reduce((sum, a) => sum + BigInt(a.allocatedMinor), 0n);

  const input: SignalsInput = {
    asOf,
    period: plan.period,
    baseCurrency: plan.baseCurrency,
    burn: {
      perDayMinor: BigInt(plan.burn.perDayMinor),
      willLast: plan.burn.willLast,
      runsOutOn: plan.burn.runsOutOn,
    },
    livingMinor: BigInt(plan.livingMinor),
    overspentMinor: BigInt(plan.overspentMinor),
    compressedMinor: BigInt(plan.compressedMinor),
    incomeMinor: BigInt(plan.incomeMinor),
    lockedMinor,
    // null означает «часть денег без курса»: приукрашивать неизвестность нулём нельзя.
    balancesBaseMinor: balances.totalMinor === null ? null : BigInt(balances.totalMinor),
    categories: analytics.map((row) => ({
      id: row.categoryId,
      name: row.name,
      plannedMinor: BigInt(row.plannedMinor),
      medianMinor: BigInt(row.medianMinor),
      verdict: row.verdict,
      deltaPct: row.deltaPct,
    })),
    forecast: forecast.events.map((e) => ({
      kind: e.kind,
      targetId: e.targetId,
      name: e.name,
      on: e.on,
      ...(e.amountMinor !== null ? { amountMinor: BigInt(e.amountMinor) } : {}),
    })),
  };

  const signals = buildSignals(input, {
    burnThresholdDays: settings.signals.burnThresholdDays,
    runwayWarnDays: settings.signals.runwayWarnDays,
    lockedWarnPct: settings.signals.lockedWarnPct,
    maxSignals: settings.signals.maxSignals,
  });

  return c.json({
    baseCurrency: plan.baseCurrency,
    signals: signals.map((s) => ({
      id: s.id,
      rule: s.rule,
      severity: s.severity,
      metric: serializeMetric(s.metric),
      params: s.params,
      targetId: s.targetId ?? null,
      targetName: s.targetName ?? null,
      actions: s.actions.map((a) =>
        a.kind === 'set_budget' ? { ...a, amountMinor: a.amountMinor.toString() } : a,
      ),
    })),
  });
});
