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
  assemblePlan,
  burnRate,
  categorySpending,
  convert,
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
import { and, desc, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm';
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
} from '../db/schema/domain.ts';
import { listSources } from '../income/store.ts';
import type { Workspace } from '../middleware.ts';
import { getRate } from '../fx/service.ts';

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
    .map((r) => ({ targetId: r.targetId, name: r.name, isProtected: r.isProtected, baseMinor: r.plannedMinor }));
}

/** Статусы исполнения плановых строк периода: ключ `kind:id`. */
async function loadExecutions(periodId: string): Promise<Map<string, { status: ExecutionStatus; executedMinor: bigint }>> {
  const rows = await db
    .select({
      targetKind: plannedItems.targetKind,
      targetId: plannedItems.targetId,
      status: plannedItems.executionStatus,
      executedMinor: plannedItems.executedMinor,
    })
    .from(plannedItems)
    .where(eq(plannedItems.periodId, periodId));
  return new Map(
    rows.map((r) => [`${r.targetKind}:${r.targetId}`, { status: r.status as ExecutionStatus, executedMinor: r.executedMinor }]),
  );
}

/**
 * Перенос бюджетов категорий из самого свежего предыдущего периода (архивные не переносятся).
 * Вызывается ТОЛЬКО при рождении периода (см. ensurePeriodRow.created) — поэтому очистка
 * бюджетов в существующем периоде сохраняется, а новый период «собирается сам».
 * Внутренняя проверка have.length — защита от гонки (страховка, не основной гейт).
 */
async function carryOverCategories(ws: Workspace, periodId: string, startsOn: string): Promise<void> {
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
): Promise<bigint | null> {
  if (sourceCurrency === base) return sourceMinor;
  const snap = await getRate(sourceCurrency, base, on);
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
): Promise<{ resolved: ResolvedItem[]; unresolved: UnresolvedItem[] }> {
  const base = ws.baseCurrency;
  const [debtRows, bucketRows, envelopeRows, goalRows] = await Promise.all([
    db.select().from(debts).where(and(eq(debts.workspaceId, ws.id), sql`${debts.closedAt} is null`)),
    db.select().from(currencyBuckets).where(and(eq(currencyBuckets.workspaceId, ws.id), eq(currencyBuckets.active, true))),
    db.select().from(envelopes).where(eq(envelopes.workspaceId, ws.id)),
    db.select().from(goals).where(and(eq(goals.workspaceId, ws.id), sql`${goals.achievedAt} is null`)),
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
    const baseMinor = extra?.baseOverride ?? (await toBase(sourceMinor, sourceCurrency, base, on));
    if (baseMinor === null) {
      unresolved.push({ targetKind, targetId, name, sourceCurrency, sourceMinor: sourceMinor.toString(), reason: 'rate_unavailable' });
      return;
    }
    resolved.push({ targetKind, targetId, name, sourceCurrency, sourceMinor, baseMinor, ...(extra?.toCurrency ? { toCurrency: extra.toCurrency } : {}) });
  };

  for (const d of debtRows) await push('debt', d.id, d.name, d.currency, d.paymentMinor);
  for (const b of bucketRows) await push('bucket', b.id, b.name, b.fromCurrency, b.amountMinor, { toCurrency: b.toCurrency });
  for (const e of envelopeRows) {
    if (e.ruleKind === 'percent') {
      // Процент считается от дохода — сразу в base, без FX. Тот же хелпер, что и для выплат.
      const pv = percentOfMinor(incomeMinor, e.ruleValue);
      await push('envelope', e.id, e.name, base, pv, { baseOverride: pv });
    } else {
      await push('envelope', e.id, e.name, e.currency, numericToMinor(e.ruleValue));
    }
  }
  for (const g of goalRows) await push('goal', g.id, g.name, g.currency, g.plannedPerPeriodMinor);

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
    .values({ workspaceId: ws.id, startsOn: period.startsOn, endsOn: period.endsOn, expectedIncomeMinor: incomeMinor })
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
    // Удаляем управляемые строки, чьи обязательства удалены/закрыты (категории не трогаем).
    const staleFilter =
      liveIds.length > 0
        ? and(eq(plannedItems.periodId, periodId), inArray(plannedItems.targetKind, [...MANAGED_KINDS]), notInArray(plannedItems.targetId, liveIds))
        : and(eq(plannedItems.periodId, periodId), inArray(plannedItems.targetKind, [...MANAGED_KINDS]));
    await tx.delete(plannedItems).where(staleFilter);

    if (rows.length === 0) return;
    await tx
      .insert(plannedItems)
      .values(rows.map((r) => ({ workspaceId: ws.id, periodId, targetKind: r.targetKind, targetId: r.targetId, plannedMinor: r.plannedMinor })))
      .onConflictDoUpdate({
        target: [plannedItems.periodId, plannedItems.targetKind, plannedItems.targetId],
        // planned_minor пересобирается; execution_status/executed_minor сохраняются (исполнение Спринта 3+).
        set: { plannedMinor: sql`excluded.planned_minor` },
      });
  });
}

export interface IncomeEventDto {
  sourceId: string;
  label: string;
  date: string;
  amountMinor: string;
  currency: string;
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
  const foreign = [...new Set(events.map((e) => e.currency).filter((ccy) => ccy !== ws.baseCurrency))];
  const snapshots = await Promise.all(
    foreign.map(async (ccy) => [ccy, await getRate(ccy, ws.baseCurrency, asOf)] as const),
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
  });
  return {
    incomeMinor: total.incomeMinor,
    events: events.map(toDto),
    unresolved: total.unresolved.map((e) => ({ ...toDto(e), reason: 'rate_unavailable' as const })),
  };
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
  if (targetKind === 'category') return { executionStatus: 'n_a', executedMinor: '0', remainderMinor: '0' };
  const executedMinor = saved?.executedMinor ?? 0n;
  const derived = executionOf(allocatedMinor, executedMinor);
  const status = saved?.status === 'skipped' ? 'skipped' : derived.status;
  return {
    executionStatus: status,
    executedMinor: executedMinor.toString(),
    remainderMinor: (status === 'skipped' ? 0n : derived.remainderMinor).toString(),
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
  const { resolved, unresolved } = await resolveObligations(ws, incomeMinor, asOf);
  const cats = await loadCategoryBudgets(periodId);

  // Обязательства (base уже посчитан) + категории (бюджет уже в base). Порядок каскада — в assemblePlan.
  const plan: PlanItem[] = [
    ...resolved.map((r) => ({ targetKind: r.targetKind, targetId: r.targetId, plannedMinor: r.baseMinor })),
    ...cats.map((c) => ({ targetKind: 'category' as const, targetId: c.targetId, plannedMinor: c.baseMinor, protected: c.isProtected })),
  ];
  const totalDays = daysInPeriod(period);
  const { result, summary } = assemblePlan(incomeMinor, plan, { daysInPeriod: totalDays });

  // Дескрипторы для обогащения (имя/исходная валюта). Категории — в base-валюте.
  const desc = new Map<string, { name: string; sourceCurrency: string; sourceMinor: bigint; toCurrency?: string }>();
  for (const r of resolved) desc.set(`${r.targetKind}:${r.targetId}`, { name: r.name, sourceCurrency: r.sourceCurrency, sourceMinor: r.sourceMinor, ...(r.toCurrency ? { toCurrency: r.toCurrency } : {}) });
  for (const c of cats) desc.set(`category:${c.targetId}`, { name: c.name, sourceCurrency: ws.baseCurrency, sourceMinor: c.baseMinor });

  const fact = summarizeFact(summary, { spentLivingMinor: spending.livingMinor, daysLeft: daysLeftInPeriod(period, asOf) });
  const executions = await loadExecutions(periodId);
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
      ...executionFields(a.targetKind, a.allocatedMinor, executions.get(`${a.targetKind}:${a.targetId}`)),
      ...(a.targetKind === 'category'
        ? { protectedCategory: cats.find((c) => c.targetId === a.targetId)?.isProtected === true }
        : {}),
    };
  });

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
      .map((a) => ({ targetKind: a.targetKind, targetId: a.targetId, plannedMinor: a.allocatedMinor })),
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
    freeMinor: result.freeMinor.toString(),
    toExchangeMinor: summary.toExchangeMinor.toString(),
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
      .where(and(eq(plannedItems.periodId, periodId), eq(plannedItems.targetKind, 'category'), eq(plannedItems.targetId, categoryId)));
  } else {
    await db
      .insert(plannedItems)
      .values({ workspaceId: ws.id, periodId, targetKind: 'category', targetId: categoryId, plannedMinor, executionStatus: 'n_a' })
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
  mode: 'confirm' | 'skip',
  executedOverrideMinor?: bigint,
): Promise<PlanDto> {
  if (targetKind === 'category') throw new Error('execution_not_applicable');

  const period = currentPeriod(ws, asOf);
  const sources = await activeSources(ws);
  const { incomeMinor } = await incomeForPeriod(ws, sources, period, asOf);
  const { id: periodId } = await ensurePeriodRow(ws, period, incomeMinor);

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
  const item = rows[0];
  if (!item) throw new Error('planned_item_not_found');

  const executedMinor = mode === 'skip' ? 0n : (executedOverrideMinor ?? item.plannedMinor);
  const status = mode === 'skip' ? 'skipped' : executionOf(item.plannedMinor, executedMinor).status;

  // Транзакции этой строки пересоздаём: одна строка плана — одна транзакция исполнения.
  await db.delete(transactions).where(and(eq(transactions.workspaceId, ws.id), eq(transactions.plannedItemId, item.id)));
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

/** Сколько раз из каждого источника уже брали (по принятым PlanRevision). */
async function loadRebalanceHistory(workspaceId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ moves: planRevisions.moves })
    .from(planRevisions)
    .where(and(eq(planRevisions.workspaceId, workspaceId), eq(planRevisions.accepted, true)))
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
    .where(and(eq(plannedItems.periodId, periodId), inArray(plannedItems.targetId, [input.fromId, input.toId])));
  const from = rows.find((r) => r.targetId === input.fromId);
  const to = rows.find((r) => r.targetId === input.toId);
  if (!from || !to) throw new Error('planned_item_not_found');
  // Тип источника берём из БД, а не из запроса: клиент мог назвать долг «категорией»
  // и обойти защиту (железное правило 7 — данные от клиента не авторитетны).
  if (from.targetKind === 'debt' || from.targetKind === 'bucket') throw new Error('source_protected');
  if (from.targetKind === 'category') {
    const owned = await db
      .select({ isProtected: categories.protected })
      .from(categories)
      .where(and(eq(categories.id, from.targetId), eq(categories.workspaceId, ws.id)))
      .limit(1);
    if (owned[0]?.isProtected) throw new Error('source_protected');
  }
  if (from.plannedMinor < input.amountMinor) throw new Error('insufficient_source');

  await db
    .update(plannedItems)
    .set({ plannedMinor: from.plannedMinor - input.amountMinor })
    .where(eq(plannedItems.id, from.id));
  await db
    .update(plannedItems)
    .set({ plannedMinor: to.plannedMinor + input.amountMinor })
    .where(eq(plannedItems.id, to.id));

  await db.insert(planRevisions).values({
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

  return getCurrentPlan(ws, asOf);
}
