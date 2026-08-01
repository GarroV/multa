import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { user } from '../db/schema/auth.ts';
import { workspaceInvites, workspaceMembers, workspaces } from '../db/schema/domain.ts';
import { requireAuth, requireOwner, requireWorkspace, type AppVariables } from '../middleware.ts';
import { settingsOf } from '../settings/store.ts';

/**
 * Совместный доступ (issue #46): участники, приглашения, матрица видимости.
 *
 * Приглашение — код, а не письмо: почтового провайдера в профиле $0 нет и не будет, ссылку
 * владелец передаёт сам. Код одноразовый: принятое приглашение сгорает, иначе пересланная
 * переписка открывала бы бюджет кому угодно.
 *
 * Матрица видимости живёт в настройках воркспейса (jsonb), а не отдельной таблицей: это
 * предпочтение владельца, а не сущность со своей жизнью.
 */
export const sharingRoute = new Hono<{ Variables: AppVariables }>();

/** Код приглашения: 16 символов base32 — читается вслух и не путается на письме. */
function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join('');
}

sharingRoute.get('/workspace/members', requireWorkspace, async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select({
      id: workspaceMembers.id,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      createdAt: workspaceMembers.createdAt,
      name: user.name,
      email: user.email,
    })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, ws.id));

  const owner = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, ws.ownerId))
    .limit(1);

  /*
   * Владелец в списке всегда, даже если строки в workspace_members ещё нет: воркспейсы, созданные
   * до появления совместного доступа, такой строки не имеют, а список без владельца выглядит как
   * бюджет без хозяина.
   */
  const hasOwnerRow = rows.some((r) => r.userId === ws.ownerId);
  const members = [
    ...(hasOwnerRow || !owner[0]
      ? []
      : [
          {
            id: 'owner',
            userId: owner[0]!.id,
            role: 'owner' as const,
            name: owner[0]!.name,
            email: owner[0]!.email,
          },
        ]),
    ...rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      role: r.role === 'owner' ? ('owner' as const) : ('member' as const),
      name: r.name,
      email: r.email,
    })),
  ];

  return c.json({
    role: c.get('role'),
    members,
    sharing: settingsOf(ws).sharing,
  });
});

sharingRoute.post('/workspace/invites', requireWorkspace, requireOwner, async (c) => {
  const ws = c.get('workspace')!;
  const code = inviteCode();
  await db.insert(workspaceInvites).values({ workspaceId: ws.id, code });
  return c.json({ code }, 201);
});

sharingRoute.get('/workspace/invites', requireWorkspace, requireOwner, async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select()
    .from(workspaceInvites)
    .where(and(eq(workspaceInvites.workspaceId, ws.id), isNull(workspaceInvites.acceptedAt)));
  return c.json(rows.map((r) => ({ code: r.code, createdAt: r.createdAt.toISOString() })));
});

/**
 * Принятие приглашения. Единственная ручка совместного доступа, которая идёт НЕ через
 * `requireWorkspace`: у принимающего своего воркспейса может не быть вовсе, а чужой ещё не его.
 */
sharingRoute.post('/workspace/invites/:code/accept', requireAuth, async (c) => {
  const me = c.get('user')!;
  const code = c.req.param('code');

  const rows = await db
    .select()
    .from(workspaceInvites)
    .where(and(eq(workspaceInvites.code, code), isNull(workspaceInvites.acceptedAt)))
    .limit(1);
  const invite = rows[0];
  if (!invite) return c.json({ error: 'invite_not_found' }, 404);

  const target = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, invite.workspaceId))
    .limit(1);
  if (!target[0]) return c.json({ error: 'invite_not_found' }, 404);
  // Приглашать себя же незачем: владелец и так видит всё.
  if (target[0].ownerId === me.id) return c.json({ error: 'already_owner' }, 409);

  await db.transaction(async (tx) => {
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: invite.workspaceId, userId: me.id, role: 'member' })
      .onConflictDoNothing();
    // Код сгорает: пересланное приглашение не должно открывать бюджет второму человеку.
    await tx
      .update(workspaceInvites)
      .set({ acceptedBy: me.id, acceptedAt: new Date() })
      .where(eq(workspaceInvites.id, invite.id));
  });

  return c.json({ ok: true, workspaceId: invite.workspaceId });
});

sharingRoute.delete('/workspace/members/:id', requireWorkspace, requireOwner, async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  const removed = await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ws.id),
        eq(workspaceMembers.id, id),
        // Владельца из собственного воркспейса удалить нельзя даже случайно.
        eq(workspaceMembers.role, 'member'),
      ),
    )
    .returning({ id: workspaceMembers.id });
  if (!removed[0]) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
