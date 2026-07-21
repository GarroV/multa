/**
 * Сборка плана периода на стороне API (БД + FX). Доменная математика — в @multa/core.
 *
 * Поток: гарантировать периоды (текущий + следующий) → собрать обязательства →
 * привести к base-валюте по курсу на дату старта периода → каскад (assemblePlan) →
 * записать planned_items (идемпотентно, с сохранением исполнения) → отдать DTO.
 *
 * DoD Спринта 2: «план на два периода вперёд собирается сам» — поэтому planned_items
 * пишутся для текущего И следующего периодов. Строки категорий этот модуль не трогает
 * (их план задаёт пользователь; исполнения они не требуют — 01-domain-model §Исполнение).
 */

import {
  assemblePlan,
  convert,
  daysInPeriod,
  daysLeftInPeriod,
  generatePeriods,
  money,
  type PayPeriod,
  type PeriodConfig,
  type PlanItem,
  type TargetKind,
} from '@multa/core';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { currencyBuckets, debts, envelopes, goals, payPeriods, plannedItems } from '../db/schema/domain.ts';
import type { Workspace } from '../middleware.ts';
import { getRate } from '../fx/service.ts';

/** targetKind, которыми управляет автосборка (категории — нет). */
const MANAGED_KINDS = ['debt', 'bucket', 'envelope', 'goal'] as const;

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

/** % от суммы: income * pct / 100 в BigInt (floor; планирование, не платёж). */
function pctOfMinor(incomeMinor: bigint, pct: string): bigint {
  const [intPart = '0', fracPart = ''] = pct.trim().split('.');
  const scaled = BigInt((intPart || '0') + fracPart); // "12.5" → 125
  const denom = 100n * 10n ** BigInt(fracPart.length);
  return (incomeMinor * scaled) / denom;
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
      // Процент считается от дохода — сразу в base, без FX.
      const pv = pctOfMinor(incomeMinor, e.ruleValue);
      await push('envelope', e.id, e.name, base, pv, { baseOverride: pv });
    } else {
      await push('envelope', e.id, e.name, e.currency, numericToMinor(e.ruleValue));
    }
  }
  for (const g of goalRows) await push('goal', g.id, g.name, g.currency, g.plannedPerPeriodMinor);

  return { resolved, unresolved };
}

/** Идемпотентно гарантирует строку pay_periods, возвращает её id. */
async function ensurePeriodRow(ws: Workspace, period: PayPeriod, incomeMinor: bigint): Promise<string> {
  const inserted = await db
    .insert(payPeriods)
    .values({ workspaceId: ws.id, startsOn: period.startsOn, endsOn: period.endsOn, expectedIncomeMinor: incomeMinor })
    .onConflictDoUpdate({
      target: [payPeriods.workspaceId, payPeriods.startsOn],
      // endsOn/доход могли измениться (правка якорей/дохода) — синхронизируем.
      set: { endsOn: period.endsOn, expectedIncomeMinor: incomeMinor },
    })
    .returning({ id: payPeriods.id });
  return inserted[0]!.id;
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
}

export interface PlanDto {
  period: { startsOn: string; endsOn: string };
  daysInPeriod: number;
  daysLeft: number;
  baseCurrency: string;
  incomeMinor: string;
  totalPlannedMinor: string;
  totalAllocatedMinor: string;
  compressedMinor: string;
  freeMinor: string;
  toExchangeMinor: string;
  canSpendPerDayMinor: string;
  allocations: PlanAllocationDto[];
  unresolved: UnresolvedItem[];
}

/** Собирает и сохраняет план одного периода, возвращает DTO. */
async function assembleForPeriod(ws: Workspace, period: PayPeriod, asOf: string): Promise<PlanDto> {
  const incomeMinor = ws.expectedIncomeMinor ?? 0n;
  const periodId = await ensurePeriodRow(ws, period, incomeMinor);
  // План — проекция «на момент сборки»: конвертируем по курсу на asOf (сегодня), а не на
  // дату старта периода. Иммутабельный снапшот курса важен для транзакций-фактов, не для плана.
  const { resolved, unresolved } = await resolveObligations(ws, incomeMinor, asOf);

  const plan: PlanItem[] = resolved.map((r) => ({ targetKind: r.targetKind, targetId: r.targetId, plannedMinor: r.baseMinor }));
  const totalDays = daysInPeriod(period);
  const { result, summary } = assemblePlan(incomeMinor, plan, { daysInPeriod: totalDays });

  const byId = new Map(resolved.map((r) => [`${r.targetKind}:${r.targetId}`, r]));
  const allocations: PlanAllocationDto[] = result.allocations.map((a) => {
    const src = byId.get(`${a.targetKind}:${a.targetId}`)!;
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
    };
  });

  await persistPlannedItems(
    ws,
    periodId,
    result.allocations.map((a) => ({ targetKind: a.targetKind, targetId: a.targetId, plannedMinor: a.allocatedMinor })),
  );

  return {
    period: { startsOn: period.startsOn, endsOn: period.endsOn },
    daysInPeriod: totalDays,
    daysLeft: daysLeftInPeriod(period, asOf),
    baseCurrency: ws.baseCurrency,
    incomeMinor: incomeMinor.toString(),
    totalPlannedMinor: result.totalPlannedMinor.toString(),
    totalAllocatedMinor: result.totalAllocatedMinor.toString(),
    compressedMinor: result.compressedMinor.toString(),
    freeMinor: result.freeMinor.toString(),
    toExchangeMinor: summary.toExchangeMinor.toString(),
    canSpendPerDayMinor: summary.canSpendPerDayMinor.toString(),
    allocations,
    unresolved,
  };
}

/**
 * План текущего периода: гарантирует и собирает текущий + следующий периоды,
 * возвращает DTO текущего. Бросает, если онбординг не завершён (нет якорей).
 */
export async function getCurrentPlan(ws: Workspace, asOf: string): Promise<PlanDto> {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const anchors = ws.periodAnchors as PeriodConfig;
  const [current, next] = generatePeriods(anchors, asOf, 2);
  if (!current) throw new Error('period_undeterminable');
  const dto = await assembleForPeriod(ws, current, asOf);
  // Следующий период тоже собираем «вперёд» (DoD), но в ответ не кладём.
  if (next) await assembleForPeriod(ws, next, asOf);
  return dto;
}
