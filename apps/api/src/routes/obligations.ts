import { and, eq } from 'drizzle-orm';
import { isUuid } from '../http/ids.ts';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { currencyBuckets, debts, envelopes, goals } from '../db/schema/domain.ts';
import { requireSection, requireWorkspace, type AppVariables } from '../middleware.ts';
import {
  bucketCreateSchema,
  bucketPatchSchema,
  debtCreateSchema,
  debtPatchSchema,
  envelopeCreateSchema,
  envelopePatchSchema,
  goalCreateSchema,
  goalPatchSchema,
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
  { path: 'debts', table: debts, schema: debtCreateSchema, patch: debtPatchSchema },
  { path: 'envelopes', table: envelopes, schema: envelopeCreateSchema, patch: envelopePatchSchema },
  { path: 'goals', table: goals, schema: goalCreateSchema, patch: goalPatchSchema },
  { path: 'buckets', table: currencyBuckets, schema: bucketCreateSchema, patch: bucketPatchSchema },
] as const;

for (const { path, table, schema, patch } of ENTITIES) {
  // Список раздела закрыт для участника, если владелец сузил видимость (issue #46).
  obligations.get(`/${path}`, requireSection(path), async (c) => {
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

  /*
   * Сторож раздела стоит и на правке с удалением, хотя сегодня он там не срабатывает: участнику
   * любой не-GET отбивает `requireWorkspace` раньше (403 read_only_member), а владельцу
   * `requireSection` всегда пропускает. Это защита на будущее — issue #83 как раз про правки от
   * участника, и в тот день пропуск сторожа превратился бы в настоящую дыру, которую никто бы не
   * искал в этом файле (найдено фоновым ревью 06.08.2026).
   *
   * Правка строки (issue #91). Раньше её не было вовсе: опечатку в названии долга или неверную
   * сумму конверта можно было исправить только удалением и повторным заведением — а вместе с
   * долгом уходила история платежей и прогноз закрытия. У категорий, счетов, регулярных платежей и
   * источников дохода PATCH при этом был, то есть продукт вёл себя по-разному с однородными
   * сущностями.
   */
  obligations.patch(`/${path}/:id`, requireSection(path), async (c) => {
    const ws = c.get('workspace')!;
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const body = patch.parse(await c.req.json());
    // Каст по той же причине, что в insert: цикл идёт по разнотипным таблицам.
    const updated = await (db.update(table) as ReturnType<typeof db.update>)
      .set(body as never)
      .where(and(eq(table.id, id), eq(table.workspaceId, ws.id)))
      .returning();
    // Чужой или несуществующий id — 404, как и у удаления: «успешно» без изменения обманывает.
    if (updated.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json(serialize(updated[0]!));
  });

  obligations.delete(`/${path}/:id`, requireSection(path), async (c) => {
    const ws = c.get('workspace')!;
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    /*
     * 204 только если строка действительно удалена. Раньше ручка отвечала «успешно» и на чужой, и
     * на несуществующий id: клиент считал, что обязательство исчезло, а оно оставалось на месте
     * (найдено адверсарным аудитом; собственный тест изоляции требует ровно 404).
     */
    const deleted = await db
      .delete(table)
      .where(and(eq(table.id, id), eq(table.workspaceId, ws.id)))
      .returning({ id: table.id });
    if (deleted.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.body(null, 204);
  });
}
