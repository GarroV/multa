import { exchangeResult } from '@multa/core';
import { isUuid } from '../http/ids.ts';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import { currencyBuckets, exchangeOps } from '../db/schema/domain.ts';
import { getRate } from '../fx/service.ts';
import { settingsOf } from '../settings/store.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import { exchangeCreateSchema } from '../validation.ts';

/**
 * Размен валюты (Спринт 3). Пользователь вводит обе стороны сделки — сколько отдал и сколько
 * получил; фактический курс и спред считает ядро, официальный курс на дату кладём снапшотом
 * рядом (правило 2: история не пересчитывается, даже если котировку потом уточнят).
 */
export const exchangeRoute = new Hono<{ Variables: AppVariables }>();
exchangeRoute.use('*', requireWorkspace);

function serialize(row: typeof exchangeOps.$inferSelect) {
  return {
    id: row.id,
    fromCurrency: row.fromCurrency,
    toCurrency: row.toCurrency,
    fromMinor: row.fromMinor.toString(),
    toMinor: row.toMinor.toString(),
    actualRate: row.actualRate,
    officialRate: row.officialRate,
    officialSource: row.officialSource,
    spreadPct: row.spreadPct,
    spreadMinor: row.spreadMinor != null ? row.spreadMinor.toString() : null,
    occurredOn: row.occurredOn,
    provider: row.provider,
    note: row.note,
  };
}

exchangeRoute.get('/exchange-ops', async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select()
    .from(exchangeOps)
    .where(eq(exchangeOps.workspaceId, ws.id))
    .orderBy(desc(exchangeOps.occurredOn), desc(exchangeOps.id))
    .limit(100);
  const ops = rows.map(serialize);
  // Копилка потерь: суммируем спред только там, где официальный курс был известен.
  const lossByCurrency = new Map<string, bigint>();
  for (const row of rows) {
    if (row.spreadMinor == null) continue;
    lossByCurrency.set(
      row.toCurrency,
      (lossByCurrency.get(row.toCurrency) ?? 0n) + row.spreadMinor,
    );
  }
  return c.json({
    ops,
    totalLost: [...lossByCurrency].map(([currency, minor]) => ({
      currency,
      minor: minor.toString(),
    })),
  });
});

exchangeRoute.post('/exchange-ops', async (c) => {
  const ws = c.get('workspace')!;
  const body = exchangeCreateSchema.parse(await c.req.json());
  if (body.fromCurrency === body.toCurrency) return c.json({ error: 'same_currency' }, 400);
  const occurredOn = body.occurredOn ?? today(ws.timezone);

  /*
   * Корзину клиент присылает по id, поэтому её принадлежность проверяем сами (правило 7): чужой id
   * иначе оказывался бы в ссылке нашей операции и — из-за FK — навсегда блокировал владельцу
   * удаление его же корзины (найдено адверсарным аудитом).
   */
  let bucketId: string | undefined;
  if (body.bucketId) {
    if (!isUuid(body.bucketId)) return c.json({ error: 'bucket_not_found' }, 404);
    const owned = await db
      .select({ id: currencyBuckets.id })
      .from(currencyBuckets)
      .where(and(eq(currencyBuckets.workspaceId, ws.id), eq(currencyBuckets.id, body.bucketId)))
      .limit(1);
    if (!owned[0]) return c.json({ error: 'bucket_not_found' }, 404);
    bucketId = owned[0].id;
  }

  const settings = settingsOf(ws);
  // Провайдер: из запроса, иначе привычный из настроек — его набирают каждый раз одинаково.
  const provider = body.provider?.trim() || settings.currency.defaultProvider || null;

  /*
   * Здесь курс намеренно публичный, без личных курсов воркспейса: спред считается как отклонение
   * от рыночной котировки. Сравнивать свой курс со своим же — значит всегда получать нулевой спред.
   */
  const official = await getRate(body.fromCurrency, body.toCurrency, occurredOn);
  const result = exchangeResult({
    fromMinor: body.fromMinor,
    fromCurrency: body.fromCurrency,
    toMinor: body.toMinor,
    toCurrency: body.toCurrency,
    official,
  });
  if (result.effectiveRate === null) return c.json({ error: 'invalid_amounts' }, 400);

  const inserted = await db
    .insert(exchangeOps)
    .values({
      workspaceId: ws.id,
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      fromMinor: body.fromMinor,
      toMinor: body.toMinor,
      actualRate: result.effectiveRate,
      ...(official ? { officialRate: official.rate, officialSource: official.source } : {}),
      ...(result.spreadPct !== null ? { spreadPct: result.spreadPct } : {}),
      ...(result.lostMinor !== null ? { spreadMinor: result.lostMinor } : {}),
      occurredOn,
      // Провайдер: из запроса, иначе — привычный из настроек (issue #49). Пустая метка означает,
      // что человек не сказал, где менял: такие сделки видны, но в советах не участвуют.
      ...(provider ? { provider } : {}),
      ...(body.note ? { note: body.note } : {}),
      ...(bucketId ? { bucketId } : {}),
    })
    .returning();
  return c.json(serialize(inserted[0]!), 201);
});

exchangeRoute.delete('/exchange-ops/:id', async (c) => {
  const ws = c.get('workspace')!;
  if (!isUuid(c.req.param('id'))) return c.json({ error: 'not_found' }, 404);
  const deleted = await db
    .delete(exchangeOps)
    .where(and(eq(exchangeOps.id, c.req.param('id')), eq(exchangeOps.workspaceId, ws.id)))
    .returning({ id: exchangeOps.id });
  if (!deleted[0]) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
