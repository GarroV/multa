import { and, asc, eq } from 'drizzle-orm';
import { isUuid } from '../http/ids.ts';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { categories } from '../db/schema/domain.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import { categoryCreateSchema, categoryPatchSchema } from '../validation.ts';

/**
 * CRUD категорий (Спринт 2). Категории — язык пользователя (01-domain-model);
 * бюджет на период задаётся отдельно (planned_items, см. plan/assemble.ts).
 * Удаление — архивация (инвариант 6: транзакции не теряются). Системную «Общее» не трогаем.
 */
/**
 * Пресет-категории при создании workspace (04-web-ux: «первый план из пресет-категорий»).
 * Имена — язык пользователя, поэтому по локали. «Общее» — системная (fallback, не удаляется).
 * Бюджеты не задаются: пользователь проставит их на экране «План».
 */
const PRESETS: Record<'ru' | 'en', { regular: string[]; system: string }> = {
  ru: {
    regular: ['Продукты', 'Кафе', 'Транспорт', 'Дом', 'Здоровье', 'Развлечения'],
    system: 'Общее',
  },
  en: {
    regular: ['Groceries', 'Eating out', 'Transport', 'Home', 'Health', 'Fun'],
    system: 'General',
  },
};

export async function seedPresetCategories(workspaceId: string, locale: string): Promise<void> {
  const preset = PRESETS[locale === 'en' ? 'en' : 'ru'];
  const rows = [
    ...preset.regular.map((name, i) => ({ workspaceId, name, sort: i })),
    { workspaceId, name: preset.system, isSystem: true, sort: 99 },
  ];
  await db.insert(categories).values(rows).onConflictDoNothing();
}

export const categoriesRoute = new Hono<{ Variables: AppVariables }>();
categoriesRoute.use('*', requireWorkspace);

categoriesRoute.get('/categories', async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select()
    .from(categories)
    .where(and(eq(categories.workspaceId, ws.id), eq(categories.archived, false)))
    .orderBy(asc(categories.sort), asc(categories.name));
  return c.json(rows);
});

categoriesRoute.post('/categories', async (c) => {
  const ws = c.get('workspace')!;
  const body = categoryCreateSchema.parse(await c.req.json());
  const inserted = await db
    .insert(categories)
    .values({
      workspaceId: ws.id,
      name: body.name,
      icon: body.icon,
      protected: body.protected ?? false,
    })
    .returning();
  return c.json(inserted[0]!, 201);
});

categoriesRoute.patch('/categories/:id', async (c) => {
  const ws = c.get('workspace')!;
  if (!isUuid(c.req.param('id'))) return c.json({ error: 'not_found' }, 404);
  const body = categoryPatchSchema.parse(await c.req.json());
  const updated = await db
    .update(categories)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
      ...(body.protected !== undefined ? { protected: body.protected } : {}),
      ...(body.sort !== undefined ? { sort: body.sort } : {}),
    })
    .where(and(eq(categories.id, c.req.param('id')), eq(categories.workspaceId, ws.id)))
    .returning();
  if (!updated[0]) return c.json({ error: 'not_found' }, 404);
  return c.json(updated[0]);
});

categoriesRoute.delete('/categories/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
  const rows = await db
    .select({ isSystem: categories.isSystem })
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.workspaceId, ws.id)));
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  if (rows[0].isSystem) return c.json({ error: 'system_category' }, 400);
  // Архивируем, а не удаляем: транзакции категории не теряются (инвариант 6).
  await db
    .update(categories)
    .set({ archived: true })
    .where(and(eq(categories.id, id), eq(categories.workspaceId, ws.id)));
  return c.body(null, 204);
});
