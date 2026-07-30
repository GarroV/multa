import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { recurringItems } from '../db/schema/domain.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import { recurringCreateSchema, recurringPatchSchema } from '../validation.ts';

/**
 * Регулярные платежи вне обязательств (#21): подписки, уборка, страховка.
 * Доходы здесь не живут — они в `income_sources`; две правды об одном факте дали бы дрейф
 * (это же зафиксировано check-констрейнтом в схеме).
 */
export const recurringRoute = new Hono<{ Variables: AppVariables }>();
recurringRoute.use('*', requireWorkspace);

function serialize(row: typeof recurringItems.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    schedule: row.schedule,
    active: row.active,
    targetId: row.targetId,
  };
}

recurringRoute.get('/recurring-items', async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select()
    .from(recurringItems)
    .where(eq(recurringItems.workspaceId, ws.id))
    .orderBy(asc(recurringItems.name));
  return c.json(rows.map(serialize));
});

recurringRoute.post('/recurring-items', async (c) => {
  const ws = c.get('workspace')!;
  const body = recurringCreateSchema.parse(await c.req.json());
  const inserted = await db
    .insert(recurringItems)
    .values({
      workspaceId: ws.id,
      kind: body.kind,
      name: body.name,
      amountMinor: body.amountMinor,
      currency: body.currency,
      schedule: body.schedule,
      ...(body.targetId ? { targetId: body.targetId } : {}),
    })
    .returning();
  return c.json(serialize(inserted[0]!), 201);
});

recurringRoute.patch('/recurring-items/:id', async (c) => {
  const ws = c.get('workspace')!;
  const body = recurringPatchSchema.parse(await c.req.json());
  const updated = await db
    .update(recurringItems)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor } : {}),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    })
    .where(and(eq(recurringItems.id, c.req.param('id')), eq(recurringItems.workspaceId, ws.id)))
    .returning();
  if (!updated[0]) return c.json({ error: 'not_found' }, 404);
  return c.json(serialize(updated[0]));
});

recurringRoute.delete('/recurring-items/:id', async (c) => {
  const ws = c.get('workspace')!;
  const deleted = await db
    .delete(recurringItems)
    .where(and(eq(recurringItems.id, c.req.param('id')), eq(recurringItems.workspaceId, ws.id)))
    .returning({ id: recurringItems.id });
  if (!deleted[0]) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
