import { convert, money } from '@multa/core';
import { isUuid } from '../http/ids.ts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import { accounts } from '../db/schema/domain.ts';
import { getRate } from '../fx/service.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import { accountPatchSchema, accountSchema } from '../validation.ts';

/**
 * Счета и мультивалютные остатки (issue #45). Отвечают на вопрос «сколько всего денег есть» —
 * тот, с которого начинается план: остаток по счетам стоит первым блоком.
 *
 * Два правила, которые здесь важнее удобства:
 * 1. Счёт архивируется, а не удаляется, пока к нему привязаны транзакции: терять историю трат
 *    из-за закрытой карты нельзя.
 * 2. Если курс какой-то валюты недоступен, общая сумма не показывается вовсе. Сумма без части
 *    денег выглядит как правда и врёт — лучше честно назвать валюту, по которой курса нет.
 */
export const accountsRoute = new Hono<{ Variables: AppVariables }>();
accountsRoute.use('*', requireWorkspace);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AccountRow {
  id: string;
  name: string;
  currency: string;
  kind: string;
  balanceMinor: bigint;
  archived: boolean;
}

function serialize(row: AccountRow) {
  return { ...row, balanceMinor: row.balanceMinor.toString() };
}

const columns = {
  id: accounts.id,
  name: accounts.name,
  currency: accounts.currency,
  kind: accounts.kind,
  balanceMinor: accounts.balanceMinor,
  archived: accounts.archived,
};

accountsRoute.get('/accounts', async (c) => {
  const ws = c.get('workspace')!;
  // Архивные по умолчанию скрыты: их держат ради истории, а не ради ежедневной работы.
  const includeArchived = c.req.query('includeArchived') === '1';
  const rows = await db
    .select(columns)
    .from(accounts)
    .where(
      includeArchived
        ? eq(accounts.workspaceId, ws.id)
        : and(eq(accounts.workspaceId, ws.id), eq(accounts.archived, false)),
    )
    .orderBy(asc(accounts.name));
  return c.json(rows.map(serialize));
});

/**
 * Остаток: суммы по валютам и общий итог в базовой валюте по курсу на сегодня. Курс — снапшот
 * запроса; история остатков не ведётся, поэтому пересчитывать назад нечего (правило 2 не нарушается).
 */
accountsRoute.get('/accounts/balances', async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select({ currency: accounts.currency, minor: sql<string>`sum(${accounts.balanceMinor})` })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, ws.id), eq(accounts.archived, false)))
    .groupBy(accounts.currency);

  const on = today(ws.timezone);
  const byCurrency: { currency: string; minor: string; baseMinor: string | null }[] = [];
  const unresolved: string[] = [];
  let totalMinor: bigint | null = 0n;

  for (const row of rows) {
    const minor = BigInt(row.minor ?? '0');
    if (row.currency === ws.baseCurrency) {
      byCurrency.push({
        currency: row.currency,
        minor: minor.toString(),
        baseMinor: minor.toString(),
      });
      if (totalMinor !== null) totalMinor += minor;
      continue;
    }
    const snap = await getRate(row.currency, ws.baseCurrency, on, ws.id);
    if (!snap) {
      unresolved.push(row.currency);
      byCurrency.push({ currency: row.currency, minor: minor.toString(), baseMinor: null });
      // Итог обнуляется в null: сумма без части денег читается как полная и обманывает.
      totalMinor = null;
      continue;
    }
    const baseMinor = convert(money(minor, row.currency), snap).minor;
    byCurrency.push({
      currency: row.currency,
      minor: minor.toString(),
      baseMinor: baseMinor.toString(),
    });
    if (totalMinor !== null) totalMinor += baseMinor;
  }

  return c.json({
    baseCurrency: ws.baseCurrency,
    totalMinor: totalMinor === null ? null : totalMinor.toString(),
    byCurrency,
    unresolved,
  });
});

accountsRoute.post('/accounts', async (c) => {
  const ws = c.get('workspace')!;
  const body = accountSchema.parse(await c.req.json());
  const rows = await db
    .insert(accounts)
    .values({
      workspaceId: ws.id,
      name: body.name,
      currency: body.currency,
      kind: body.kind,
      balanceMinor: BigInt(body.balanceMinor ?? '0'),
    })
    .returning(columns);
  return c.json(serialize(rows[0]!), 201);
});

accountsRoute.patch('/accounts/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
  const patch = accountPatchSchema.parse(await c.req.json());

  const rows = await db
    .update(accounts)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.balanceMinor !== undefined ? { balanceMinor: BigInt(patch.balanceMinor) } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    })
    .where(and(eq(accounts.workspaceId, ws.id), eq(accounts.id, id)))
    .returning(columns);
  const row = rows[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(serialize(row));
});

/**
 * Удаление — только для счёта без истории. Если к нему привязаны транзакции, отдаём 409 и просим
 * архивировать: молча оборвать ссылки значило бы потерять факт трат.
 */
accountsRoute.delete('/accounts/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);

  const used = await db.execute(
    sql`select 1 from transactions where workspace_id = ${ws.id} and account_id = ${id} limit 1`,
  );
  if (used.rows.length > 0) return c.json({ error: 'account_in_use' }, 409);

  const rows = await db
    .delete(accounts)
    .where(and(eq(accounts.workspaceId, ws.id), eq(accounts.id, id)))
    .returning({ id: accounts.id });
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
