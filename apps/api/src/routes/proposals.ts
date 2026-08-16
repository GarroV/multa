import { and, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { db } from '../db/client.ts';
import { isUuid } from '../http/ids.ts';
import { editProposals } from '../db/schema/domain.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import { getCurrentPlan, setGridCell } from '../plan/assemble.ts';
import { sectionVisible } from '../plan/sharing.ts';
import { settingsOf } from '../settings/store.ts';
import { proposalCreateSchema } from '../validation.ts';
import { today } from '../clock.ts';
import { logger } from '../logger.ts';

/**
 * Предложения правок от участника совместного доступа (issue #83).
 *
 * Участник только смотрит: любой не-GET отклоняется в middleware. Это безопасно, но неполно —
 * он должен уметь *предложить* правку, а владелец принять её или отклонить.
 *
 * Три решения, определяющие ручки:
 *
 * 1. **Принятие идёт через `setGridCell`** — ту же функцию, что обычная правка ячейки. Второй
 *    дороги к деньгам не появляется: если правка меняет план, историю и каскад, то и принятое
 *    предложение меняет их ровно так же. Предложение, которое меняет свой статус и не трогает
 *    план, — молчаливый сбой: обе стороны считают, что договорились.
 * 2. **Скрытый раздел отвечает «не найдено», а не «нельзя»**. Отказ по существу сам подтверждал бы,
 *    что строка существует, — и участник узнавал бы о скрытой цели через форму предложения.
 * 3. **Решает только владелец, и только один раз.** Повторное решение — конфликт, а не «применить
 *    ещё раз»: иначе одно предложение переставляло бы деньги дважды.
 */

export const proposalsRoute = new Hono<{ Variables: AppVariables }>();

proposalsRoute.use('*', requireWorkspace);

/** Строка предложения наружу: минор — строкой, как все деньги в API. */
type ProposalDto = {
  id: string;
  targetKind: string;
  targetId: string;
  startsOn: string;
  plannedMinor: string;
  status: string;
  createdAt: string;
};

const toDto = (row: typeof editProposals.$inferSelect): ProposalDto => ({
  id: row.id,
  targetKind: row.targetKind,
  targetId: row.targetId,
  startsOn: row.startsOn,
  plannedMinor: row.plannedMinor.toString(),
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

proposalsRoute.get('/proposals', async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select()
    .from(editProposals)
    .where(eq(editProposals.workspaceId, ws.id))
    .orderBy(desc(editProposals.createdAt));
  return c.json({ proposals: rows.map(toDto) });
});

proposalsRoute.post('/proposals', async (c) => {
  const ws = c.get('workspace')!;
  /*
   * Владельцу предлагать нечего: он правит напрямую. Разрешить ему создавать предложения значило бы
   * завести вторую, более длинную дорогу к собственному плану — и ленту, где он спорит сам с собой.
   */
  if (c.get('role') !== 'member') return c.json({ error: 'owner_edits_directly' }, 403);

  const body = proposalCreateSchema.parse(await c.req.json());

  /*
   * Скрытый раздел — «не найдено». Именно 404, а не 403: отказ по существу подтверждал бы
   * существование строки, и участник узнавал бы о скрытой цели через форму предложения.
   */
  if (!sectionVisible(body.targetKind, settingsOf(ws).sharing, true)) {
    return c.json({ error: 'not_found' }, 404);
  }

  const [row] = await db
    .insert(editProposals)
    .values({
      workspaceId: ws.id,
      authorId: c.get('user')!.id,
      targetKind: body.targetKind,
      targetId: body.targetId,
      startsOn: body.startsOn,
      plannedMinor: body.plannedMinor,
    })
    .returning();

  return c.json(toDto(row!), 201);
});

/** Общая часть решения: найти своё, убедиться, что оно ещё не решено. */
async function resolvable(c: Context<{ Variables: AppVariables }>) {
  const ws = c.get('workspace')!;
  if (c.get('role') !== 'owner') return { error: c.json({ error: 'owner_only' }, 403) } as const;

  const id = c.req.param('id');
  // Кривой идентификатор — «не найдено», а не падение запроса: Postgres на нечисловом uuid бросит.
  if (!id || !isUuid(id)) return { error: c.json({ error: 'not_found' }, 404) } as const;
  const [row] = await db
    .select()
    .from(editProposals)
    .where(and(eq(editProposals.id, id), eq(editProposals.workspaceId, ws.id)));

  // Чужое предложение неотличимо от несуществующего: воркспейс в запрос не передаётся клиентом.
  if (!row) return { error: c.json({ error: 'not_found' }, 404) } as const;
  if (row.status !== 'pending')
    return { error: c.json({ error: 'already_resolved' }, 409) } as const;
  return { row } as const;
}

proposalsRoute.post('/proposals/:id/accept', async (c) => {
  const found = await resolvable(c);
  if ('error' in found) return found.error;
  const ws = c.get('workspace')!;
  const asOf = today(ws.timezone);

  try {
    // Ровно та же операция, что обычная правка: план, история и каскад ведут себя одинаково.
    await setGridCell(ws, asOf, {
      targetKind: found.row.targetKind as 'category' | 'debt' | 'envelope' | 'goal',
      targetId: found.row.targetId,
      startsOn: found.row.startsOn,
      plannedMinor: found.row.plannedMinor,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    // Предложение могло устареть: период ушёл в прошлое, строку удалили.
    if (message === 'period_is_past') return c.json({ error: 'period_is_past' }, 422);
    if (message === 'cell_not_editable') return c.json({ error: 'cell_not_editable' }, 422);
    if (message === 'target_not_found') return c.json({ error: 'not_found' }, 404);
    throw err;
  }

  await db
    .update(editProposals)
    .set({ status: 'accepted', resolvedAt: new Date(), resolvedBy: c.get('user')!.id })
    .where(eq(editProposals.id, found.row.id));

  logger.info('предложение принято', { proposalId: found.row.id, kind: found.row.targetKind });
  return c.json(await getCurrentPlan(ws, asOf));
});

proposalsRoute.post('/proposals/:id/reject', async (c) => {
  const found = await resolvable(c);
  if ('error' in found) return found.error;

  await db
    .update(editProposals)
    .set({ status: 'rejected', resolvedAt: new Date(), resolvedBy: c.get('user')!.id })
    .where(eq(editProposals.id, found.row.id));

  return c.json({ ok: true });
});
