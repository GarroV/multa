import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { auth } from '../auth.ts';
import { db } from '../db/client.ts';
import { user } from '../db/schema/auth.ts';
import {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  demoIsEmpty,
  findDemoWorkspace,
  seedDemo,
} from '../demo/seed.ts';
import { logger } from '../logger.ts';
import type { AppVariables } from '../middleware.ts';

/**
 * Вход в демо без регистрации (issue #56).
 *
 * `POST /v1/demo/enter` создаёт демо-пользователя при первом обращении, сеет данные, если пусто,
 * и отдаёт обычную сессию better-auth — дальше демо ничем не отличается от рядового воркспейса,
 * включая изоляцию по правилу 7. Пароль демо не секрет, а спидбамп: сервер и так входит сам.
 */
export const demoRoute = new Hono<{ Variables: AppVariables }>();

/** Демо-пользователь: создаётся один раз обычной регистрацией, чтобы пароль лёг как у всех. */
async function ensureDemoUser(): Promise<string> {
  const existing = await findDemoWorkspace();
  if (existing) return markVerified(existing.userId);

  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, DEMO_EMAIL))
    .limit(1);
  if (rows[0]) return markVerified(rows[0].id);

  await auth.api.signUpEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Multa demo' },
  });
  const created = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, DEMO_EMAIL))
    .limit(1);
  if (!created[0]) throw new Error('demo: не удалось создать пользователя');
  return markVerified(created[0].id);
}

/**
 * Почта демо считается подтверждённой (issue #85). Подтверждать её некому и нечем — писем продукт
 * пока не шлёт, — а в день, когда включат `requireEmailVerification`, сервер перестал бы пускать
 * демо-пользователя: первый же клик «посмотреть без регистрации» умер бы.
 *
 * Ставится на каждом входе, а не только при создании: демо-пользователь уже существует на проде с
 * неподтверждённой почтой, и «поправим потом руками» — ровно тот способ, которым такие вещи и
 * остаются непоправленными.
 */
async function markVerified(userId: string): Promise<string> {
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
  return userId;
}

demoRoute.post('/demo/enter', async (c) => {
  const userId = await ensureDemoUser();
  const ws = await findDemoWorkspace();
  if (!ws || (await demoIsEmpty(ws.workspaceId))) await seedDemo(userId);

  // Сессию выдаёт сам better-auth: cookie, срок жизни и подпись — те же, что у обычного входа.
  const res = await auth.api.signInEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    asResponse: true,
  });
  if (!res.ok) {
    logger.error('demo: вход не удался', await res.text());
    return c.json({ error: 'demo_unavailable' }, 503);
  }
  for (const cookie of res.headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
  return c.json({ ok: true, demo: true });
});

/**
 * Ручной сброс: тот же путь, что у планового, — удобно на показе, если демо «испачкали».
 *
 * Доступен только тому, кто уже сидит в демо. Раньше ручка не требовала ничего, и на публичном
 * адресе (решение владельца 2026-08-02) это был бесплатный генератор нагрузки: один POST
 * переписывает всю демо-базу, а звать его мог кто угодно и сколько угодно.
 */
demoRoute.post('/demo/reset', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user.email !== DEMO_EMAIL) return c.json({ error: 'demo_only' }, 403);
  const userId = await ensureDemoUser();
  const workspaceId = await seedDemo(userId);
  return c.json({ ok: true, workspaceId });
});
