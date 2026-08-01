import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { auth } from './auth.ts';
import { db } from './db/client.ts';
import { workspaceMembers, workspaces } from './db/schema/domain.ts';

type SessionUser = typeof auth.$Infer.Session.user;
type SessionRow = typeof auth.$Infer.Session.session;
export type Workspace = typeof workspaces.$inferSelect;

/** Роль в воркспейсе: владелец правит, участник смотрит по матрице видимости (issue #46). */
export type WorkspaceRole = 'owner' | 'member';

export interface AppVariables {
  user: SessionUser | null;
  session: SessionRow | null;
  workspace: Workspace | null;
  role: WorkspaceRole | null;
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
 * Изоляция workspace (железное правило 7): workspace резолвится ТОЛЬКО из сессии. Клиент никогда
 * не передаёт workspace_id — ни своего, ни чужого.
 *
 * Совместный доступ (issue #46) правило не обходит, а расширяет: сначала ищем воркспейс, которым
 * человек владеет, и только если своего нет — тот, в который его пригласили. Владение важнее
 * участия: у пригласившего свой план не должен подменяться чужим.
 *
 * Участник ничего не меняет. Запрет держится здесь, одним местом, а не проверкой в каждом
 * хендлере: список хендлеров растёт каждый спринт, и забытая проверка означала бы тихую запись в
 * чужой бюджет.
 */
export const requireWorkspace = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const owned = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
  let ws = owned[0];
  let role: WorkspaceRole = 'owner';

  if (!ws) {
    const shared = await db
      .select({ workspace: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id))
      .limit(1);
    if (shared[0]) {
      ws = shared[0].workspace;
      role = shared[0].role === 'owner' ? 'owner' : 'member';
    }
  }

  if (!ws) return c.json({ error: 'no_workspace', message: 'complete onboarding first' }, 409);

  if (role === 'member' && c.req.method !== 'GET') {
    // Участник может предложить правку (отдельная задача), но не записать её сам.
    return c.json({ error: 'read_only_member' }, 403);
  }

  c.set('workspace', ws);
  c.set('role', role);
  await next();
});

/** Только владелец: приглашения, состав участников, матрица видимости. */
export const requireOwner = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  if (c.get('role') !== 'owner') return c.json({ error: 'owner_only' }, 403);
  await next();
});

/** Роль пользователя в воркспейсе; владелец таблицей участников не ограничен. */
export async function roleIn(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const rows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  const role = rows[0]?.role;
  return role === 'owner' || role === 'member' ? role : null;
}

/** Разделы, у которых есть режим видимости (issue #46). */
export type ShareSection = 'income' | 'debts' | 'buckets' | 'envelopes' | 'categories' | 'goals';

/**
 * Доступ участника к списку раздела. Владельцу — всегда; участнику — только когда раздел открыт.
 *
 * Режимы `sum` и `hidden` закрывают именно СПИСОК: итог раздела участник по-прежнему видит в плане
 * (правило «скрыть можно содержимое, но не факт траты»). Отдавать пустой список вместо отказа
 * нельзя: «долгов нет» и «долги закрыты от тебя» — разные утверждения, и первое было бы враньём.
 */
export function requireSection(section: ShareSection) {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    if (c.get('role') === 'owner') return next();
    const ws = c.get('workspace');
    const mode = ws ? sectionModeOf(ws, section) : 'open';
    if (mode !== 'open') return c.json({ error: 'section_hidden', section, mode }, 403);
    await next();
  });
}

/** Режим раздела из настроек воркспейса. Отдельная функция, чтобы не тянуть store в middleware. */
function sectionModeOf(ws: Workspace, section: ShareSection): 'open' | 'sum' | 'hidden' {
  const raw = (ws.settings as { sharing?: Record<string, unknown> } | null)?.sharing?.[section];
  return raw === 'sum' || raw === 'hidden' ? raw : 'open';
}
