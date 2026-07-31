import {
  daysInPeriod,
  forecastTimeline,
  generatePeriods,
  recurringDueIn,
  type PeriodConfig,
  type RecurringSchedule,
} from '@multa/core';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import { debts, goals, recurringItems } from '../db/schema/domain.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';

/**
 * Прогноз-таймлайн (Спринт 4): когда закроются долги, когда соберутся цели и где риск.
 * Горизонт — 12 периодов выплат: дальше точность падает, а решения всё равно принимаются раньше.
 */
export const forecastRoute = new Hono<{ Variables: AppVariables }>();
forecastRoute.use('*', requireWorkspace);

const HORIZON_PERIODS = 12;

forecastRoute.get('/forecast', async (c) => {
  const ws = c.get('workspace')!;
  if (!ws.periodAnchors) return c.json({ error: 'onboarding_incomplete' }, 409);
  const asOf = today(ws.timezone);

  const [current] = generatePeriods(ws.periodAnchors as PeriodConfig, asOf, 2);
  if (!current) return c.json({ error: 'period_undeterminable' }, 409);

  const [debtRows, goalRows, recurringRows] = await Promise.all([
    db
      .select()
      .from(debts)
      .where(and(eq(debts.workspaceId, ws.id), sql`${debts.closedAt} is null`)),
    db
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, ws.id), sql`${goals.achievedAt} is null`)),
    db
      .select()
      .from(recurringItems)
      .where(and(eq(recurringItems.workspaceId, ws.id), eq(recurringItems.active, true))),
  ]);

  // Регулярные платежи текущего периода: их не видно ни в обязательствах, ни в факте,
  // поэтому без них лента «что впереди» врала бы в пользу пользователя (#21).
  const dueSoon = recurringDueIn(
    recurringRows.map((r) => ({
      id: r.id,
      name: r.name,
      amountMinor: r.amountMinor,
      currency: r.currency,
      schedule: r.schedule as RecurringSchedule,
    })),
    current,
  );

  const events = forecastTimeline({
    asOf,
    periodsAhead: HORIZON_PERIODS,
    periodLengthDays: daysInPeriod(current),
    debts: debtRows.map((d) => ({
      id: d.id,
      name: d.name,
      remainingMinor: d.remainingMinor,
      paymentMinor: d.paymentMinor,
    })),
    goals: goalRows.map((g) => ({
      id: g.id,
      name: g.name,
      targetMinor: g.targetMinor,
      savedMinor: g.savedMinor,
      perPeriodMinor: g.plannedPerPeriodMinor,
    })),
  });

  return c.json({
    horizonPeriods: HORIZON_PERIODS,
    dueSoon: dueSoon.map((d) => ({
      id: d.id,
      name: d.name,
      amountMinor: d.amountMinor.toString(),
      currency: d.currency,
      on: d.on,
    })),
    events: events.map((e) => ({
      kind: e.kind,
      targetId: e.targetId,
      name: e.name,
      on: e.on,
      periodsAway: e.periodsAway,
      amountMinor: e.amountMinor != null ? e.amountMinor.toString() : null,
    })),
  });
});
