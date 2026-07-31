import { resolveRate, type RateSnapshot } from '@multa/core';
import { and, desc, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { fxRates } from '../db/schema/domain.ts';
import { logger } from '../logger.ts';
import { fetchCbr, fetchFrankfurter } from './sources.ts';

const LOOKBACK_DAYS = 14;

function addDaysISO(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Тянет ЦБ + Frankfurter, upsert в fx_rates. Возвращает число записанных котировок. */
export async function refreshRates(): Promise<number> {
  const quotes: RateSnapshot[] = [];
  for (const fetcher of [fetchCbr, fetchFrankfurter]) {
    try {
      quotes.push(...(await fetcher()));
    } catch (err) {
      logger.error('fx source failed', err);
    }
  }
  if (quotes.length === 0) return 0;
  await db
    .insert(fxRates)
    .values(
      quotes.map((q) => ({
        source: q.source,
        base: q.from,
        quote: q.to,
        onDate: q.date,
        rate: q.rate,
      })),
    )
    .onConflictDoUpdate({
      target: [fxRates.source, fxRates.base, fxRates.quote, fxRates.onDate],
      set: { rate: sql`excluded.rate` },
    });
  return quotes.length;
}

/** Курс пары на дату через кэш fx_rates + резолвер ядра (прямая/обратная/кросс/выходные). */
export async function getRate(from: string, to: string, on: string): Promise<RateSnapshot | null> {
  const minDate = addDaysISO(on, -LOOKBACK_DAYS);
  const rows = await db
    .select()
    .from(fxRates)
    .where(and(lte(fxRates.onDate, on), gte(fxRates.onDate, minDate)));
  const quotes: RateSnapshot[] = rows.map((r) => ({
    from: r.base,
    to: r.quote,
    rate: r.rate,
    source: r.source,
    date: r.onDate,
  }));
  return resolveRate(quotes, from.toUpperCase(), to.toUpperCase(), on, {
    maxLookbackDays: LOOKBACK_DAYS,
  });
}

/** Возраст самых свежих курсов в часах (для healthcheck; null если пусто). */
export async function fxFreshnessHours(): Promise<number | null> {
  const rows = await db
    .select({ d: fxRates.onDate })
    .from(fxRates)
    .orderBy(desc(fxRates.onDate))
    .limit(1);
  const latest = rows[0]?.d;
  if (!latest) return null;
  return Math.round((Date.now() - new Date(`${latest}T00:00:00Z`).getTime()) / 3_600_000);
}

export async function fxIsEmpty(): Promise<boolean> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(fxRates);
  return (rows[0]?.n ?? 0) === 0;
}
