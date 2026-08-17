/**
 * Сборка плана периода на стороне API (БД + FX). Доменная математика — в @multa/core.
 *
 * Поток: гарантировать периоды (текущий + следующий) → собрать обязательства →
 * привести к base-валюте по курсу на дату старта периода → каскад (assemblePlan) →
 * записать planned_items (идемпотентно, с сохранением исполнения) → отдать DTO.
 *
 * DoD Спринта 2: «план на два периода вперёд собирается сам» — поэтому planned_items
 * пишутся для текущего И следующего периодов. Категории модуль читает (для каскада) и
 * переносит из прошлого периода, но их planned_minor не перезаписывает: бюджет — интент
 * пользователя, задаётся через setCategoryBudget (исполнения категории не требуют).
 */

import {
  amountOn,
  debtPaymentForPeriod,
  assemblePlan,
  exponentOf,
  roundExchangeUp,
  type Currency,
  budgetAdvice,
  burnRate,
  categorySpending,
  convert,
  recurringDueIn,
  normalizeSteps,
  executionOf,
  daysInPeriod,
  daysLeftInPeriod,
  expectedIncomeForPeriod,
  generatePeriods,
  incomeEventsIn,
  money,
  percentOfMinor,
  periodForDate,
  rebalanceOptions,
  summarizeFact,
  type ExecutionStatus,
  type IncomeSource,
  type PayPeriod,
  type PeriodConfig,
  type PlanItem,
  type TargetKind,
  type WeekendRule,
} from '@multa/core';
import { and, desc, eq, gte, inArray, lt, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  categories,
  currencyBuckets,
  debts,
  envelopes,
  goals,
  payPeriods,
  planRevisions,
  plannedItems,
  transactions,
  recurringItems,
} from '../db/schema/domain.ts';
import { listSources } from '../income/store.ts';
import type { Workspace } from '../middleware.ts';
import { getRate } from '../fx/service.ts';
import { receiptsForPeriod } from '../income/receipts.ts';
import { settingsOf } from '../settings/store.ts';

/**
 * targetKind, которыми управляет автосборка (пишет allocated, чистит исчезнувшие).
 * Категории сюда НЕ входят: их бюджет — интент пользователя (planned_items.planned_minor),
 * автосборка его только читает для каскада, но не перезаписывает (иначе сжатие «ратчетит» бюджет).
 */
const MANAGED_KINDS = ['debt', 'bucket', 'envelope', 'goal'] as const;

interface CategoryBudget {
  readonly targetId: string;
  readonly name: string;
  readonly isProtected: boolean;
  readonly baseMinor: bigint;
}

/** Бюджеты категорий периода (planned_items × categories), архивные исключены. */
async function loadCategoryBudgets(periodId: string): Promise<CategoryBudget[]> {
  const rows = await db
    .select({
      targetId: plannedItems.targetId,
      plannedMinor: plannedItems.plannedMinor,
      name: categories.name,
      isProtected: categories.protected,
    })
    .from(plannedItems)
    .innerJoin(categories, eq(categories.id, plannedItems.targetId))
    .where(
      and(
        eq(plannedItems.periodId, periodId),
        eq(plannedItems.targetKind, 'category'),
        eq(categories.archived, false),
      ),
    );
  return rows
    .filter((r) => r.plannedMinor > 0n)
    .map((r) => ({
      targetId: r.targetId,
      name: r.name,
      isProtected: r.isProtected,
      baseMinor: r.plannedMinor,
    }));
}

/**
 * Факт по категориям за прошлые периоды — на нём учится совет по бюджету.
 * Берём последние 6 закрытых периодов: год истории для «привычки» не нужен, а сезонность
 * (декабрь) не должна тянуть совет через полгода.
 */
async function loadCategoryHistory(
  ws: Workspace,
  beforeStartsOn: string,
  /** Сколько прошлых периодов брать: настройка воркспейса (issue #49), по умолчанию шесть. */
  maxPeriods = 6,
): Promise<Map<string, bigint[]>> {
  const rows = await db
    .select({
      targetId: transactions.targetId,
      startsOn: payPeriods.startsOn,
      total: sql<string>`sum(${transactions.baseAmountMinor})`,
    })
    .from(transactions)
    .innerJoin(payPeriods, eq(payPeriods.id, transactions.periodId))
    .where(
      and(
        eq(transactions.workspaceId, ws.id),
        eq(transactions.kind, 'expense'),
        eq(transactions.targetKind, 'category'),
        lt(payPeriods.startsOn, beforeStartsOn),
      ),
    )
    .groupBy(transactions.targetId, payPeriods.startsOn)
    .orderBy(desc(payPeriods.startsOn))
    .limit(200);

  const byCategory = new Map<string, bigint[]>();
  const seenPeriods = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.targetId) continue;
    const periods = seenPeriods.get(row.targetId) ?? new Set<string>();
    if (periods.size >= maxPeriods && !periods.has(row.startsOn)) continue;
    periods.add(row.startsOn);
    seenPeriods.set(row.targetId, periods);
    byCategory.set(row.targetId, [
      ...(byCategory.get(row.targetId) ?? []),
      BigInt(row.total ?? '0'),
    ]);
  }
  return byCategory;
}

/** Статусы исполнения плановых строк периода: ключ `kind:id`. */
async function loadExecutions(
  periodId: string,
): Promise<Map<string, { status: ExecutionStatus; executedMinor: bigint; frozen: boolean }>> {
  const rows = await db
    .select({
      targetKind: plannedItems.targetKind,
      targetId: plannedItems.targetId,
      status: plannedItems.executionStatus,
      executedMinor: plannedItems.executedMinor,
      frozen: plannedItems.frozen,
    })
    .from(plannedItems)
    .where(eq(plannedItems.periodId, periodId));
  return new Map(
    rows.map((r) => [
      `${r.targetKind}:${r.targetId}`,
      { status: r.status as ExecutionStatus, executedMinor: r.executedMinor, frozen: r.frozen },
    ]),
  );
}

/** Суммы строк периода, которые правил человек: сборка обязана их уважать (находка аудита). */
async function loadOverrides(periodId: string): Promise<Map<string, bigint>> {
  const rows = await db
    .select({
      targetKind: plannedItems.targetKind,
      targetId: plannedItems.targetId,
      plannedMinor: plannedItems.plannedMinor,
    })
    .from(plannedItems)
    .where(and(eq(plannedItems.periodId, periodId), eq(plannedItems.overridden, true)));
  return new Map(rows.map((r) => [`${r.targetKind}:${r.targetId}`, r.plannedMinor]));
}

/** Цели, чей взнос пропущен в этом периоде осознанно (issue #54). */
async function frozenGoalIds(periodId: string): Promise<Set<string>> {
  const rows = await db
    .select({ targetId: plannedItems.targetId })
    .from(plannedItems)
    .where(
      and(
        eq(plannedItems.periodId, periodId),
        eq(plannedItems.targetKind, 'goal'),
        eq(plannedItems.frozen, true),
      ),
    );
  return new Set(rows.map((r) => r.targetId));
}

/**
 * Перенос бюджетов категорий из самого свежего предыдущего периода (архивные не переносятся).
 * Вызывается ТОЛЬКО при рождении периода (см. ensurePeriodRow.created) — поэтому очистка
 * бюджетов в существующем периоде сохраняется, а новый период «собирается сам».
 * Внутренняя проверка have.length — защита от гонки (страховка, не основной гейт).
 */
async function carryOverCategories(
  ws: Workspace,
  periodId: string,
  startsOn: string,
): Promise<void> {
  const have = await db
    .select({ id: plannedItems.id })
    .from(plannedItems)
    .where(and(eq(plannedItems.periodId, periodId), eq(plannedItems.targetKind, 'category')))
    .limit(1);
  if (have.length > 0) return;

  const prior = await db
    .selectDistinct({ pid: plannedItems.periodId, startsOn: payPeriods.startsOn })
    .from(plannedItems)
    .innerJoin(payPeriods, eq(payPeriods.id, plannedItems.periodId))
    .where(
      and(
        eq(plannedItems.workspaceId, ws.id),
        eq(plannedItems.targetKind, 'category'),
        lt(payPeriods.startsOn, startsOn),
      ),
    )
    .orderBy(desc(payPeriods.startsOn))
    .limit(1);
  const priorPid = prior[0]?.pid;
  if (!priorPid) return;

  const priorItems = await db
    .select({ targetId: plannedItems.targetId, plannedMinor: plannedItems.plannedMinor })
    .from(plannedItems)
    .innerJoin(categories, eq(categories.id, plannedItems.targetId))
    .where(
      and(
        eq(plannedItems.periodId, priorPid),
        eq(plannedItems.targetKind, 'category'),
        eq(categories.archived, false),
      ),
    );
  if (priorItems.length === 0) return;
  await db
    .insert(plannedItems)
    .values(
      priorItems.map((it) => ({
        workspaceId: ws.id,
        periodId,
        targetKind: 'category',
        targetId: it.targetId,
        plannedMinor: it.plannedMinor,
        executionStatus: 'n_a',
      })),
    )
    .onConflictDoNothing();
}

interface ResolvedItem {
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly name: string;
  /** Валюта и сумма в валюте обязательства (для отображения «60 000 RUB → EUR»). */
  readonly sourceCurrency: string;
  readonly sourceMinor: bigint;
  /** Дополнительная валюта назначения (только корзины). */
  readonly toCurrency?: string;
  /** Сумма в base-валюте (после конвертации). */
  readonly baseMinor: bigint;
}

interface UnresolvedItem {
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly name: string;
  readonly sourceCurrency: string;
  readonly sourceMinor: string;
  readonly reason: 'rate_unavailable';
}

/** Целая часть numeric-строки как minor units ("8000.0000" → 8000n). */
function numericToMinor(value: string): bigint {
  return BigInt(value.trim().split('.')[0] || '0');
}

/** Приводит сумму обязательства к base-валюте на дату `on`; null → курс недоступен. */
async function toBase(
  sourceMinor: bigint,
  sourceCurrency: string,
  base: string,
  on: string,
  /** Личные курсы воркспейса (курс дня выплаты) важнее публичных котировок — issue #48. */
  workspaceId?: string,
): Promise<bigint | null> {
  if (sourceCurrency === base) return sourceMinor;
  const snap = await getRate(sourceCurrency, base, on, workspaceId);
  if (!snap) return null;
  return convert(money(sourceMinor, sourceCurrency), snap).minor;
}

/**
 * Загружает обязательства workspace и приводит к base на дату `on`.
 * incomeMinor нужен для конвертов-процентов.
 */
async function resolveObligations(
  ws: Workspace,
  incomeMinor: bigint,
  on: string,
  /** Период раздачи: нужен, чтобы посчитать, сколько списаний даёт правило повтора именно в нём. */
  period: { startsOn: string; endsOn: string },
  /** Цели с осознанным пропуском взноса в этом периоде (issue #54) — в каскад не попадают. */
  frozenGoals: ReadonlySet<string> = new Set(),
  /**
   * Источники дохода, чьи выплаты приходят в этот период. Нужны долгам с разбивкой платежа: «5 000
   * с аванса, 15 000 с зарплаты» (запрос владельца 16.08.2026).
   */
  payingSourceIds: readonly string[] = [],
): Promise<{ resolved: ResolvedItem[]; unresolved: UnresolvedItem[] }> {
  const base = ws.baseCurrency;
  const [debtRows, bucketRows, envelopeRows, goalRows, reservedRecurring] = await Promise.all([
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
      .from(currencyBuckets)
      .where(and(eq(currencyBuckets.workspaceId, ws.id), eq(currencyBuckets.active, true))),
    db.select().from(envelopes).where(eq(envelopes.workspaceId, ws.id)),
    db
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, ws.id), sql`${goals.achievedAt} is null`)),
    /*
     * Регулярные платежи, которые человек отметил «откладывать» (разговор 10.08.2026: бассейн
     * оплачивается до 10-го, а деньги на него откладываются с выплаты 25-го). Поголовно включать
     * их в раздачу нельзя — большинство уже сидит внутри бюджета «Расходов», — поэтому решение
     * построчное и по умолчанию выключено.
     */
    db
      .select()
      .from(recurringItems)
      .where(
        and(
          eq(recurringItems.workspaceId, ws.id),
          eq(recurringItems.active, true),
          eq(recurringItems.reserve, true),
        ),
      ),
  ]);

  const resolved: ResolvedItem[] = [];
  const unresolved: UnresolvedItem[] = [];

  const push = async (
    targetKind: TargetKind,
    targetId: string,
    name: string,
    sourceCurrency: string,
    sourceMinor: bigint,
    extra?: { toCurrency?: string; baseOverride?: bigint },
  ): Promise<void> => {
    if (sourceMinor <= 0n) return; // нулевые/пустые обязательства в план не тянем
    const baseMinor =
      extra?.baseOverride ?? (await toBase(sourceMinor, sourceCurrency, base, on, ws.id));
    if (baseMinor === null) {
      unresolved.push({
        targetKind,
        targetId,
        name,
        sourceCurrency,
        sourceMinor: sourceMinor.toString(),
        reason: 'rate_unavailable',
      });
      return;
    }
    resolved.push({
      targetKind,
      targetId,
      name,
      sourceCurrency,
      sourceMinor,
      baseMinor,
      ...(extra?.toCurrency ? { toCurrency: extra.toCurrency } : {}),
    });
  };

  for (const r of reservedRecurring) {
    /*
     * Сумма — сколько списаний правило даёт в этом периоде: платёж 5-го числа при полумесячном
     * ритме попадает не в каждый период, и откладывать на него всегда значило бы завышать резерв.
     */
    const due = recurringDueIn(
      [
        {
          id: r.id,
          name: r.name,
          amountMinor: amountOn(r.amountMinor, parseAmountSteps(r.amountSteps), on),
          currency: r.currency,
          schedule: r.schedule as never,
          startsOn: r.startsOn,
          endsOn: r.endsOn,
        },
      ],
      { startsOn: period.startsOn, endsOn: period.endsOn },
    );
    const total = due.reduce((acc, d) => acc + d.amountMinor, 0n);
    if (total > 0n) await push('recurring', r.id, r.name, r.currency, total);
  }

  for (const d of debtRows) {
    /*
     * Ступени суммы (запрос владельца 06.08.2026): текущий период берёт сумму на свою дату начала.
     * Правило одно на всех — `amountOn` в ядре, — иначе план и мастер-сетка однажды показали бы по
     * одной строке разные числа, и верить перестали бы обоим.
     */
    /*
     * Разбивка по источникам (16.08.2026) сильнее ступеней: они отвечают на разные вопросы —
     * «сколько с какого-то момента» против «сколько с какой выплаты», — и складывать их значило бы
     * заплатить дважды. Правило целиком в ядре, чтобы план, сетка и прогноз считали одинаково.
     */
    const payment = debtPaymentForPeriod(
      {
        paymentMinor: d.paymentMinor,
        steps: parseAmountSteps(d.amountSteps),
        bySource: parsePaymentsBySource(d.paymentsBySource),
        // Окно платежей (issue #117): вне его долг денег не берёт вовсе.
        paysFrom: d.paysFrom,
        paysUntil: d.paysUntil,
      },
      payingSourceIds,
      on,
    );
    await push('debt', d.id, d.name, d.currency, payment);
  }
  for (const b of bucketRows)
    await push('bucket', b.id, b.name, b.fromCurrency, b.amountMinor, { toCurrency: b.toCurrency });
  for (const e of envelopeRows) {
    if (e.ruleKind === 'percent') {
      // Процент считается от дохода — сразу в base, без FX. Тот же хелпер, что и для выплат.
      const pv = percentOfMinor(incomeMinor, e.ruleValue);
      await push('envelope', e.id, e.name, base, pv, { baseOverride: pv });
    } else {
      await push('envelope', e.id, e.name, e.currency, numericToMinor(e.ruleValue));
    }
  }
  for (const g of goalRows) {
    if (frozenGoals.has(g.id)) continue;
    await push('goal', g.id, g.name, g.currency, g.plannedPerPeriodMinor);
  }

  return { resolved, unresolved };
}

/**
 * Идемпотентно гарантирует строку pay_periods. `created=true` только для свежей вставки
 * (xmax=0), false при ON CONFLICT UPDATE — по нему решаем, делать ли перенос категорий
 * (перенос — ровно один раз, при рождении периода; иначе очистка бюджетов не сохранялась бы).
 */
async function ensurePeriodRow(
  ws: Workspace,
  period: PayPeriod,
  incomeMinor: bigint,
): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(payPeriods)
    .values({
      workspaceId: ws.id,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      expectedIncomeMinor: incomeMinor,
    })
    .onConflictDoUpdate({
      target: [payPeriods.workspaceId, payPeriods.startsOn],
      // endsOn/доход могли измениться (правка якорей/дохода) — синхронизируем.
      set: { endsOn: period.endsOn, expectedIncomeMinor: incomeMinor },
    })
    .returning({ id: payPeriods.id, created: sql<boolean>`(xmax = 0)` });
  return { id: inserted[0]!.id, created: inserted[0]!.created };
}

/** Пишет planned_items для периода: обновляет управляемые, удаляет исчезнувшие обязательства. */
async function persistPlannedItems(
  ws: Workspace,
  periodId: string,
  rows: { targetKind: TargetKind; targetId: string; plannedMinor: bigint }[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const liveIds = rows.map((r) => r.targetId);
    /*
     * Удаляем управляемые строки, чьи обязательства удалены/закрыты (категории не трогаем).
     * Замороженные строки не удаляем: их отсутствие в плане — это и есть заморозка (issue #54), а
     * не признак исчезнувшего обязательства. Без этого условия заморозка жила до первой же сборки
     * плана и молча снималась.
     */
    const staleFilter =
      liveIds.length > 0
        ? and(
            eq(plannedItems.periodId, periodId),
            inArray(plannedItems.targetKind, [...MANAGED_KINDS]),
            notInArray(plannedItems.targetId, liveIds),
            eq(plannedItems.frozen, false),
          )
        : and(
            eq(plannedItems.periodId, periodId),
            inArray(plannedItems.targetKind, [...MANAGED_KINDS]),
            eq(plannedItems.frozen, false),
          );
    await tx.delete(plannedItems).where(staleFilter);

    if (rows.length === 0) return;
    await tx
      .insert(plannedItems)
      .values(
        rows.map((r) => ({
          workspaceId: ws.id,
          periodId,
          targetKind: r.targetKind,
          targetId: r.targetId,
          plannedMinor: r.plannedMinor,
        })),
      )
      .onConflictDoUpdate({
        target: [plannedItems.periodId, plannedItems.targetKind, plannedItems.targetId],
        // planned_minor пересобирается; execution_status/executed_minor сохраняются (исполнение
        // Спринта 3+). Строку, которую правил человек (пересборка), не трогаем: его решение
        // сильнее пересчёта из таблицы обязательства.
        set: {
          plannedMinor: sql`case when ${plannedItems.overridden} then ${plannedItems.plannedMinor} else excluded.planned_minor end`,
        },
      });
  });
}

/**
 * Ступени суммы из jsonb: суммы там строками (bigint в JSON не живёт). Кривая запись отбрасывается
 * поэлементно — падать пятисоткой на чтении плана из-за одной битой ступени нельзя.
 */
export function parseAmountSteps(raw: unknown): { from: string; amountMinor: bigint }[] {
  if (!Array.isArray(raw)) return [];
  const out: { from: string; amountMinor: bigint }[] = [];
  for (const item of raw) {
    const step = item as { from?: unknown; amountMinor?: unknown };
    if (typeof step?.from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(step.from)) continue;
    if (typeof step.amountMinor !== 'string' || !/^-?\d+$/.test(step.amountMinor)) continue;
    out.push({ from: step.from, amountMinor: BigInt(step.amountMinor) });
  }
  return normalizeSteps(out);
}

/**
 * Разбивка платежа по источникам из БД. Мусор молча пропускаем — как и в ступенях: строка с кривым
 * значением не должна валить сборку всего плана, но и подставлять вместо неё ноль нельзя.
 */
export function parsePaymentsBySource(raw: unknown): { sourceId: string; amountMinor: bigint }[] {
  if (!Array.isArray(raw)) return [];
  const out: { sourceId: string; amountMinor: bigint }[] = [];
  for (const item of raw) {
    const entry = item as { sourceId?: unknown; amountMinor?: unknown };
    if (typeof entry?.sourceId !== 'string' || entry.sourceId === '') continue;
    if (typeof entry.amountMinor !== 'string' || !/^\d+$/.test(entry.amountMinor)) continue;
    out.push({ sourceId: entry.sourceId, amountMinor: BigInt(entry.amountMinor) });
  }
  return out;
}

export interface IncomeEventDto {
  sourceId: string;
  label: string;
  date: string;
  amountMinor: string;
  currency: string;
  /** `received` — поступление подтверждено фактом (issue #48), `expected` — ещё ждём. */
  status: 'expected' | 'received';
  /** Только у подтверждённых: id записи, чтобы UI мог отменить подтверждение. */
  receiptId?: string;
  /** Только у подтверждённых: сумма в базовой валюте по зафиксированному курсу. */
  baseAmountMinor?: string;
}

export interface IncomeUnresolvedDto extends IncomeEventDto {
  reason: 'rate_unavailable';
}

/**
 * Доход периода: события источников внутри [startsOn, endsOn), приведённые к базовой валюте.
 * Курсы подгружаются одним пакетом по валютам событий, чтобы ядро осталось чистым и синхронным.
 */
async function incomeForPeriod(
  ws: Workspace,
  sources: readonly IncomeSource[],
  period: PayPeriod,
  asOf: string,
): Promise<{ incomeMinor: bigint; events: IncomeEventDto[]; unresolved: IncomeUnresolvedDto[] }> {
  const events = incomeEventsIn(sources, period, ws.paydayWeekendRule as WeekendRule);
  const foreign = [
    ...new Set(events.map((e) => e.currency).filter((ccy) => ccy !== ws.baseCurrency)),
  ];
  const snapshots = await Promise.all(
    foreign.map(async (ccy) => [ccy, await getRate(ccy, ws.baseCurrency, asOf, ws.id)] as const),
  );
  const rates = new Map(snapshots);
  const total = expectedIncomeForPeriod(events, ws.baseCurrency, (m) => {
    const snap = rates.get(m.currency);
    return snap ? convert(m, snap) : null;
  });
  const toDto = (e: (typeof events)[number]): IncomeEventDto => ({
    sourceId: e.sourceId,
    label: e.label,
    date: e.date,
    amountMinor: e.amountMinor.toString(),
    currency: e.currency,
    status: 'expected',
  });

  /*
   * Факт важнее плана (issue #48). Подтверждённое поступление замещает ожидаемое событие того же
   * источника: зарплату могли выдать раньше и не той суммой, и цифра дня обязана считаться по
   * тому, что реально пришло. Сопоставление — по источнику, а не по дате: дата факта почти всегда
   * отличается от плановой.
   */
  const receipts = await receiptsForPeriod(ws.id, period.startsOn, period.endsOn);
  const bySource = new Map<string, typeof receipts>();
  for (const r of receipts) {
    const list = bySource.get(r.sourceId) ?? [];
    list.push(r);
    bySource.set(r.sourceId, list);
  }

  const dtos: IncomeEventDto[] = [];
  const unresolved: IncomeUnresolvedDto[] = [];
  const unresolvedKeys = new Set(total.unresolved.map((e) => `${e.sourceId}:${e.date}`));
  let incomeMinor = 0n;

  for (const event of events) {
    const receipt = bySource.get(event.sourceId)?.shift();
    if (receipt) {
      incomeMinor += receipt.baseAmountMinor;
      dtos.push({
        sourceId: event.sourceId,
        label: event.label,
        date: receipt.occurredOn,
        amountMinor: receipt.amountMinor.toString(),
        currency: receipt.currency,
        status: 'received',
        receiptId: receipt.id,
        baseAmountMinor: receipt.baseAmountMinor.toString(),
      });
      continue;
    }
    const dto = toDto(event);
    dtos.push(dto);
    if (unresolvedKeys.has(`${event.sourceId}:${event.date}`)) {
      unresolved.push({ ...dto, reason: 'rate_unavailable' as const });
    } else {
      const snap = event.currency === ws.baseCurrency ? null : rates.get(event.currency);
      incomeMinor +=
        event.currency === ws.baseCurrency
          ? event.amountMinor
          : snap
            ? convert(money(event.amountMinor, event.currency), snap).minor
            : 0n;
    }
  }

  // Приход по источнику, у которого в этом периоде не было плановой выплаты (аванс, разовый гонорар):
  // деньги пришли — значит их видно в плане, иначе доход занижен.
  for (const [sourceId, rest] of bySource) {
    for (const receipt of rest) {
      incomeMinor += receipt.baseAmountMinor;
      dtos.push({
        sourceId,
        label: sources.find((src) => src.id === sourceId)?.label ?? '',
        date: receipt.occurredOn,
        amountMinor: receipt.amountMinor.toString(),
        currency: receipt.currency,
        status: 'received',
        receiptId: receipt.id,
        baseAmountMinor: receipt.baseAmountMinor.toString(),
      });
    }
  }

  return { incomeMinor, events: dtos, unresolved };
}

/**
 * Факт периода: расходы, приведённые к base на момент траты (снапшот в транзакции).
 * «Жизнь» — расходы по категориям и без категории («крупный мазок»); исполнение
 * обязательств (долги/корзины/цели) в неё не входит — это не повседневные траты.
 */
interface PeriodSpending {
  readonly byCategory: ReadonlyMap<string, bigint>;
  readonly livingMinor: bigint;
  /** Внеплановые приходы периода (side hustle): их нет в источниках, поэтому идут отдельно. */
  readonly extraIncomeMinor: bigint;
}

async function loadPeriodSpending(ws: Workspace, period: PayPeriod): Promise<PeriodSpending> {
  const rows = await db
    .select({
      kind: transactions.kind,
      targetKind: transactions.targetKind,
      targetId: transactions.targetId,
      total: sql<string>`sum(${transactions.baseAmountMinor})`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.workspaceId, ws.id),
        // По датам, а не по period_id: границы периода подвижны (правка ритма, правило выходных),
        // и при сдвиге появляется новая строка pay_periods — привязка по id теряла бы весь факт.
        // Полуинтервал [startsOn, endsOn) — как у событий дохода, иначе день выплаты попал бы в два периода.
        gte(transactions.occurredOn, period.startsOn),
        lt(transactions.occurredOn, period.endsOn),
        inArray(transactions.kind, ['expense', 'income']),
      ),
    )
    .groupBy(transactions.kind, transactions.targetKind, transactions.targetId);

  const byCategory = new Map<string, bigint>();
  let livingMinor = 0n;
  let extraIncomeMinor = 0n;
  for (const row of rows) {
    const total = BigInt(row.total ?? '0');
    if (row.kind === 'income') {
      extraIncomeMinor += total;
    } else if (row.targetKind === 'category' && row.targetId) {
      byCategory.set(row.targetId, (byCategory.get(row.targetId) ?? 0n) + total);
      livingMinor += total;
    } else if (row.targetKind == null) {
      livingMinor += total; // трата без категории тоже съедает деньги на жизнь
    }
  }
  return { byCategory, livingMinor, extraIncomeMinor };
}

export interface PlanAllocationDto {
  targetKind: TargetKind;
  targetId: string;
  name: string;
  sourceCurrency: string;
  sourceMinor: string;
  toCurrency?: string;
  plannedMinor: string; // желаемое (до сжатия), base
  allocatedMinor: string; // после сжатия, base
  shortfallMinor: string;
  spentMinor: string; // факт периода, base (для категорий; у обязательств пока 0)
  remainingMinor: string; // allocated − spent, может быть отрицательным
  overspentMinor: string;
  /** Исполнение плановой строки: pending | confirmed | partial | skipped | n_a. */
  executionStatus: ExecutionStatus;
  executedMinor: string;
  /** Сколько по строке ещё не внесено (0 у исполненных и у категорий). */
  remainderMinor: string;
  /** Защищённая категория: автоматика её не режет, только явный выбор пользователя. */
  protectedCategory?: boolean;
  /** Совет по бюджету на основе факта прошлых периодов (Спринт 4): поднять или опустить. */
  advice?: { kind: 'raise' | 'lower'; suggestedMinor: string; periods: number };
  /** Цель с осознанно пропущенным взносом в этом периоде (issue #54). */
  frozen?: boolean;
}

export interface PlanDto {
  period: { startsOn: string; endsOn: string };
  daysInPeriod: number;
  daysLeft: number;
  baseCurrency: string;
  /** Доход периода = ожидаемый по источникам + внеплановые приходы, уже зафиксированные фактом. */
  incomeMinor: string;
  /** Сколько из дохода пришло вне плана (side hustle) — показываем отдельной строкой. */
  extraIncomeMinor: string;
  totalPlannedMinor: string;
  totalAllocatedMinor: string;
  compressedMinor: string;
  /** Отложено буфером и не вошло в дневной темп (issue #49). */
  bufferMinor: string;
  freeMinor: string;
  toExchangeMinor: string;
  /** Дневной темп с учётом факта: остаток на жизнь ÷ daysLeft. */
  canSpendPerDayMinor: string;
  /** План на жизнь = категории + свободный остаток. */
  livingMinor: string;
  spentLivingMinor: string;
  remainingLivingMinor: string;
  overspentMinor: string;
  allocations: PlanAllocationDto[];
  unresolved: UnresolvedItem[];
  /** Разбивка ожидаемого дохода периода по источникам (дашборд, чеклист дня выплаты). */
  income: { events: IncomeEventDto[]; unresolved: IncomeUnresolvedDto[] };
  /** Темп трат и предупреждение «деньги кончатся такого-то числа» (Спринт 4). */
  burn: { perDayMinor: string; willLast: boolean; runsOutOn: string | null };
}

/**
 * Поля исполнения для строки плана. Категории исполнения не требуют (`n_a`): их факт
 * приходит тратами. Статус из БД первичен — «пропустил» нельзя вывести из суммы.
 */
function executionFields(
  targetKind: TargetKind,
  allocatedMinor: bigint,
  saved: { status: ExecutionStatus; executedMinor: bigint } | undefined,
): { executionStatus: ExecutionStatus; executedMinor: string; remainderMinor: string } {
  if (targetKind === 'category')
    return { executionStatus: 'n_a', executedMinor: '0', remainderMinor: '0' };
  const executedMinor = saved?.executedMinor ?? 0n;
  const derived = executionOf(allocatedMinor, executedMinor);
  const status = saved?.status === 'skipped' ? 'skipped' : derived.status;
  return {
    executionStatus: status,
    executedMinor: executedMinor.toString(),
    remainderMinor: (status === 'skipped' ? 0n : derived.remainderMinor).toString(),
  };
}

/** Совет по бюджету категории; для обязательств советов нет — их суммы задаёт договор. */
function adviceFields(
  targetKind: TargetKind,
  plannedMinor: bigint,
  history: bigint[] | undefined,
): { advice?: { kind: 'raise' | 'lower'; suggestedMinor: string; periods: number } } {
  if (targetKind !== 'category' || !history) return {};
  const advice = budgetAdvice({ plannedMinor, history });
  if (!advice) return {};
  return {
    advice: {
      kind: advice.kind,
      suggestedMinor: advice.suggestedMinor.toString(),
      periods: advice.periods,
    },
  };
}

/** Собирает и сохраняет план одного периода, возвращает DTO. */
async function assembleForPeriod(
  ws: Workspace,
  sources: readonly IncomeSource[],
  period: PayPeriod,
  asOf: string,
): Promise<PlanDto> {
  const income = await incomeForPeriod(ws, sources, period, asOf);
  const spending = await loadPeriodSpending(ws, period);
  // Внеплановый приход раздаётся тем же каскадом, что и зарплата: деньги пришли — им нужно
  // место в плане. Поэтому он входит в доход периода до каскада, а не «сверху» после него.
  const incomeMinor = income.incomeMinor + spending.extraIncomeMinor;
  const { id: periodId, created } = await ensurePeriodRow(ws, period, incomeMinor);
  // Перенос — только при рождении периода: очистку бюджетов в существующем периоде не затираем.
  if (created) await carryOverCategories(ws, periodId, period.startsOn);
  // План — проекция «на момент сборки»: конвертируем по курсу на asOf (сегодня), а не на
  // дату старта периода. Иммутабельный снапшот курса важен для транзакций-фактов, не для плана.
  const frozenGoals = await frozenGoalIds(periodId);
  const { resolved, unresolved } = await resolveObligations(
    ws,
    incomeMinor,
    asOf,
    period,
    frozenGoals,
    // Чьи выплаты приходят в этом периоде: долг с разбивкой берёт сумму именно с них.
    [...new Set(income.events.map((e) => e.sourceId))],
  );
  const cats = await loadCategoryBudgets(periodId);
  // Правки человека по обязательствам этого периода: пересборка списала часть взноса с цели.
  const overrides = await loadOverrides(periodId);

  // Обязательства (base уже посчитан) + категории (бюджет уже в base). Порядок каскада — в assemblePlan.
  const plan: PlanItem[] = [
    ...resolved.map((r) => ({
      targetKind: r.targetKind,
      targetId: r.targetId,
      // Переопределение периода важнее суммы из таблицы: иначе списание с цели исчезало бы, а
      // дефицит закрывал каскад за счёт той цели, которую человек не выбирал.
      plannedMinor: overrides.get(`${r.targetKind}:${r.targetId}`) ?? r.baseMinor,
    })),
    ...cats.map((c) => ({
      targetKind: 'category' as const,
      targetId: c.targetId,
      plannedMinor: c.baseMinor,
      protected: c.isProtected,
    })),
  ];
  const totalDays = daysInPeriod(period);
  const settings = settingsOf(ws);
  const { result, summary } = assemblePlan(incomeMinor, plan, {
    daysInPeriod: totalDays,
    compressOrder: settings.cascade.compressOrder,
  });

  // Дескрипторы для обогащения (имя/исходная валюта). Категории — в base-валюте.
  const desc = new Map<
    string,
    { name: string; sourceCurrency: string; sourceMinor: bigint; toCurrency?: string }
  >();
  for (const r of resolved)
    desc.set(`${r.targetKind}:${r.targetId}`, {
      name: r.name,
      sourceCurrency: r.sourceCurrency,
      sourceMinor: r.sourceMinor,
      ...(r.toCurrency ? { toCurrency: r.toCurrency } : {}),
    });
  for (const c of cats)
    desc.set(`category:${c.targetId}`, {
      name: c.name,
      sourceCurrency: ws.baseCurrency,
      sourceMinor: c.baseMinor,
    });

  const fact = summarizeFact(summary, {
    spentLivingMinor: spending.livingMinor,
    daysLeft: daysLeftInPeriod(period, asOf),
    // Буфер: часть остатка не входит в дневной темп, чтобы дойти до выплаты с запасом (issue #49).
    bufferPct: settings.cascade.bufferPct,
  });
  const executions = await loadExecutions(periodId);
  const history = await loadCategoryHistory(ws, period.startsOn, settings.signals.medianPeriods);
  const burn = burnRate({
    livingMinor: summary.livingMinor,
    spentLivingMinor: spending.livingMinor,
    period,
    asOf,
  });

  const allocations: PlanAllocationDto[] = result.allocations.map((a) => {
    const src = desc.get(`${a.targetKind}:${a.targetId}`)!;
    const spent = a.targetKind === 'category' ? (spending.byCategory.get(a.targetId) ?? 0n) : 0n;
    const cat = categorySpending(a.allocatedMinor, spent);
    return {
      targetKind: a.targetKind,
      targetId: a.targetId,
      name: src.name,
      sourceCurrency: src.sourceCurrency,
      sourceMinor: src.sourceMinor.toString(),
      ...(src.toCurrency ? { toCurrency: src.toCurrency } : {}),
      plannedMinor: a.plannedMinor.toString(),
      allocatedMinor: a.allocatedMinor.toString(),
      shortfallMinor: a.shortfallMinor.toString(),
      spentMinor: cat.spentMinor.toString(),
      remainingMinor: cat.remainingMinor.toString(),
      overspentMinor: cat.overspentMinor.toString(),
      ...executionFields(
        a.targetKind,
        a.allocatedMinor,
        executions.get(`${a.targetKind}:${a.targetId}`),
      ),
      ...(a.targetKind === 'category'
        ? { protectedCategory: cats.find((c) => c.targetId === a.targetId)?.isProtected === true }
        : {}),
      /*
       * Совет учится на ПЛАНЕ, а не на сжатой сумме (#97). Сжатие — это «в этом периоде не
       * хватило», а не «столько тебе и надо»: от allocated медиана сравнивалась с урезанной
       * цифрой, и на категории с планом ровно по медиане появлялся ложный совет «поднять».
       * Применить его было нельзя — он предлагал то же число и приходил снова каждый сжатый период.
       */
      ...(settings.periods.suggestRaises
        ? adviceFields(a.targetKind, a.plannedMinor, history.get(a.targetId))
        : {}),
      ...(a.targetKind === 'goal' ? { frozen: false } : {}),
    };
  });

  /*
   * Замороженные цели (issue #54): в каскаде их нет, но в плане они обязаны быть видны — иначе
   * пропуск читается как «цель исчезла», а мы просили не молчать о пропусках.
   */
  if (frozenGoals.size > 0) {
    const rows = await db
      .select({
        id: goals.id,
        name: goals.name,
        currency: goals.currency,
        plannedPerPeriodMinor: goals.plannedPerPeriodMinor,
      })
      .from(goals)
      .where(and(eq(goals.workspaceId, ws.id), inArray(goals.id, [...frozenGoals])));
    for (const row of rows) {
      allocations.push({
        targetKind: 'goal',
        targetId: row.id,
        name: row.name,
        sourceCurrency: row.currency,
        sourceMinor: row.plannedPerPeriodMinor.toString(),
        plannedMinor: '0',
        allocatedMinor: '0',
        shortfallMinor: '0',
        spentMinor: '0',
        remainingMinor: '0',
        overspentMinor: '0',
        executionStatus: 'skipped',
        executedMinor: '0',
        remainderMinor: '0',
        frozen: true,
      });
    }
  }

  // Категории, где трата есть, а бюджета нет: без этих строк факт молча исчезал бы из UI
  // (в каскад они не попадают, потому что planned = 0). Отдаём их как чистый перерасход.
  const spentWithoutBudget = [...spending.byCategory.keys()].filter(
    (id) => !result.allocations.some((a) => a.targetKind === 'category' && a.targetId === id),
  );
  if (spentWithoutBudget.length > 0) {
    const rows = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(and(eq(categories.workspaceId, ws.id), inArray(categories.id, spentWithoutBudget)));
    for (const row of rows) {
      const cat = categorySpending(0n, spending.byCategory.get(row.id) ?? 0n);
      allocations.push({
        targetKind: 'category',
        targetId: row.id,
        name: row.name,
        sourceCurrency: ws.baseCurrency,
        sourceMinor: '0',
        plannedMinor: '0',
        allocatedMinor: '0',
        shortfallMinor: '0',
        spentMinor: cat.spentMinor.toString(),
        remainingMinor: cat.remainingMinor.toString(),
        overspentMinor: cat.overspentMinor.toString(),
        executionStatus: 'n_a',
        executedMinor: '0',
        remainderMinor: '0',
      });
    }
  }

  // Пишем только обязательства (allocated); категории не трогаем — их бюджет задаёт пользователь.
  await persistPlannedItems(
    ws,
    periodId,
    result.allocations
      .filter((a) => a.targetKind !== 'category')
      .map((a) => ({
        targetKind: a.targetKind,
        targetId: a.targetId,
        plannedMinor: a.allocatedMinor,
      })),
  );

  return {
    period: { startsOn: period.startsOn, endsOn: period.endsOn },
    daysInPeriod: totalDays,
    daysLeft: daysLeftInPeriod(period, asOf),
    baseCurrency: ws.baseCurrency,
    incomeMinor: incomeMinor.toString(),
    extraIncomeMinor: spending.extraIncomeMinor.toString(),
    totalPlannedMinor: result.totalPlannedMinor.toString(),
    totalAllocatedMinor: result.totalAllocatedMinor.toString(),
    compressedMinor: result.compressedMinor.toString(),
    bufferMinor: fact.bufferMinor.toString(),
    freeMinor: result.freeMinor.toString(),
    /*
     * Сумма к размену округляется вверх по настройке (issue #49): человек идёт в обменник с
     * круглым числом, а не с 47 813. Округление живёт здесь, а не в ядре плана: это про то, как
     * человек пользуется цифрой, а не про то, сколько денег каскад отложил.
     */
    /*
     * Сумма к размену округляется вверх по настройке (issue #49): человек идёт в обменник с
     * круглым числом, а не с 47 813. Округление живёт здесь, а не в ядре плана: это про то, как
     * человек пользуется цифрой, а не про то, сколько денег каскад отложил.
     */
    toExchangeMinor: roundExchangeUp(
      summary.toExchangeMinor,
      settings.currency.exchangeRoundingMajor,
      exponentOf(ws.baseCurrency as Currency),
    ).toString(),
    canSpendPerDayMinor: fact.canSpendPerDayMinor.toString(),
    livingMinor: summary.livingMinor.toString(),
    spentLivingMinor: fact.spentLivingMinor.toString(),
    remainingLivingMinor: fact.remainingLivingMinor.toString(),
    overspentMinor: fact.overspentMinor.toString(),
    allocations,
    unresolved,
    income: { events: income.events, unresolved: income.unresolved },
    burn: {
      perDayMinor: burn.perDayMinor.toString(),
      willLast: burn.willLast,
      runsOutOn: burn.runsOutOn,
    },
  };
}

/**
 * Гарантирует строку периода, в который попадает дата (нужно для привязки факта к периоду).
 * Доход периода берётся из источников — та же цифра, что и в плане, поэтому строка периода
 * не «портится» нулём, если трату внесли раньше первого открытия плана.
 * Бросает `onboarding_incomplete`, если ритм выплат ещё не задан.
 */
export async function ensurePeriodForDate(
  ws: Workspace,
  on: string,
): Promise<{ periodId: string; period: PayPeriod }> {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const period = periodForDate(ws.periodAnchors as PeriodConfig, on);
  const sources = await listSources(ws.id);
  const { incomeMinor } = await incomeForPeriod(ws, sources, period, on);
  const { id } = await ensurePeriodRow(ws, period, incomeMinor);
  return { periodId: id, period };
}

/** Текущий период по ритму воркспейса. Бросает при незавершённом онбординге/неопределимом периоде. */
/** Текущий период воркспейса — нужен и вне сборки плана (аналитика, issue #51). */
export function currentPeriodFor(ws: Workspace, asOf: string): PayPeriod {
  return currentPeriod(ws, asOf);
}

function currentPeriod(ws: Workspace, asOf: string): PayPeriod {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const [current] = generatePeriods(ws.periodAnchors as PeriodConfig, asOf, 2);
  if (!current) throw new Error('period_undeterminable');
  return current;
}

/** Активные источники воркспейса. Пусто → онбординг не завершён (план собрался бы на нуле). */
async function activeSources(ws: Workspace): Promise<IncomeSource[]> {
  const sources = (await listSources(ws.id)).filter((s) => s.active);
  if (sources.length === 0) throw new Error('onboarding_incomplete');
  return sources;
}

/**
 * План текущего периода: гарантирует и собирает текущий + следующий периоды,
 * возвращает DTO текущего. Бросает, если онбординг не завершён (нет ритма или источников).
 */
export async function getCurrentPlan(ws: Workspace, asOf: string): Promise<PlanDto> {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const sources = await activeSources(ws);
  const anchors = ws.periodAnchors as PeriodConfig;
  const [current, next] = generatePeriods(anchors, asOf, 2);
  if (!current) throw new Error('period_undeterminable');
  const dto = await assembleForPeriod(ws, sources, current, asOf);
  // Следующий период тоже собираем «вперёд» (DoD), но в ответ не кладём.
  if (next) await assembleForPeriod(ws, sources, next, asOf);
  return dto;
}

/**
 * Ставит бюджет категории на текущий период (base-валюта). plannedMinor ≤ 0 → удаляет строку
 * (0 = «без бюджета»). Проверяет принадлежность категории workspace (изоляция, правило 7).
 * Возвращает пересобранный план текущего периода.
 */
/**
 * Правка ячейки мастер-сетки (запрос владельца 13.08.2026: «в режиме таблицы должна быть возможность
 * редактировать поля, и чтобы оттуда шло распределение обратно»).
 *
 * В сетке смешаны числа двух разных природ, и делать вид, что они одинаковы, нельзя:
 *
 * - **бюджет категории** живёт на периоде (`planned_items`) — правка меняет ОДИН столбец;
 * - **платёж долга, правило конверта, взнос в цель** живут на самой сущности — правка означает «с
 *   этой даты и далее столько», то есть ступень суммы (`amountSteps`). Иначе человек поправил бы
 *   декабрь и не понял, почему поехал март.
 *
 * Прошлые периоды не правятся: план закрытого периода — история, а не черновик.
 */
/**
 * Ступень суммы обязательства с указанной даты (или правка базовой суммы для текущего периода).
 *
 * Одна функция на долг, конверт и цель: у них разные колонки суммы, но одно правило — «с этой даты
 * платить столько». Держать три почти одинаковые ветки в вызывающем коде значило бы гарантированно
 * разойтись в одной из них.
 */
async function setObligationAmountFrom(
  ws: Workspace,
  cell: { targetKind: TargetKind; targetId: string; startsOn: string; plannedMinor: bigint },
  isCurrent: boolean,
): Promise<void> {
  const table =
    cell.targetKind === 'debt'
      ? debts
      : cell.targetKind === 'envelope'
        ? envelopes
        : cell.targetKind === 'goal'
          ? goals
          : null;
  if (!table) throw new Error('cell_not_editable');

  const rows = await db
    .select()
    .from(table)
    .where(and(eq(table.id, cell.targetId), eq(table.workspaceId, ws.id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('target_not_found');

  if (isCurrent) {
    // Базовая сумма: для долга это платёж, для конверта — значение правила, для цели — взнос.
    const patch =
      cell.targetKind === 'debt'
        ? { paymentMinor: cell.plannedMinor }
        : cell.targetKind === 'envelope'
          ? { ruleValue: cell.plannedMinor.toString() }
          : { plannedPerPeriodMinor: cell.plannedMinor };
    await db
      .update(table)
      .set(patch as never)
      .where(eq(table.id, cell.targetId));
    return;
  }

  const steps = parseAmountSteps((row as { amountSteps?: unknown }).amountSteps).filter(
    (s) => s.from !== cell.startsOn,
  );
  const next = [...steps, { from: cell.startsOn, amountMinor: cell.plannedMinor }]
    .sort((a, b) => (a.from < b.from ? -1 : 1))
    .map((s) => ({ from: s.from, amountMinor: s.amountMinor.toString() }));
  await db
    .update(table)
    .set({ amountSteps: next } as never)
    .where(eq(table.id, cell.targetId));
}

export async function setGridCell(
  ws: Workspace,
  asOf: string,
  cell: { targetKind: TargetKind; targetId: string; startsOn: string; plannedMinor: bigint },
): Promise<void> {
  const current = currentPeriod(ws, asOf);
  if (cell.startsOn < current.startsOn) throw new Error('period_is_past');

  if (cell.targetKind === 'category') {
    const owned = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, cell.targetId), eq(categories.workspaceId, ws.id)))
      .limit(1);
    if (!owned[0]) throw new Error('category_not_found');

    const period = periodForDate(ws.periodAnchors as PeriodConfig, cell.startsOn);
    const sources = await activeSources(ws);
    const { incomeMinor } = await incomeForPeriod(ws, sources, period, asOf);
    const { id: periodId } = await ensurePeriodRow(ws, period, incomeMinor);

    if (cell.plannedMinor <= 0n) {
      await db
        .delete(plannedItems)
        .where(
          and(
            eq(plannedItems.periodId, periodId),
            eq(plannedItems.targetKind, 'category'),
            eq(plannedItems.targetId, cell.targetId),
          ),
        );
      return;
    }
    await db
      .insert(plannedItems)
      .values({
        workspaceId: ws.id,
        periodId,
        targetKind: 'category',
        targetId: cell.targetId,
        plannedMinor: cell.plannedMinor,
        executionStatus: 'n_a',
      })
      .onConflictDoUpdate({
        target: [plannedItems.periodId, plannedItems.targetKind, plannedItems.targetId],
        set: { plannedMinor: sql`excluded.planned_minor` },
      });
    return;
  }

  /*
   * Обязательства: ступень суммы с даты периода. В текущем периоде правим базовую сумму — ступень
   * «с сегодня» была бы тем же числом, но лишней строкой в списке ступеней, которую человек потом
   * увидит и не поймёт, откуда она.
   */
  await setObligationAmountFrom(ws, cell, cell.startsOn === current.startsOn);
}

export async function setCategoryBudget(
  ws: Workspace,
  asOf: string,
  categoryId: string,
  plannedMinor: bigint,
): Promise<PlanDto> {
  const owned = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.workspaceId, ws.id)))
    .limit(1);
  if (!owned[0]) throw new Error('category_not_found');

  const period = currentPeriod(ws, asOf);
  const sources = await activeSources(ws);
  const { incomeMinor } = await incomeForPeriod(ws, sources, period, asOf);
  const { id: periodId } = await ensurePeriodRow(ws, period, incomeMinor);

  if (plannedMinor <= 0n) {
    await db
      .delete(plannedItems)
      .where(
        and(
          eq(plannedItems.periodId, periodId),
          eq(plannedItems.targetKind, 'category'),
          eq(plannedItems.targetId, categoryId),
        ),
      );
  } else {
    await db
      .insert(plannedItems)
      .values({
        workspaceId: ws.id,
        periodId,
        targetKind: 'category',
        targetId: categoryId,
        plannedMinor,
        executionStatus: 'n_a',
      })
      .onConflictDoUpdate({
        target: [plannedItems.periodId, plannedItems.targetKind, plannedItems.targetId],
        set: { plannedMinor: sql`excluded.planned_minor` },
      });
  }
  return getCurrentPlan(ws, asOf);
}

/**
 * Исполнение плановой строки (01-domain-model §Исполнение): «сделал» / «пропустил».
 *
 * Подтверждение создаёт транзакцию со ссылкой на planned_item — исполнение долга это
 * тоже факт движения денег. Повторное подтверждение переписывает свою транзакцию, а не
 * плодит новые (кнопку легко нажать дважды).
 *
 * Категории исполнять нельзя: их факт приходит тратами естественно (там `n_a`).
 * Суммы — в base-валюте: planned_minor хранится в base, поэтому и executed тоже.
 */
export async function setExecution(
  ws: Workspace,
  asOf: string,
  targetKind: TargetKind,
  targetId: string,
  mode: 'confirm' | 'skip' | 'unconfirm',
  executedOverrideMinor?: bigint,
): Promise<PlanDto> {
  if (targetKind === 'category') throw new Error('execution_not_applicable');

  const period = currentPeriod(ws, asOf);
  const sources = await activeSources(ws);
  const { incomeMinor } = await incomeForPeriod(ws, sources, period, asOf);
  const { id: periodId } = await ensurePeriodRow(ws, period, incomeMinor);

  const findItem = async () => {
    const rows = await db
      .select({ id: plannedItems.id, plannedMinor: plannedItems.plannedMinor })
      .from(plannedItems)
      .where(
        and(
          eq(plannedItems.workspaceId, ws.id),
          eq(plannedItems.periodId, periodId),
          eq(plannedItems.targetKind, targetKind),
          eq(plannedItems.targetId, targetId),
        ),
      )
      .limit(1);
    return rows[0];
  };

  // Строки плана появляются в БД при сборке. Если её ещё не было (обязательство создали и
  // сразу отметили «сделал», не открыв «План»), собираем и ищем снова — иначе результат
  // зависел бы от того, успел ли клиент запросить план.
  let item = await findItem();
  if (!item) {
    await assembleForPeriod(ws, sources, period, asOf);
    item = await findItem();
  }
  if (!item) throw new Error('planned_item_not_found');

  /*
   * Отмена (жалоба владельца 16.08.2026: «внесено при нажатии никак не реагирует, а должно
   * отменять»). Возвращает строку ровно в то состояние, в котором она была до отметки: ноль
   * исполненного и статус «ждём». Отдельная ветка, а не «подтвердить на ноль»: подтверждение на
   * ноль означало бы «заплатил нисколько», и это другое утверждение.
   */
  const executedMinor = mode === 'confirm' ? (executedOverrideMinor ?? item.plannedMinor) : 0n;
  const status =
    mode === 'skip'
      ? 'skipped'
      : mode === 'unconfirm'
        ? 'pending'
        : executionOf(item.plannedMinor, executedMinor).status;

  // Транзакции этой строки пересоздаём: одна строка плана — одна транзакция исполнения.
  await db
    .delete(transactions)
    .where(and(eq(transactions.workspaceId, ws.id), eq(transactions.plannedItemId, item.id)));
  if (executedMinor > 0n) {
    await db.insert(transactions).values({
      workspaceId: ws.id,
      periodId,
      kind: 'expense',
      targetKind,
      targetId,
      amountMinor: executedMinor,
      currency: ws.baseCurrency,
      baseAmountMinor: executedMinor,
      rate: '1',
      rateSource: 'base',
      rateDate: asOf,
      occurredOn: asOf,
      source: 'manual',
      plannedItemId: item.id,
    });
  }

  await db
    .update(plannedItems)
    .set({ executionStatus: status, executedMinor })
    .where(eq(plannedItems.id, item.id));

  return getCurrentPlan(ws, asOf);
}

export interface RebalanceOptionDto {
  targetKind: TargetKind;
  targetId: string;
  name: string;
  availableMinor: string;
  takeMinor: string;
  /** Бейдж «как обычно»: из этого источника уже брали в прошлых пересборках. */
  usual: boolean;
}

/**
 * Варианты пересборки: откуда добавить денег строке `targetId` (04-web-ux §Пересборка).
 * Порядок уступки считает ядро; здесь добавляется история: варианты, которые пользователь
 * уже выбирал, поднимаются вверх и помечаются «как обычно» — система предлагает то, что он
 * решал раньше, а не то, что ей удобнее.
 */
export async function rebalanceSuggestions(
  ws: Workspace,
  asOf: string,
  targetId: string,
  needMinor: bigint,
): Promise<RebalanceOptionDto[]> {
  const plan = await getCurrentPlan(ws, asOf);
  const rows = plan.allocations.map((a) => ({
    targetKind: a.targetKind,
    targetId: a.targetId,
    name: a.name,
    allocatedMinor: BigInt(a.allocatedMinor),
    spentMinor: BigInt(a.targetKind === 'category' ? a.spentMinor : a.executedMinor),
    protected: a.protectedCategory === true,
  }));
  const options = rebalanceOptions({ rows, needMinor, targetId });

  const history = await loadRebalanceHistory(ws.id);
  return options
    .map((o) => ({
      targetKind: o.targetKind,
      targetId: o.targetId,
      name: o.name,
      availableMinor: o.availableMinor.toString(),
      takeMinor: o.takeMinor.toString(),
      usual: (history.get(o.targetId) ?? 0) > 0,
    }))
    .sort((a, b) => (history.get(b.targetId) ?? 0) - (history.get(a.targetId) ?? 0));
}

/**
 * История ревизий периода (issue #52). Отдаём то, что нужно строке в интерфейсе: сколько, откуда,
 * куда и когда. Имена строк резолвим здесь же — иначе UI пришлось бы делать второй запрос ради
 * подписи, а по id человек ничего не узнаёт.
 *
 * `accepted = false` означает «откатано». Ревизии не удаляются никогда: по истории считается
 * «как обычно», и вычищенное прошлое сделало бы подсказки неверными.
 */
export interface RevisionMoveDto {
  fromKind: string;
  fromId: string;
  fromName: string | null;
  toKind: string;
  toId: string;
  toName: string | null;
  amountMinor: string;
}

export interface RevisionDto {
  id: string;
  reason: string;
  createdAt: string;
  undone: boolean;
  /** `move` — перенос между строками, `freeze`/`unfreeze` — пропуск взноса в цель (issue #54). */
  kind: 'move' | 'freeze' | 'unfreeze';
  moves: RevisionMoveDto[];
}

interface RawMove {
  fromKind?: string;
  fromId?: string;
  toKind?: string;
  toId?: string;
  amountMinor?: string;
  /** Заморозка и её снятие пишутся тем же журналом, но переносом не являются. */
  action?: 'freeze' | 'unfreeze';
  freezeKind?: string;
  freezeId?: string;
}

/** Имена строк плана по id — одним пакетом на все виды обязательств. */
async function namesByIds(
  workspaceId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const unique = [...new Set(ids)];
  const [cats, debtRows, envRows, goalRows, bucketRows] = await Promise.all([
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(and(eq(categories.workspaceId, workspaceId), inArray(categories.id, unique))),
    db
      .select({ id: debts.id, name: debts.name })
      .from(debts)
      .where(and(eq(debts.workspaceId, workspaceId), inArray(debts.id, unique))),
    db
      .select({ id: envelopes.id, name: envelopes.name })
      .from(envelopes)
      .where(and(eq(envelopes.workspaceId, workspaceId), inArray(envelopes.id, unique))),
    db
      .select({ id: goals.id, name: goals.name })
      .from(goals)
      .where(and(eq(goals.workspaceId, workspaceId), inArray(goals.id, unique))),
    db
      .select({ id: currencyBuckets.id, name: currencyBuckets.name })
      .from(currencyBuckets)
      .where(
        and(eq(currencyBuckets.workspaceId, workspaceId), inArray(currencyBuckets.id, unique)),
      ),
  ]);
  for (const row of [...cats, ...debtRows, ...envRows, ...goalRows, ...bucketRows]) {
    names.set(row.id, row.name);
  }
  return names;
}

export async function listRevisions(ws: Workspace, asOf: string): Promise<RevisionDto[]> {
  const period = currentPeriod(ws, asOf);
  const rows = await db
    .select({
      id: planRevisions.id,
      reason: planRevisions.reason,
      accepted: planRevisions.accepted,
      moves: planRevisions.moves,
      createdAt: planRevisions.createdAt,
      periodStart: payPeriods.startsOn,
    })
    .from(planRevisions)
    .innerJoin(payPeriods, eq(planRevisions.periodId, payPeriods.id))
    .where(and(eq(planRevisions.workspaceId, ws.id), eq(payPeriods.startsOn, period.startsOn)))
    .orderBy(desc(planRevisions.createdAt))
    .limit(50);

  const ids = rows.flatMap((r) =>
    ((r.moves as RawMove[] | null) ?? []).flatMap((m) => [m.fromId, m.toId, m.freezeId]),
  );
  const names = await namesByIds(
    ws.id,
    ids.filter((id): id is string => typeof id === 'string'),
  );

  return rows.map((r) => {
    const raw = (r.moves as RawMove[] | null) ?? [];
    const action = raw.find((m) => m.action)?.action;
    return {
      id: r.id,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      undone: !r.accepted,
      kind: action ?? ('move' as const),
      moves: raw.map((m) => {
        // У заморозки «источник» — сама цель: строка истории читается как «Мотоцикл, 5 000».
        const fromId = m.freezeId ?? m.fromId ?? '';
        return {
          fromKind: m.freezeKind ?? m.fromKind ?? '',
          fromId,
          fromName: fromId ? (names.get(fromId) ?? null) : null,
          toKind: m.toKind ?? '',
          toId: m.toId ?? '',
          toName: m.toId ? (names.get(m.toId) ?? null) : null,
          amountMinor: m.amountMinor ?? '0',
        };
      }),
    };
  });
}

export class FreezeNotApplicable extends Error {}
export class FreezeAlreadySet extends Error {}
export class FreezeAfterExecution extends Error {}

/**
 * Заморозка взноса в цель на текущий период (issue #54). Пропуск — решение человека, а не сжатие
 * каскада: накопленное остаётся, цель не удаляется, освободившиеся деньги видны как свободные.
 *
 * Только цели: долги и валютные корзины автоматика не трогает никогда, и руками их «пропускать»
 * тем же жестом было бы опасно — платёж по кредиту не пропускают одной кнопкой.
 */
export async function setGoalFreeze(
  ws: Workspace,
  asOf: string,
  targetKind: TargetKind,
  goalId: string,
  frozen: boolean,
): Promise<PlanDto> {
  if (targetKind !== 'goal') throw new FreezeNotApplicable();

  const goalRows = await db
    .select({ id: goals.id, name: goals.name, planned: goals.plannedPerPeriodMinor })
    .from(goals)
    .where(and(eq(goals.workspaceId, ws.id), eq(goals.id, goalId)))
    .limit(1);
  const goal = goalRows[0];
  if (!goal) throw new Error('goal_not_found');

  const period = currentPeriod(ws, asOf);
  const sources = await activeSources(ws);
  const { incomeMinor } = await incomeForPeriod(ws, sources, period, asOf);
  const { id: periodId } = await ensurePeriodRow(ws, period, incomeMinor);

  const existing = await db
    .select({
      id: plannedItems.id,
      frozen: plannedItems.frozen,
      status: plannedItems.executionStatus,
      executedMinor: plannedItems.executedMinor,
    })
    .from(plannedItems)
    .where(
      and(
        eq(plannedItems.periodId, periodId),
        eq(plannedItems.targetKind, 'goal'),
        eq(plannedItems.targetId, goalId),
      ),
    )
    .limit(1);
  // Повторное нажатие — не «ещё одна заморозка», а ошибка: иначе история копит пустые записи.
  if (existing[0]?.frozen === frozen) throw new FreezeAlreadySet();
  /*
   * Заморозить уже исполненный взнос нельзя: деньги отложены, транзакция расхода существует, и
   * «освобождение» этой суммы дважды показало бы её свободной (найдено адверсарным аудитом).
   * Сначала нужно отменить исполнение — это отдельный осознанный жест.
   */
  if (frozen && existing[0] && existing[0].executedMinor > 0n) throw new FreezeAfterExecution();

  await db.transaction(async (tx) => {
    if (existing[0]) {
      await tx
        .update(plannedItems)
        // planned_minor обнуляем вместе с заморозкой: строка больше не участвует в раздаче, а при
        // снятии сумма вернётся из самой цели на следующей сборке.
        .set({ frozen, ...(frozen ? { plannedMinor: 0n } : {}) })
        .where(eq(plannedItems.id, existing[0].id));
    } else {
      await tx.insert(plannedItems).values({
        workspaceId: ws.id,
        periodId,
        targetKind: 'goal',
        targetId: goalId,
        plannedMinor: 0n,
        executionStatus: 'skipped',
        frozen,
      });
    }
    // Пропуск попадает в историю правок: «о пропусках не молчим» (01-domain-model §Исполнение).
    await tx.insert(planRevisions).values({
      workspaceId: ws.id,
      periodId,
      reason: 'manual',
      moves: [
        {
          action: frozen ? 'freeze' : 'unfreeze',
          freezeKind: 'goal',
          freezeId: goalId,
          amountMinor: goal.planned.toString(),
        },
      ],
    });
  });

  return getCurrentPlan(ws, asOf);
}

export class RevisionNotFound extends Error {}
export class RevisionAlreadyUndone extends Error {}
export class UndoWouldGoNegative extends Error {}

/**
 * Откат ревизии: возвращаем суммы обратно и пишем сам откат ещё одной ревизией. Если деньги уже
 * ушли дальше и строка-получатель уйдёт в минус, откат не делается вовсе — тихо обнулить строку
 * было бы хуже, чем сказать «так уже не получится».
 */
export async function undoRevision(
  ws: Workspace,
  asOf: string,
  revisionId: string,
): Promise<PlanDto> {
  const period = currentPeriod(ws, asOf);
  const rows = await db
    .select({
      id: planRevisions.id,
      periodId: planRevisions.periodId,
      accepted: planRevisions.accepted,
      moves: planRevisions.moves,
    })
    .from(planRevisions)
    .innerJoin(payPeriods, eq(planRevisions.periodId, payPeriods.id))
    .where(
      and(
        eq(planRevisions.workspaceId, ws.id),
        eq(planRevisions.id, revisionId),
        eq(payPeriods.startsOn, period.startsOn),
      ),
    )
    .limit(1);
  const revision = rows[0];
  if (!revision) throw new RevisionNotFound();
  if (!revision.accepted) throw new RevisionAlreadyUndone();

  const moves = ((revision.moves as RawMove[] | null) ?? []).filter(
    (m) => m.fromId && m.toId && m.amountMinor,
  );
  if (moves.length === 0) throw new RevisionNotFound();

  const ids = moves.flatMap((m) => [m.fromId!, m.toId!]);
  const items = await db
    .select({
      id: plannedItems.id,
      targetId: plannedItems.targetId,
      plannedMinor: plannedItems.plannedMinor,
    })
    .from(plannedItems)
    .where(and(eq(plannedItems.periodId, revision.periodId), inArray(plannedItems.targetId, ids)));
  const byTarget = new Map(items.map((i) => [i.targetId, i]));

  // Сначала проверяем весь откат целиком: половинчатая правка плана хуже отказа.
  for (const m of moves) {
    const to = byTarget.get(m.toId!);
    if (!to) throw new RevisionNotFound();
    if (to.plannedMinor < BigInt(m.amountMinor!)) throw new UndoWouldGoNegative();
  }

  await db.transaction(async (tx) => {
    for (const m of moves) {
      const amount = BigInt(m.amountMinor!);
      const from = byTarget.get(m.fromId!);
      const to = byTarget.get(m.toId!)!;
      await tx
        .update(plannedItems)
        .set({ plannedMinor: to.plannedMinor - amount })
        .where(eq(plannedItems.id, to.id));
      if (from) {
        await tx
          .update(plannedItems)
          // Снимаем признак правки: сумма вернулась к «своей», и дальше её снова считает сборка,
          // иначе правка самой цели больше не влияла бы на этот период.
          .set({ plannedMinor: from.plannedMinor + amount, overridden: false })
          .where(eq(plannedItems.id, from.id));
      }
    }
    await tx
      .update(planRevisions)
      .set({ accepted: false })
      .where(eq(planRevisions.id, revision.id));
    // Сам откат — тоже ревизия: история дописывается, а не переписывается.
    /*
     * Причина 'undo', а не 'manual' (#102): компенсирующая ревизия несёт перевёрнутые концы, и в
     * выборке для ранжирования она делала ПОЛУЧАТЕЛЯ отменённого переноса «источником, из
     * которого обычно берут». Система советовала брать оттуда, куда человек только что положил и
     * передумал. Отличать откат от настоящей правки нужно самой строке — по ней учится ранжирование.
     */
    await tx.insert(planRevisions).values({
      workspaceId: ws.id,
      periodId: revision.periodId,
      reason: 'undo',
      moves: moves.map((m) => ({
        fromKind: m.toKind,
        fromId: m.toId,
        toKind: m.fromKind,
        toId: m.fromId,
        amountMinor: m.amountMinor,
      })),
    });
  });

  return getCurrentPlan(ws, asOf);
}

/** Сколько раз из каждого источника уже брали (по принятым PlanRevision). */
async function loadRebalanceHistory(workspaceId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ moves: planRevisions.moves })
    .from(planRevisions)
    .where(
      and(
        eq(planRevisions.workspaceId, workspaceId),
        eq(planRevisions.accepted, true),
        // Откаты в привычку не складываются: человек от этого переноса отказался (#102).
        ne(planRevisions.reason, 'undo'),
      ),
    )
    .orderBy(desc(planRevisions.createdAt))
    .limit(50);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const moves = row.moves as { fromId?: string }[] | null;
    for (const move of moves ?? []) {
      if (!move.fromId) continue;
      counts.set(move.fromId, (counts.get(move.fromId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Применяет пересборку: снимает сумму с источника и добавляет получателю, записывая
 * PlanRevision (инвариант 5 — каждая правка плана оставляет след, на нём учится ранжирование).
 * Долги и корзины источником быть не могут — их бюджет автоматика не режет.
 */
export async function applyRebalance(
  ws: Workspace,
  asOf: string,
  /** fromKind приходит от клиента только для читаемости запроса — решение принимается по БД. */
  input: { fromKind?: TargetKind; fromId: string; toId: string; amountMinor: bigint },
): Promise<PlanDto> {
  if (input.amountMinor <= 0n) throw new Error('invalid_amount');
  if (input.fromId === input.toId) throw new Error('same_target');

  const period = currentPeriod(ws, asOf);
  const sources = await activeSources(ws);
  const { incomeMinor } = await incomeForPeriod(ws, sources, period, asOf);
  const { id: periodId } = await ensurePeriodRow(ws, period, incomeMinor);

  const rows = await db
    .select({
      id: plannedItems.id,
      targetKind: plannedItems.targetKind,
      targetId: plannedItems.targetId,
      plannedMinor: plannedItems.plannedMinor,
    })
    .from(plannedItems)
    .where(
      and(
        eq(plannedItems.periodId, periodId),
        inArray(plannedItems.targetId, [input.fromId, input.toId]),
      ),
    );
  const from = rows.find((r) => r.targetId === input.fromId);
  const to = rows.find((r) => r.targetId === input.toId);
  if (!from || !to) throw new Error('planned_item_not_found');
  // Тип источника берём из БД, а не из запроса: клиент мог назвать долг «категорией»
  // и обойти защиту (железное правило 7 — данные от клиента не авторитетны).
  if (from.targetKind === 'debt' || from.targetKind === 'bucket')
    throw new Error('source_protected');
  // Получателем может быть только категория: желаемые суммы обязательств на каждой сборке
  // берутся из своих таблиц (payment_minor, planned_per_period_minor, правило конверта), и
  // прибавка к planned_items им ничего не даёт — источник урезался бы, а платёж не рос.
  if (to.targetKind !== 'category') throw new Error('target_not_adjustable');
  if (from.targetKind === 'category') {
    const owned = await db
      .select({ isProtected: categories.protected })
      .from(categories)
      .where(and(eq(categories.id, from.targetId), eq(categories.workspaceId, ws.id)))
      .limit(1);
    if (owned[0]?.isProtected) throw new Error('source_protected');
  }
  if (from.plannedMinor < input.amountMinor) throw new Error('insufficient_source');

  /*
   * Одной транзакцией: списание, зачисление и запись в историю — три части одного решения.
   * Половинчатая правка плана хуже отказа (тот же принцип, что в `undoRevision`).
   *
   * `overridden` ставим у источника-обязательства: его «желаемая» сумма живёт в своей таблице, и
   * без признака следующая сборка вернула бы её назад, оставив прибавку получателю.
   */
  await db.transaction(async (tx) => {
    await tx
      .update(plannedItems)
      .set({
        plannedMinor: from.plannedMinor - input.amountMinor,
        ...(from.targetKind === 'category' ? {} : { overridden: true }),
      })
      .where(eq(plannedItems.id, from.id));
    await tx
      .update(plannedItems)
      .set({ plannedMinor: to.plannedMinor + input.amountMinor })
      .where(eq(plannedItems.id, to.id));
    await tx.insert(planRevisions).values({
      workspaceId: ws.id,
      periodId,
      reason: 'overspend',
      moves: [
        {
          fromKind: from.targetKind,
          fromId: from.targetId,
          toKind: to.targetKind,
          toId: to.targetId,
          amountMinor: input.amountMinor.toString(),
        },
      ],
    });
  });

  return getCurrentPlan(ws, asOf);
}
