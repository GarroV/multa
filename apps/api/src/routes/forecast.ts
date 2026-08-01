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
import { requireWorkspace, type AppVariables, type Workspace } from '../middleware.ts';

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
  return c.json(await forecastOf(ws));
});

/**
 * Прогноз как функция: его читает и ручка, и движок сигналов (issue #50). «Долг закроется» должно
 * считаться одним кодом, иначе лента «Что впереди» и сигнал разойдутся в датах.
 */
export async function forecastOf(ws: Workspace) {
  const asOf = today(ws.timezone);

  const [current] = generatePeriods(ws.periodAnchors as PeriodConfig, asOf, 2);
  // Период не определяется — это сбой ритма, а не пустой прогноз: молчать здесь нельзя.
  if (!current) throw new Error('period_undeterminable');

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
      startsOn: r.startsOn,
      endsOn: r.endsOn,
    })),
    current,
  );
  // Скрытые с карты платежи остаются в списке «что впереди»: тумблер прячет метку, а не событие.
  const showOnMap = new Map(recurringRows.map((r) => [r.id, r.showOnMap]));

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

  return {
    horizonPeriods: HORIZON_PERIODS,
    dueSoon: dueSoon.map((d) => ({
      id: d.id,
      name: d.name,
      amountMinor: d.amountMinor.toString(),
      currency: d.currency,
      on: d.on,
      showOnMap: showOnMap.get(d.id) ?? true,
    })),
    events: events.map((e) => ({
      kind: e.kind,
      targetId: e.targetId,
      name: e.name,
      on: e.on,
      periodsAway: e.periodsAway,
      amountMinor: e.amountMinor != null ? e.amountMinor.toString() : null,
    })),
  };
}
