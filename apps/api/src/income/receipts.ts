import { convert, money, type RateSnapshot } from '@multa/core';
import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { fxManualRates, incomeReceipts, incomeSources } from '../db/schema/domain.ts';
import { getRate } from '../fx/service.ts';

/**
 * Подтверждение поступления дохода (issue #48).
 *
 * Пока выплаты нет, план считает по ожидаемой сумме источника. Подтверждение фиксирует факт: сколько
 * пришло и по какому курсу. Курс кладётся снапшотом (правило 2) и, если введён руками, попадает в
 * `fx_manual_rates` этого воркспейса — тогда весь его план периода (включая «к размену») считается
 * по курсу дня выплаты, а чужие воркспейсы продолжают видеть публичные котировки (правило 7).
 */

export interface ReceiptInput {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredOn: string;
  /** Курс валюты прихода к базовой, введённый руками. Без него берём котировку на дату. */
  readonly rate?: string;
  readonly note?: string;
}

export interface ReceiptRow {
  id: string;
  sourceId: string;
  occurredOn: string;
  amountMinor: bigint;
  currency: string;
  baseAmountMinor: bigint;
  rate: string;
  rateSource: string;
  rateDate: string;
  note: string | null;
}

export interface ReceiptDto {
  id: string;
  sourceId: string;
  occurredOn: string;
  amountMinor: string;
  currency: string;
  baseAmountMinor: string;
  rate: string;
  rateSource: string;
  rateDate: string;
  note: string | null;
}

export function serializeReceipt(row: ReceiptRow): ReceiptDto {
  return {
    ...row,
    amountMinor: row.amountMinor.toString(),
    baseAmountMinor: row.baseAmountMinor.toString(),
  };
}

/** Источник существует и принадлежит воркспейсу — иначе подтверждать нечего (правило 7). */
export async function findSource(
  workspaceId: string,
  sourceId: string,
): Promise<{ id: string; currency: string } | null> {
  const rows = await db
    .select({ id: incomeSources.id, currency: incomeSources.currency })
    .from(incomeSources)
    .where(and(eq(incomeSources.workspaceId, workspaceId), eq(incomeSources.id, sourceId)))
    .limit(1);
  return rows[0] ?? null;
}

export class ReceiptRateUnavailable extends Error {
  constructor() {
    super('rate_unavailable');
  }
}

export class ReceiptDuplicate extends Error {
  constructor() {
    super('receipt_exists');
  }
}

/**
 * Записывает подтверждение. Ручной курс сохраняется в личных курсах воркспейса на дату прихода:
 * он должен влиять на весь период, а не только на эту строку — иначе «к размену» посчитается по
 * котировке, хотя человек уже знает свой курс.
 */
export async function insertReceipt(
  workspaceId: string,
  baseCurrency: string,
  sourceId: string,
  input: ReceiptInput,
): Promise<ReceiptRow> {
  const currency = input.currency.toUpperCase();
  const snapshot = await resolveSnapshot(
    workspaceId,
    baseCurrency,
    currency,
    input.occurredOn,
    input.rate,
  );
  if (!snapshot) throw new ReceiptRateUnavailable();

  const baseAmountMinor = convert(money(input.amountMinor, currency), snapshot).minor;

  return await db.transaction(async (tx) => {
    if (input.rate) {
      /*
       * Ручной курс — факт всего периода, а не только этой строки: по нему считается и «к размену».
       * Но живёт он в личной таблице воркспейса, а не в общих котировках: `fx_rates` — публичные
       * данные, и запись туда протекала бы в планы других воркспейсов (правило 7).
       */
      await tx
        .insert(fxManualRates)
        .values({
          workspaceId,
          base: currency,
          quote: baseCurrency,
          onDate: input.occurredOn,
          rate: snapshot.rate,
        })
        .onConflictDoUpdate({
          target: [
            fxManualRates.workspaceId,
            fxManualRates.base,
            fxManualRates.quote,
            fxManualRates.onDate,
          ],
          set: { rate: snapshot.rate },
        });
    }

    const existing = await tx
      .select({ id: incomeReceipts.id })
      .from(incomeReceipts)
      .where(
        and(
          eq(incomeReceipts.workspaceId, workspaceId),
          eq(incomeReceipts.sourceId, sourceId),
          eq(incomeReceipts.occurredOn, input.occurredOn),
        ),
      )
      .limit(1);
    if (existing[0]) throw new ReceiptDuplicate();

    const rows = await tx
      .insert(incomeReceipts)
      .values({
        workspaceId,
        sourceId,
        occurredOn: input.occurredOn,
        amountMinor: input.amountMinor,
        currency,
        baseAmountMinor,
        rate: snapshot.rate,
        rateSource: snapshot.source,
        rateDate: snapshot.date,
        ...(input.note ? { note: input.note } : {}),
      })
      .returning({
        id: incomeReceipts.id,
        sourceId: incomeReceipts.sourceId,
        occurredOn: incomeReceipts.occurredOn,
        amountMinor: incomeReceipts.amountMinor,
        currency: incomeReceipts.currency,
        baseAmountMinor: incomeReceipts.baseAmountMinor,
        rate: incomeReceipts.rate,
        rateSource: incomeReceipts.rateSource,
        rateDate: incomeReceipts.rateDate,
        note: incomeReceipts.note,
      });
    const row = rows[0];
    if (!row) throw new Error('income receipt insert returned nothing');
    return row;
  });
}

/** Ручной курс важнее котировки; без него — обычный снапшот на дату (может быть недоступен). */
async function resolveSnapshot(
  workspaceId: string,
  baseCurrency: string,
  currency: string,
  on: string,
  manualRate?: string,
): Promise<RateSnapshot | null> {
  if (currency === baseCurrency) {
    return { from: currency, to: baseCurrency, rate: '1', source: 'identity', date: on };
  }
  if (manualRate) {
    return { from: currency, to: baseCurrency, rate: manualRate, source: 'manual', date: on };
  }
  return await getRate(currency, baseCurrency, on, workspaceId);
}

/**
 * Удаляет подтверждение: план возвращается к плановой сумме источника.
 *
 * Вместе с ним снимается личный курс, который это подтверждение и записало — если больше никто на
 * эту дату и пару его не подтверждал. Иначе опечатку в курсе («9.12» вместо «91.2») невозможно
 * исправить из интерфейса: подтверждение удалено, а кривой курс продолжает пересчитывать остатки
 * по счетам и новые траты (найдено адверсарным аудитом).
 */
export async function deleteReceipt(
  workspaceId: string,
  baseCurrency: string,
  id: string,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .delete(incomeReceipts)
      .where(and(eq(incomeReceipts.workspaceId, workspaceId), eq(incomeReceipts.id, id)))
      .returning({
        currency: incomeReceipts.currency,
        occurredOn: incomeReceipts.occurredOn,
        rateSource: incomeReceipts.rateSource,
      });
    const removed = rows[0];
    if (!removed) return false;
    if (removed.rateSource !== 'manual') return true;

    const others = await tx
      .select({ id: incomeReceipts.id })
      .from(incomeReceipts)
      .where(
        and(
          eq(incomeReceipts.workspaceId, workspaceId),
          eq(incomeReceipts.currency, removed.currency),
          eq(incomeReceipts.occurredOn, removed.occurredOn),
          eq(incomeReceipts.rateSource, 'manual'),
        ),
      )
      .limit(1);
    if (others.length > 0) return true;

    await tx
      .delete(fxManualRates)
      .where(
        and(
          eq(fxManualRates.workspaceId, workspaceId),
          eq(fxManualRates.base, removed.currency),
          eq(fxManualRates.quote, baseCurrency),
          eq(fxManualRates.onDate, removed.occurredOn),
        ),
      );
    return true;
  });
}

/**
 * Подтверждения периода. Полуинтервал [startsOn, endsOn) — как у событий дохода и у факта трат,
 * иначе день выплаты попал бы в два периода.
 */
export async function receiptsForPeriod(
  workspaceId: string,
  startsOn: string,
  endsOn: string,
): Promise<ReceiptRow[]> {
  return await db
    .select({
      id: incomeReceipts.id,
      sourceId: incomeReceipts.sourceId,
      occurredOn: incomeReceipts.occurredOn,
      amountMinor: incomeReceipts.amountMinor,
      currency: incomeReceipts.currency,
      baseAmountMinor: incomeReceipts.baseAmountMinor,
      rate: incomeReceipts.rate,
      rateSource: incomeReceipts.rateSource,
      rateDate: incomeReceipts.rateDate,
      note: incomeReceipts.note,
    })
    .from(incomeReceipts)
    .where(
      and(
        eq(incomeReceipts.workspaceId, workspaceId),
        gte(incomeReceipts.occurredOn, startsOn),
        lt(incomeReceipts.occurredOn, endsOn),
      ),
    );
}
