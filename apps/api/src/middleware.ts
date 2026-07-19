import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { auth } from './auth.ts';
import { db } from './db/client.ts';
import { workspaces } from './db/schema/domain.ts';

type SessionUser = typeof auth.$Infer.Session.user;
type SessionRow = typeof auth.$Infer.Session.session;
export type Workspace = typeof workspaces.$inferSelect;

export interface AppVariables {
  user: SessionUser | null;
  session: SessionRow | null;
  workspace: Workspace | null;
}

/** Кладёт сессию/юзера в контекст (или null). Не отклоняет. */
export const sessionMiddleware = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set('user', result?.user ?? null);
  c.set('session', result?.session ?? null);
  await next();
});

export const requireAuth = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/**
 * Изоляция workspace (железное правило 7): workspace резолвится ТОЛЬКО из сессии владельца.
 * Клиент никогда не передаёт workspace_id. Нет workspace → 409 (нужен онбординг).
 */
export const requireWorkspace = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
  const ws = rows[0];
  if (!ws) return c.json({ error: 'no_workspace', message: 'complete onboarding first' }, 409);
  c.set('workspace', ws);
  await next();
});
