import {
  amountOn,
  debtPaymentForPeriod,
  incomeEventsIn,
  daysInPeriod,
  forecastTimeline,
  generatePeriods,
  recurringDueIn,
  type PeriodConfig,
  type RecurringSchedule,
  type WeekendRule,
} from '@multa/core';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import { debts, goals, recurringItems } from '../db/schema/domain.ts';
import { listSources } from '../income/store.ts';
import { requireWorkspace, type AppVariables, type Workspace } from '../middleware.ts';
import { parseAmountSteps, parsePaymentsBySource } from '../plan/assemble.ts';
import { sectionVisible } from '../plan/sharing.ts';
import { settingsOf } from '../settings/store.ts';

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
  return c.json(await forecastOf(ws, c.get('role') === 'member'));
});

/**
 * Прогноз как функция: его читает и ручка, и движок сигналов (issue #50). «Долг закроется» должно
 * считаться одним кодом, иначе лента «Что впереди» и сигнал разойдутся в датах.
 */
export async function forecastOf(ws: Workspace, asMember = false) {
  const asOf = today(ws.timezone);
  const sharing = settingsOf(ws).sharing;

  const horizon = generatePeriods(ws.periodAnchors as PeriodConfig, asOf, HORIZON_PERIODS);
  const [current] = horizon;
  // Период не определяется — это сбой ритма, а не пустой прогноз: молчать здесь нельзя.
  if (!current) throw new Error('period_undeterminable');

  const [debtRows, goalRows, recurringRows, sourceRows] = await Promise.all([
    db
      .select()
      .from(debts)
      .where(
        and(
          eq(debts.workspaceId, ws.id),
          sql`${debts.closedAt} is null`,
          // Заём в раздачу не идёт: иначе каскад откладывал бы деньги на возврат чужого долга (#94).
          sql`${debts.direction} = 'owed_by_me'`,
        ),
      ),
    db
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, ws.id), sql`${goals.achievedAt} is null`)),
    db
      .select()
      .from(recurringItems)
      .where(and(eq(recurringItems.workspaceId, ws.id), eq(recurringItems.active, true))),
    /*
     * Источники дохода: без них не применить разбивку платежа по выплатам. Через `listSources`, а
     * не своим запросом — он приводит расписание и сумму к типам ядра, и второй разбор тех же
     * данных однажды разошёлся бы с первым.
     */
    listSources(ws.id),
  ]);

  // Регулярные платежи текущего периода: их не видно ни в обязательствах, ни в факте,
  // поэтому без них лента «что впереди» врала бы в пользу пользователя (#21).
  /* Кто платит в каждом периоде: нужно долгам с разбивкой по выплатам. */
  const sourcesByPeriod = horizon.map((period) => [
    ...new Set(
      incomeEventsIn(
        sourceRows.filter((x) => x.active),
        period,
        ws.paydayWeekendRule as WeekendRule,
      ).map((e) => e.sourceId),
    ),
  ]);

  const dueSoon = recurringDueIn(
    recurringRows.map((r) => ({
      id: r.id,
      name: r.name,
      amountMinor: amountOn(r.amountMinor, parseAmountSteps(r.amountSteps), current.startsOn),
      currency: r.currency,
      schedule: r.schedule as RecurringSchedule,
      startsOn: r.startsOn,
      endsOn: r.endsOn,
    })),
    current,
  );

  /*
   * Регулярные платежи на весь горизонт, а не только в текущем периоде (#103). Раньше лента
   * «Что впереди» знала один период и потому дублировала карту периода: ежегодная страховка через
   * пять месяцев в ней не появлялась вовсе, хотя ради таких предупреждений прогноз и существует.
   */
  const ahead = horizon.slice(1).flatMap((period) =>
    recurringDueIn(
      recurringRows.map((r) => ({
        id: r.id,
        name: r.name,
        // Сумма на дату периода: ступени человек заводит из интерфейса, правило одно на всех.
        amountMinor: amountOn(r.amountMinor, parseAmountSteps(r.amountSteps), period.startsOn),
        currency: r.currency,
        schedule: r.schedule as RecurringSchedule,
        startsOn: r.startsOn,
        endsOn: r.endsOn,
      })),
      period,
    ).map((due) => ({
      id: due.id,
      name: due.name,
      currency: due.currency,
      on: due.on,
      amountMinor: due.amountMinor,
    })),
  );
  // Скрытые с карты платежи остаются в списке «что впереди»: тумблер прячет метку, а не событие.
  const showOnMap = new Map(recurringRows.map((r) => [r.id, r.showOnMap]));

  const events = forecastTimeline({
    asOf,
    periodsAhead: HORIZON_PERIODS,
    periodLengthDays: daysInPeriod(current),
    recurring: ahead,
    debts: debtRows.map((d) => ({
      id: d.id,
      name: d.name,
      currency: d.currency,
      remainingMinor: d.remainingMinor,
      paymentMinor: d.paymentMinor,
      /*
       * Платёж по периодам, а не сегодняшний (#103): весь остальной код ходит через `amountOn`,
       * а прогноз считал по плоской сумме и обещал закрытие в разы позже или раньше, чем есть.
       */
      /*
       * То же правило ядра, что в плане и мастер-сетке (`debtPaymentForPeriod`). Своя формула тут
       * уже врала: прогноз знал про ступени, но не знал ни про разбивку по выплатам, ни про окно
       * платежей — и обещал закрытие долга, который в этих периодах денег не берёт вовсе.
       */
      paymentsByPeriod: horizon.map((period, i) =>
        debtPaymentForPeriod(
          {
            paymentMinor: d.paymentMinor,
            steps: parseAmountSteps(d.amountSteps),
            bySource: parsePaymentsBySource(d.paymentsBySource),
            paysFrom: d.paysFrom,
            paysUntil: d.paysUntil,
          },
          sourcesByPeriod[i] ?? [],
          period.startsOn,
        ),
      ),
    })),
    goals: goalRows.map((g) => ({
      id: g.id,
      name: g.name,
      currency: g.currency,
      targetMinor: g.targetMinor,
      savedMinor: g.savedMinor,
      perPeriodMinor: g.plannedPerPeriodMinor,
    })),
  });

  /*
   * Матрица видимости (issue #84): события называют долг и цель по имени, а `dueSoon` — регулярный
   * платёж. Закрытый раздел не должен протекать через ленту «Что впереди».
   */
  const recurringVisible = !asMember || sharing.recurring === 'open';
  const visibleEvents = events.filter((e) => {
    /*
     * Регулярные платежи не входят в матрицу `sectionVisible` (там строки плана) — у них свой
     * флаг. Без этой ветки список событий проверялся против раздела долгов, и закрытые
     * «Регулярные платежи» протекали участнику именами через ленту (поймано тестом sharing).
     */
    if (e.kind === 'recurring_due') return recurringVisible;
    const section = e.kind === 'goal_at_risk' || e.kind === 'goal_reached' ? 'goal' : 'debt';
    return sectionVisible(section, sharing, asMember);
  });

  return {
    horizonPeriods: HORIZON_PERIODS,
    dueSoon: (recurringVisible ? dueSoon : []).map((d) => ({
      id: d.id,
      name: d.name,
      amountMinor: d.amountMinor.toString(),
      currency: d.currency,
      on: d.on,
      showOnMap: showOnMap.get(d.id) ?? true,
    })),
    events: visibleEvents.map((e) => ({
      kind: e.kind,
      targetId: e.targetId,
      name: e.name,
      // Валюта строки, а не базовая: конвертировать будущее нечем, а печатать чужую цифру нельзя.
      currency: e.currency,
      on: e.on,
      periodsAway: e.periodsAway,
      amountMinor: e.amountMinor != null ? e.amountMinor.toString() : null,
    })),
  };
}
