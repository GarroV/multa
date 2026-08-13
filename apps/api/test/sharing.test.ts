import { describe, expect, test } from 'vitest';
import { expectOk, onboarded, signedUp, type TestClient } from './client.ts';

/**
 * Совместный доступ (issue #46): участники, матрица видимости, «view as».
 *
 * Главное правило продукта, которое здесь проверяется: **скрыть можно содержимое, но не факт
 * траты**. Деньги, ушедшие из общего котла, обязаны остаться видимыми в итоге — иначе совместный
 * план врёт: у одного 300 000 дохода и понятная раскладка, у второго те же 300 000 и дыра без
 * объяснения.
 *
 * Второе правило: участник ничего не меняет. Запрет живёт в middleware одним местом, поэтому
 * проверяется на разных ручках — забытая проверка в новом хендлере означала бы тихую запись в
 * чужой бюджет.
 */

interface MembersDto {
  role: 'owner' | 'member';
  members: { id: string; userId: string; role: string; email: string }[];
  sharing: Record<string, 'open' | 'sum' | 'hidden'>;
}

interface PlanSharingDto {
  role: string;
  previewAsMember: boolean;
  sums: { section: string; minor: string }[];
  hiddenMinor: string;
  incomeVisible: boolean;
}

interface PlanDto {
  incomeMinor: string;
  allocations: { targetKind: string; name: string; allocatedMinor: string }[];
  income: { events: unknown[] };
  sharing: PlanSharingDto;
}

const planOf = async (client: TestClient, query = ''): Promise<PlanDto> =>
  expectOk<PlanDto>(await client.get(`/v1/plan/current${query}`));

/** Владелец с долгом и целью + принявший приглашение участник. */
async function pair(): Promise<{ owner: TestClient; member: TestClient }> {
  const owner = await onboarded();
  await expectOk(
    await owner.post('/v1/debts', {
      name: 'Кредит',
      currency: 'RUB',
      principalMinor: '5000000',
      remainingMinor: '5000000',
      paymentMinor: '800000',
    }),
    201,
  );
  await expectOk(
    await owner.post('/v1/goals', {
      name: 'Мотоцикл',
      currency: 'RUB',
      targetMinor: '9000000',
      plannedPerPeriodMinor: '500000',
    }),
    201,
  );

  const invite = await expectOk<{ code: string }>(await owner.post('/v1/workspace/invites'), 201);
  const member = await signedUp();
  await expectOk(await member.post(`/v1/workspace/invites/${invite.code}/accept`));
  return { owner, member };
}

const setMode = async (owner: TestClient, section: string, mode: string) =>
  expectOk(await owner.patch('/v1/workspace/settings', { sharing: { [section]: mode } }));

describe('совместный доступ', () => {
  test('приглашение по коду впускает участника в чужой воркспейс', async () => {
    const { owner, member } = await pair();
    const mine = await expectOk<MembersDto>(await member.get('/v1/workspace/members'));
    expect(mine.role).toBe('member');
    expect(mine.members.some((m) => m.role === 'owner')).toBe(true);

    // Участник видит тот же план, что владелец: по умолчанию всё открыто.
    const ownerPlan = await planOf(owner);
    const memberPlan = await planOf(member);
    expect(memberPlan.incomeMinor).toBe(ownerPlan.incomeMinor);
    expect(memberPlan.allocations.map((a) => a.name).sort()).toEqual(
      ownerPlan.allocations.map((a) => a.name).sort(),
    );
  });

  test('код одноразовый: пересланное приглашение второго не впускает', async () => {
    const owner = await onboarded();
    const invite = await expectOk<{ code: string }>(await owner.post('/v1/workspace/invites'), 201);
    const first = await signedUp();
    await expectOk(await first.post(`/v1/workspace/invites/${invite.code}/accept`));

    const second = await signedUp();
    const res = await second.post(`/v1/workspace/invites/${invite.code}/accept`);
    expect(res.status).toBe(404);
    // Второй остался без воркспейса, а не получил чужой.
    expect((await second.get('/v1/plan/current')).status).toBe(409);
  });

  test('режим «сумма»: строк не видно, итог виден', async () => {
    const { owner, member } = await pair();
    await setMode(owner, 'debts', 'sum');

    const plan = await planOf(member);
    expect(plan.allocations.some((a) => a.targetKind === 'debt')).toBe(false);
    // Итог раздела остаётся: деньги не могут просто исчезнуть из общего котла.
    expect(plan.sharing.sums).toContainEqual({ section: 'debts', minor: '800000' });
    // Список раздела закрыт отказом, а не пустотой: «долгов нет» было бы враньём.
    const list = await member.get('/v1/debts');
    expect(list.status).toBe(403);
    expect(await list.json()).toMatchObject({ error: 'section_hidden', mode: 'sum' });
  });

  test('режим «скрыто»: раздел сворачивается в строку «Личное»', async () => {
    const { owner, member } = await pair();
    await setMode(owner, 'goals', 'hidden');

    const plan = await planOf(member);
    expect(plan.allocations.some((a) => a.targetKind === 'goal')).toBe(false);
    expect(plan.sharing.hiddenMinor).toBe('500000');
    expect((await member.get('/v1/goals')).status).toBe(403);
  });

  test('скрытый доход прячет разбивку, но не сумму', async () => {
    const { owner, member } = await pair();
    await setMode(owner, 'income', 'hidden');

    const plan = await planOf(member);
    expect(plan.income.events).toEqual([]);
    expect(plan.sharing.incomeVisible).toBe(false);
    // Сумма дохода остаётся: без неё план не сходится и выглядит как ошибка.
    expect(BigInt(plan.incomeMinor)).toBeGreaterThan(0n);
    expect((await member.get('/v1/income-sources')).status).toBe(403);
  });

  test('владелец может посмотреть глазами участника, не теряя прав', async () => {
    const { owner, member } = await pair();
    await setMode(owner, 'goals', 'hidden');

    const asMember = await planOf(owner, '?as=member');
    expect(asMember.sharing.previewAsMember).toBe(true);
    expect(asMember.allocations.some((a) => a.targetKind === 'goal')).toBe(false);
    expect(asMember.sharing.hiddenMinor).toBe('500000');

    // Обычный запрос владельца по-прежнему полон, и права никуда не делись.
    const own = await planOf(owner);
    expect(own.allocations.some((a) => a.targetKind === 'goal')).toBe(true);
    expect((await owner.get('/v1/goals')).status).toBe(200);
    void member;
  });

  test('участник ничего не меняет — ни в одной ручке', async () => {
    const { member } = await pair();
    const attempts = [
      await member.post('/v1/debts', {
        name: 'Свой долг',
        currency: 'RUB',
        principalMinor: '100',
        remainingMinor: '100',
        paymentMinor: '100',
      }),
      await member.post('/v1/categories', { name: 'Своя категория' }),
      await member.patch('/v1/workspace/settings', { cascade: { bufferPct: 10 } }),
      await member.post('/v1/transactions', {
        kind: 'expense',
        amountMinor: '1000',
        currency: 'RUB',
      }),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'read_only_member' });
    }
  });

  test('участник не управляет составом участников', async () => {
    const { owner, member } = await pair();
    expect((await member.post('/v1/workspace/invites')).status).toBe(403);

    const list = await expectOk<MembersDto>(await owner.get('/v1/workspace/members'));
    const row = list.members.find((m) => m.role === 'member')!;
    expect((await member.del(`/v1/workspace/members/${row.id}`)).status).toBe(403);
  });

  test('владелец исключает участника, и доступ пропадает сразу', async () => {
    const { owner, member } = await pair();
    const list = await expectOk<MembersDto>(await owner.get('/v1/workspace/members'));
    const row = list.members.find((m) => m.role === 'member')!;

    expect((await owner.del(`/v1/workspace/members/${row.id}`)).status).toBe(204);
    // Своего воркспейса у исключённого нет — значит и плана больше нет.
    expect((await member.get('/v1/plan/current')).status).toBe(409);
  });

  test('скрытое не протекает через другие ручки — ни одну', async () => {
    /*
     * Регрессия на дыру, найденную сразу после выката #46: матрица видимости применялась ТОЛЬКО к
     * `/v1/plan/current`, и участник читал имя скрытой цели через `/v1/signals`, `/v1/forecast`,
     * `/v1/plan/grid` и `/v1/recurring-items`. Причина была системная — список запрещённого вместо
     * списка разрешённого. Тест перечисляет ручки, которые про видимость ничего не знают, и
     * требует от них отказа: пока ручка не научилась матрице, участнику её отдавать нельзя.
     */
    const { owner, member } = await pair();
    await expectOk(
      await owner.post('/v1/recurring-items', {
        name: 'СЕКРЕТНЫЙ ПЛАТЁЖ',
        amountMinor: '150000',
        currency: 'RUB',
        schedule: { kind: 'each-payout' },
      }),
      201,
    );
    await setMode(owner, 'goals', 'hidden');

    for (const path of [
      '/v1/analytics/spread',
      '/v1/exchange-ops',
      '/v1/accounts',
      '/v1/accounts/balances',
      '/v1/transactions',
      '/v1/plan/current/revisions',
    ]) {
      const res = await member.get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not_shared');
    }

    // При этом сам план участнику по-прежнему доступен: закрыт не доступ, а необученные ручки.
    const plan = await planOf(member);
    expect(JSON.stringify(plan)).not.toContain('Мотоцикл');
    expect(plan.sharing.hiddenMinor).toBe('500000');
  });

  test('обученные ручки отдаются участнику, но без имён из закрытых разделов', async () => {
    /*
     * Продолжение #84. Сигналы, прогноз и регулярные платежи научены матрице, поэтому участник их
     * получает — но «Мотоцикл» и «СЕКРЕТНЫЙ ПЛАТЁЖ» в них не появляются, пока раздел закрыт.
     */
    const { owner, member } = await pair();
    await expectOk(
      await owner.post('/v1/recurring-items', {
        name: 'СЕКРЕТНЫЙ ПЛАТЁЖ',
        amountMinor: '150000',
        currency: 'RUB',
        schedule: { kind: 'each-payout' },
      }),
      201,
    );
    await setMode(owner, 'goals', 'hidden');
    await setMode(owner, 'recurring', 'hidden');

    const signals = await member.get('/v1/signals');
    expect(signals.status).toBe(200);
    expect(JSON.stringify(await signals.json())).not.toContain('Мотоцикл');

    const forecast = await member.get('/v1/forecast');
    expect(forecast.status).toBe(200);
    const body = JSON.stringify(await forecast.json());
    expect(body).not.toContain('Мотоцикл');
    expect(body).not.toContain('СЕКРЕТНЫЙ ПЛАТЁЖ');

    // Список закрытого раздела по-прежнему отвечает отказом, а не пустотой.
    expect((await member.get('/v1/recurring-items')).status).toBe(403);

    // Открыли — и всё вернулось: закрыт был раздел, а не ручка.
    await setMode(owner, 'goals', 'open');
    await setMode(owner, 'recurring', 'open');
    const openList = await member.get('/v1/recurring-items');
    expect(openList.status).toBe(200);
    expect(JSON.stringify(await openList.json())).toContain('СЕКРЕТНЫЙ ПЛАТЁЖ');
  });

  test('мастер-сетка сворачивает закрытый раздел, а не теряет деньги (#84)', async () => {
    /*
     * Исчезновение хуже сокрытия: пропади скрытая строка из столбцов — итоги перестали бы сходиться,
     * «свободно» оказалось бы больше, чем есть, и участник спланировал бы на несуществующие деньги.
     * Поэтому закрытый раздел сворачивается в группу без имён, но с суммами.
     */
    const { owner, member } = await pair();
    await expectOk(
      await owner.post('/v1/goals', {
        name: 'Мотоцикл',
        currency: 'RUB',
        targetMinor: '50000000',
        plannedPerPeriodMinor: '1000000',
      }),
      201,
    );
    await setMode(owner, 'goals', 'hidden');

    const asOwner = await expectOk<{ groups: { kind: string; totals: string[] }[] }>(
      await owner.get('/v1/plan/grid?periods=3'),
    );
    const asMember = await expectOk<{ groups: { kind: string; totals: string[] }[] }>(
      await member.get('/v1/plan/grid?periods=3'),
    );

    // Имени скрытой строки у участника нет вовсе.
    expect(JSON.stringify(asMember)).not.toContain('Мотоцикл');
    expect(asMember.groups.some((g) => g.kind === 'goal')).toBe(false);

    // Но деньги на месте: сумма группы «личное» равна сумме скрытых разделов владельца.
    const hidden = asOwner.groups.find((g) => g.kind === 'goal')!;
    const priv = asMember.groups.find((g) => g.kind === 'private')!;
    expect(priv).toBeDefined();
    expect(priv.totals[0]).toBe(hidden.totals[0]);
  });

  test('категорийная аналитика открыта ровно тогда, когда открыт раздел категорий (#84)', async () => {
    /*
     * Промежуточного режима у этой ручки нет: её смысл — сравнение ПО ИМЕНАМ, и «суммой» от неё
     * остаётся пустая таблица. Отдавать её при `sum` значило бы делать вид, что раздел доступен.
     */
    const { owner, member } = await pair();
    expect((await member.get('/v1/analytics/categories')).status).toBe(200);

    await setMode(owner, 'categories', 'sum');
    expect((await member.get('/v1/analytics/categories')).status).toBe(403);

    await setMode(owner, 'categories', 'hidden');
    expect((await member.get('/v1/analytics/categories')).status).toBe(403);

    // У владельца режим ничего не меняет: матрица — про участника.
    expect((await owner.get('/v1/analytics/categories')).status).toBe(200);
  });

  test('владельца новый сторож не трогает', async () => {
    // Список разрешённого — про участника; у владельца всё как было.
    const { owner } = await pair();
    for (const path of ['/v1/signals', '/v1/forecast', '/v1/plan/grid?periods=3', '/v1/accounts']) {
      expect({ path, status: (await owner.get(path)).status }).toEqual({ path, status: 200 });
    }
  });

  test('свой воркспейс важнее чужого приглашения', async () => {
    /*
     * У человека может быть и свой бюджет, и приглашение в чужой. Подменять его собственный план
     * чужим нельзя: он открыл приложение, чтобы увидеть свои деньги.
     */
    const owner = await onboarded();
    const invite = await expectOk<{ code: string }>(await owner.post('/v1/workspace/invites'), 201);
    const other = await onboarded({ payoutMinor: '12345600' });
    await expectOk(await other.post(`/v1/workspace/invites/${invite.code}/accept`));

    const plan = await planOf(other);
    expect(plan.incomeMinor).toBe('12345600');
    expect(plan.sharing.role).toBe('owner');
  });
});
