import { convert, money, periodForDate, type PeriodConfig } from '@multa/core';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import { categories, transactions } from '../db/schema/domain.ts';
import { getRate } from '../fx/service.ts';
import { requireWorkspace, type AppVariables, type Workspace } from '../middleware.ts';
import { ensurePeriodForDate } from '../plan/assemble.ts';
import { transactionCreateSchema, transactionListSchema } from '../validation.ts';

/**
 * Факт трат (Спринт 3). Транзакция хранит триаду: сумма в своей валюте + `base_amount_minor`
 * + иммутабельный снапшот курса на дату траты (железное правило 2 — история не пересчитывается).
 *
 * Период вычисляется на сервере по `occurred_on`: клиент period_id не передаёт, поэтому
 * задним числом внесённая трата попадает в свой период, а не в текущий.
 */
export const transactionsRoute = new Hono<{ Variables: AppVariables }>();
transactionsRoute.use('*', requireWorkspace);

interface TransactionDto {
  id: string;
  kind: string;
  categoryId: string | null;
  amountMinor: string;
  currency: string;
  baseAmountMinor: string;
  rate: string;
  rateSource: string;
  rateDate: string;
  occurredOn: string;
  source: string;
  note: string | null;
}

/** bigint в JSON не сериализуется — суммы отдаём строками (как в PlanDto). */
function serialize(row: typeof transactions.$inferSelect): TransactionDto {
  return {
    id: row.id,
    kind: row.kind,
    categoryId: row.targetKind === 'category' ? row.targetId : null,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    baseAmountMinor: row.baseAmountMinor.toString(),
    rate: row.rate,
    rateSource: row.rateSource,
    rateDate: row.rateDate,
    occurredOn: row.occurredOn,
    source: row.source,
    note: row.note,
  };
}

/** Границы периода, в который попадает дата. Бросает `onboarding_incomplete` без якорей. */
function periodRange(ws: Workspace, on: string): { from: string; to: string } {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const period = periodForDate(ws.periodAnchors as PeriodConfig, on);
  return { from: period.startsOn, to: period.endsOn };
}

transactionsRoute.get('/transactions', async (c) => {
  const ws = c.get('workspace')!;
  const q = transactionListSchema.parse(c.req.query());
  const range = q.from && q.to ? { from: q.from, to: q.to } : periodRange(ws, today(ws.timezone));
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.workspaceId, ws.id),
        gte(transactions.occurredOn, range.from),
        lt(transactions.occurredOn, range.to),
      ),
    )
    .orderBy(desc(transactions.occurredOn), desc(transactions.id));
  return c.json({ period: range, transactions: rows.map(serialize) });
});

transactionsRoute.post('/transactions', async (c) => {
  const ws = c.get('workspace')!;
  const body = transactionCreateSchema.parse(await c.req.json());
  const occurredOn = body.occurredOn ?? today(ws.timezone);

  // Категория — только своя и живая (правило 7: скоуп из токена, id от клиента не доверяем).
  if (body.categoryId) {
    const owned = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, body.categoryId),
          eq(categories.workspaceId, ws.id),
          eq(categories.archived, false),
        ),
      );
    if (!owned[0]) return c.json({ error: 'category_not_found' }, 404);
  }

  // Снапшот курса на дату траты. Своя валюта → 1:1 (источник 'base', курс не нужен).
  const needsRate = body.currency !== ws.baseCurrency;
  const snap = needsRate ? await getRate(body.currency, ws.baseCurrency, occurredOn) : null;
  if (needsRate && !snap) return c.json({ error: 'rate_unavailable' }, 404);
  const baseAmountMinor = snap ? convert(money(body.amountMinor, body.currency), snap).minor : body.amountMinor;

  const { periodId } = await ensurePeriodForDate(ws, occurredOn);

  const inserted = await db
    .insert(transactions)
    .values({
      workspaceId: ws.id,
      periodId,
      kind: body.kind,
      ...(body.categoryId ? { targetKind: 'category', targetId: body.categoryId } : {}),
      amountMinor: body.amountMinor,
      currency: body.currency,
      baseAmountMinor,
      rate: snap ? snap.rate : '1',
      rateSource: snap ? snap.source : 'base',
      rateDate: snap ? snap.date : occurredOn,
      occurredOn,
      source: body.source ?? 'manual',
      ...(body.note ? { note: body.note } : {}),
      ...(body.rawInput ? { rawInput: body.rawInput } : {}),
    })
    .returning();
  return c.json(serialize(inserted[0]!), 201);
});

transactionsRoute.delete('/transactions/:id', async (c) => {
  const ws = c.get('workspace')!;
  const deleted = await db
    .delete(transactions)
    .where(and(eq(transactions.id, c.req.param('id')), eq(transactions.workspaceId, ws.id)))
    .returning({ id: transactions.id });
  if (!deleted[0]) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
