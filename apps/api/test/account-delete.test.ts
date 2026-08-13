import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { db } from '../src/db/client.ts';
import { transactions, workspaces } from '../src/db/schema/domain.ts';
import { expectOk, onboarded } from './client.ts';

/**
 * Удаление аккаунта (Спринт 6). Без него нельзя звать посторонних: человек, отдавший продукту свои
 * деньги, обязан иметь возможность забрать их обратно и уйти — и не письмом основателю, а кнопкой.
 *
 * Каскады в схеме были с самого начала (`onDelete: 'cascade'` на user_id), но запустить их было
 * нечем — только руками в базе.
 *
 * Подтверждение — почтой, как у GitHub с именем репозитория: сессия уже доказала, КТО пришёл, а
 * ввод подтверждает, что человек понимает, ЧТО сейчас произойдёт. Второй пароль здесь не защита, а
 * ещё одно поле.
 */
describe('удаление аккаунта', () => {
  test('уносит воркспейс и все его данные', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const me = await expectOk<{ user: { email: string }; workspace: { id: string } }>(
      await client.get('/v1/me'),
    );
    const wsId = me.workspace.id;
    await expectOk(
      await client.post('/v1/transactions', {
        amountMinor: '100000',
        currency: 'RUB',
        occurredOn: new Date().toISOString().slice(0, 10),
      }),
      201,
    );

    await expectOk(await client.del(`/v1/me?confirm=${encodeURIComponent(me.user.email)}`));

    expect(await db.select().from(workspaces).where(eq(workspaces.id, wsId))).toHaveLength(0);
    // Данные уходят каскадом, а не остаются сиротами со ссылкой в никуда.
    expect(
      await db.select().from(transactions).where(eq(transactions.workspaceId, wsId)),
    ).toHaveLength(0);
  });

  test('сессия после удаления не работает', async () => {
    const client = await onboarded();
    const me = await expectOk<{ user: { email: string } }>(await client.get('/v1/me'));
    await expectOk(await client.del(`/v1/me?confirm=${encodeURIComponent(me.user.email)}`));
    expect((await client.get('/v1/me')).status).toBe(401);
  });

  test('без верного подтверждения не удаляет — и говорит об этом', async () => {
    const client = await onboarded();
    const me = await expectOk<{ workspace: { id: string } }>(await client.get('/v1/me'));

    expect((await client.del('/v1/me')).status).toBe(400);
    expect((await client.del('/v1/me?confirm=not-my-email@example.com')).status).toBe(400);

    // Данные на месте: неудачное подтверждение ничего не тронуло.
    expect(
      await db.select().from(workspaces).where(eq(workspaces.id, me.workspace.id)),
    ).toHaveLength(1);
  });

  test('участник чужого воркспейса уносит себя, но не хозяйский воркспейс', async () => {
    const owner = await onboarded();
    const ownerMe = await expectOk<{ workspace: { id: string } }>(await owner.get('/v1/me'));
    const invite = await expectOk<{ code: string }>(
      await owner.post('/v1/workspace/invites', { role: 'member' }),
      201,
    );

    const guest = await onboarded();
    await expectOk(await guest.post(`/v1/workspace/invites/${invite.code}/accept`));
    const guestMe = await expectOk<{ user: { email: string } }>(await guest.get('/v1/me'));

    await expectOk(await guest.del(`/v1/me?confirm=${encodeURIComponent(guestMe.user.email)}`));

    // Чужой воркспейс не трогаем: участник уходит, продукт хозяина остаётся.
    expect(
      await db.select().from(workspaces).where(eq(workspaces.id, ownerMe.workspace.id)),
    ).toHaveLength(1);
    expect((await owner.get('/v1/me')).status).toBe(200);
  });
});
