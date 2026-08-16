import { describe, expect, test } from 'vitest';
import { expectOk, onboarded, signedUp, type TestClient } from './client.ts';

/**
 * «Предложить правку» от участника (issue #83).
 *
 * Участник совместного доступа только смотрит: любой не-GET отклоняется в middleware. Это
 * безопасно, но неполно — он должен уметь *предложить* правку, а владелец принять её или отклонить.
 *
 * Почему это отдельная сущность, а не «дать участнику писать»: правило продукта — правит строку
 * только её владелец. У предложения свой жизненный цикл, автор, цель и предлагаемое значение, и
 * принятие выполняет ровно ту же операцию, что обычная правка, — иначе история и откат разойдутся
 * с действительностью.
 */

async function pair(): Promise<{ owner: TestClient; member: TestClient; categoryId: string }> {
  const owner = await onboarded();
  const invite = await expectOk<{ code: string }>(await owner.post('/v1/workspace/invites'), 201);
  const member = await signedUp();
  await expectOk(await member.post(`/v1/workspace/invites/${invite.code}/accept`));

  const categories = await expectOk<{ id: string; name: string }[]>(
    await owner.get('/v1/categories'),
  );
  return { owner, member, categoryId: categories[0]!.id };
}

/** Дата начала текущего периода: предложение всегда адресовано конкретному периоду. */
async function currentPeriod(client: TestClient): Promise<string> {
  const plan = await expectOk<{ period: { startsOn: string } }>(
    await client.get('/v1/plan/current'),
  );
  return plan.period.startsOn;
}

describe('предложения правок', () => {
  test('участник предлагает правку, владелец её видит', async () => {
    const { owner, member, categoryId } = await pair();
    const startsOn = await currentPeriod(owner);

    const created = await expectOk<{ id: string; status: string }>(
      await member.post('/v1/proposals', {
        targetKind: 'category',
        targetId: categoryId,
        startsOn,
        plannedMinor: '1500000',
      }),
      201,
    );
    expect(created.status).toBe('pending');

    const forOwner = await expectOk<{ proposals: { id: string; plannedMinor: string }[] }>(
      await owner.get('/v1/proposals'),
    );
    expect(forOwner.proposals.map((p) => p.id)).toContain(created.id);
    expect(forOwner.proposals[0]!.plannedMinor).toBe('1500000');
  });

  test('принятие применяет правку по-настоящему, а не только меняет статус', async () => {
    const { owner, member, categoryId } = await pair();
    const startsOn = await currentPeriod(owner);

    const created = await expectOk<{ id: string }>(
      await member.post('/v1/proposals', {
        targetKind: 'category',
        targetId: categoryId,
        startsOn,
        plannedMinor: '1500000',
      }),
      201,
    );
    await expectOk(await owner.post(`/v1/proposals/${created.id}/accept`));

    /*
     * Главная проверка: деньги действительно переставлены. Предложение, которое меняет свой статус
     * и не трогает план, — молчаливый сбой: и участник, и владелец считают, что правка применена.
     */
    const plan = await expectOk<{ allocations: { targetId: string; plannedMinor: string }[] }>(
      await owner.get('/v1/plan/current'),
    );
    const row = plan.allocations.find((a) => a.targetId === categoryId);
    expect(row?.plannedMinor).toBe('1500000');
  });

  test('отклонённое предложение план не трогает', async () => {
    const { owner, member, categoryId } = await pair();
    const startsOn = await currentPeriod(owner);
    const before = await expectOk<{ allocations: { targetId: string; plannedMinor: string }[] }>(
      await owner.get('/v1/plan/current'),
    );
    const was = before.allocations.find((a) => a.targetId === categoryId)?.plannedMinor;

    const created = await expectOk<{ id: string }>(
      await member.post('/v1/proposals', {
        targetKind: 'category',
        targetId: categoryId,
        startsOn,
        plannedMinor: '9900000',
      }),
      201,
    );
    await expectOk(await owner.post(`/v1/proposals/${created.id}/reject`));

    const after = await expectOk<{ allocations: { targetId: string; plannedMinor: string }[] }>(
      await owner.get('/v1/plan/current'),
    );
    expect(after.allocations.find((a) => a.targetId === categoryId)?.plannedMinor).toBe(was);
  });

  test('решать может только владелец: участник не принимает свои же предложения', async () => {
    const { owner, member, categoryId } = await pair();
    const startsOn = await currentPeriod(owner);
    const created = await expectOk<{ id: string }>(
      await member.post('/v1/proposals', {
        targetKind: 'category',
        targetId: categoryId,
        startsOn,
        plannedMinor: '1500000',
      }),
      201,
    );

    const res = await member.post(`/v1/proposals/${created.id}/accept`);
    expect(res.status).toBe(403);
  });

  test('дважды решить одно предложение нельзя', async () => {
    const { owner, member, categoryId } = await pair();
    const startsOn = await currentPeriod(owner);
    const created = await expectOk<{ id: string }>(
      await member.post('/v1/proposals', {
        targetKind: 'category',
        targetId: categoryId,
        startsOn,
        plannedMinor: '1500000',
      }),
      201,
    );
    await expectOk(await owner.post(`/v1/proposals/${created.id}/accept`));

    // Повтор — не «ещё раз применить», а конфликт: решение уже принято.
    const again = await owner.post(`/v1/proposals/${created.id}/accept`);
    expect(again.status).toBe(409);
  });

  test('в скрытый раздел предложить нельзя: форма не должна выдавать существование строки', async () => {
    const { owner, member } = await pair();
    const startsOn = await currentPeriod(owner);
    await expectOk(
      await owner.post('/v1/goals', {
        name: 'Мотоцикл',
        currency: 'RUB',
        targetMinor: '9000000',
        plannedPerPeriodMinor: '500000',
      }),
      201,
    );
    const goals = await expectOk<{ id: string }[]>(await owner.get('/v1/goals'));
    await expectOk(await owner.patch('/v1/workspace/settings', { sharing: { goals: 'hidden' } }));

    const res = await member.post('/v1/proposals', {
      targetKind: 'goal',
      targetId: goals[0]!.id,
      startsOn,
      plannedMinor: '100000',
    });
    // Тот же ответ, что у несуществующей строки: иначе отказ сам подтверждает, что цель есть.
    expect(res.status).toBe(404);
  });

  test('владелец предложений не создаёт: он правит напрямую', async () => {
    const { owner, categoryId } = await pair();
    const startsOn = await currentPeriod(owner);

    const res = await owner.post('/v1/proposals', {
      targetKind: 'category',
      targetId: categoryId,
      startsOn,
      plannedMinor: '1500000',
    });
    expect(res.status).toBe(403);
  });

  test('чужие предложения не видны и не решаются', async () => {
    const { member, categoryId } = await pair();
    const startsOn = await currentPeriod(member);
    const created = await expectOk<{ id: string }>(
      await member.post('/v1/proposals', {
        targetKind: 'category',
        targetId: categoryId,
        startsOn,
        plannedMinor: '1500000',
      }),
      201,
    );

    // Посторонний воркспейс: ни в списке, ни по прямому адресу.
    const stranger = await onboarded();
    const list = await expectOk<{ proposals: { id: string }[] }>(
      await stranger.get('/v1/proposals'),
    );
    expect(list.proposals.map((p) => p.id)).not.toContain(created.id);
    expect((await stranger.post(`/v1/proposals/${created.id}/accept`)).status).toBe(404);
  });
});
