import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { currencyBuckets, debts, envelopes, goals } from '../db/schema/domain.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import {
  bucketCreateSchema,
  debtCreateSchema,
  envelopeCreateSchema,
  goalCreateSchema,
} from '../validation.ts';

/** bigint → строка для JSON. */
function serialize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? v.toString() : v;
  return out;
}

export const obligations = new Hono<{ Variables: AppVariables }>();
obligations.use('*', requireWorkspace);

const ENTITIES = [
  { path: 'debts', table: debts, schema: debtCreateSchema },
  { path: 'envelopes', table: envelopes, schema: envelopeCreateSchema },
  { path: 'goals', table: goals, schema: goalCreateSchema },
  { path: 'buckets', table: currencyBuckets, schema: bucketCreateSchema },
] as const;

for (const { path, table, schema } of ENTITIES) {
  obligations.get(`/${path}`, async (c) => {
    const ws = c.get('workspace')!;
    const rows = await db.select().from(table).where(eq(table.workspaceId, ws.id));
    return c.json(rows.map(serialize));
  });

  obligations.post(`/${path}`, async (c) => {
    const ws = c.get('workspace')!;
    const body = schema.parse(await c.req.json());
    // Каст: цикл по разнотипным таблицам — общий insert теряет специфичный тип values.
    const inserted = await (db.insert(table) as ReturnType<typeof db.insert>)
      .values({ ...body, workspaceId: ws.id } as never)
      .returning();
    return c.json(serialize(inserted[0]!), 201);
  });

  obligations.delete(`/${path}/:id`, async (c) => {
    const ws = c.get('workspace')!;
    await db
      .delete(table)
      .where(and(eq(table.id, c.req.param('id')), eq(table.workspaceId, ws.id)));
    return c.body(null, 204);
  });
}
