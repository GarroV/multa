/**
 * Доступ к income_sources. Границы: bigint ↔ строка (jsonb не умеет bigint),
 * строка БД разбирается той же zod-схемой, что и HTTP-тело — одна правда о форме данных.
 */

import type { IncomeSource } from '@multa/core';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../db/client.ts';
import { incomeSources, workspaces } from '../db/schema/domain.ts';
import {
  incomeSourcePatchSchema,
  incomeSourceRowSchema,
  incomeSourceSchema,
  onboardingIncomeSchema,
} from '../validation.ts';

type SourceRow = typeof incomeSources.$inferSelect;
type SourceInput = z.infer<typeof incomeSourceSchema>;
type SourcePatch = z.infer<typeof incomeSourcePatchSchema>;
type OnboardingIncome = z.infer<typeof onboardingIncomeSchema>;

/** Суммы в jsonb — строки-целые: JSON.stringify падает на bigint. */
function amountToJson(amount: SourceInput['amount']): Record<string, unknown> {
  return amount.kind === 'absolute'
    ? { kind: 'absolute', amountMinor: amount.amountMinor.toString() }
    : { kind: 'percent', percent: amount.percent, ofMinor: amount.ofMinor.toString() };
}

/** Строка БД → домен (@multa/core). Валидируем на выходе из БД: jsonb не типизирован. */
function rowToSource(row: SourceRow): IncomeSource {
  return incomeSourceRowSchema.parse({
    id: row.id,
    label: row.label,
    currency: row.currency,
    schedule: row.schedule,
    amount: row.amount,
    stability: row.stability,
    active: row.active,
    ...(row.startsOn ? { startsOn: row.startsOn } : {}),
    ...(row.endsOn ? { endsOn: row.endsOn } : {}),
    sort: row.sort,
  });
}

/** Строка БД → JSON для клиента (суммы уже строками внутри jsonb). */
export function serializeSource(row: SourceRow): Record<string, unknown> {
  return {
    id: row.id,
    label: row.label,
    currency: row.currency,
    schedule: row.schedule,
    amount: row.amount,
    stability: row.stability,
    active: row.active,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    sort: row.sort,
  };
}

function toValues(workspaceId: string, input: SourceInput) {
  return {
    workspaceId,
    label: input.label,
    currency: input.currency,
    schedule: input.schedule,
    amount: amountToJson(input.amount),
    stability: input.stability,
    active: input.active,
    startsOn: input.startsOn ?? null,
    endsOn: input.endsOn ?? null,
    sort: input.sort ?? 0,
  };
}

export async function listSourceRows(workspaceId: string): Promise<SourceRow[]> {
  return db
    .select()
    .from(incomeSources)
    .where(eq(incomeSources.workspaceId, workspaceId))
    .orderBy(incomeSources.sort);
}

/** Источники воркспейса в доменном виде — для сборки плана. */
export async function listSources(workspaceId: string): Promise<IncomeSource[]> {
  return (await listSourceRows(workspaceId)).map(rowToSource);
}

export async function hasActiveIncome(workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: incomeSources.id })
    .from(incomeSources)
    .where(and(eq(incomeSources.workspaceId, workspaceId), eq(incomeSources.active, true)))
    .limit(1);
  return rows.length > 0;
}

export async function insertSource(workspaceId: string, input: SourceInput): Promise<SourceRow> {
  const inserted = await db.insert(incomeSources).values(toValues(workspaceId, input)).returning();
  return inserted[0]!;
}

/** Правка с проверкой принадлежности воркспейсу (изоляция, правило 7). null → не найдено. */
export async function patchSourceById(
  workspaceId: string,
  id: string,
  patch: SourcePatch,
): Promise<SourceRow | null> {
  const updated = await db
    .update(incomeSources)
    .set({
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.amount !== undefined ? { amount: amountToJson(patch.amount) } : {}),
      ...(patch.stability !== undefined ? { stability: patch.stability } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.startsOn !== undefined ? { startsOn: patch.startsOn } : {}),
      ...(patch.endsOn !== undefined ? { endsOn: patch.endsOn } : {}),
      ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
    })
    .where(and(eq(incomeSources.id, id), eq(incomeSources.workspaceId, workspaceId)))
    .returning();
  return updated[0] ?? null;
}

export async function deleteSourceById(workspaceId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(incomeSources)
    .where(and(eq(incomeSources.id, id), eq(incomeSources.workspaceId, workspaceId)))
    .returning({ id: incomeSources.id });
  return deleted.length > 0;
}

/**
 * Онбординг: ритм + правило выходных + набор источников одной транзакцией.
 * Полусостояния быть не должно: либо шаг пройден целиком, либо ничего не изменилось.
 * Правило выходных пишется и внутрь ритма (его читает generatePeriods), и в колонку
 * воркспейса (её читают настройки и сборка событий) — единственный писатель обоих здесь.
 */
export async function replaceOnboardingIncome(
  workspaceId: string,
  body: OnboardingIncome,
): Promise<SourceRow[]> {
  return db.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({
        periodAnchors: { ...body.rhythm, weekendRule: body.weekendRule },
        paydayWeekendRule: body.weekendRule,
      })
      .where(eq(workspaces.id, workspaceId));
    await tx.delete(incomeSources).where(eq(incomeSources.workspaceId, workspaceId));
    return tx
      .insert(incomeSources)
      .values(body.sources.map((s, i) => ({ ...toValues(workspaceId, s), sort: s.sort ?? i })))
      .returning();
  });
}
