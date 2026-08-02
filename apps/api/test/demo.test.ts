import { describe, expect, test } from 'vitest';
import { anonymous, expectOk, onboarded, seedRate, type PlanDto } from './client.ts';

/**
 * Демо без регистрации (issue #56). Проверяется ровно то, что обещано смотрящему: один запрос —
 * и он внутри наполненного кабинета на английском, при этом демо не даёт доступа к чужим данным.
 */

interface MeDto {
  user: { email: string } | null;
  workspace: { baseCurrency: string; locale: string } | null;
  onboardingComplete: boolean;
}

describe('вход в демо', () => {
  test('без регистрации выдаётся сессия и наполненный воркспейс', async () => {
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));

    const me = await expectOk<MeDto>(await guest.get('/v1/me'));
    expect(me.user?.email).toBe('demo@multa.local');
    // Язык демо — всегда английский, независимо от языка продукта.
    expect(me.workspace?.locale).toBe('en');
    expect(me.onboardingComplete).toBe(true);

    const plan = await expectOk<PlanDto>(await guest.get('/v1/plan/current'));
    expect(BigInt(plan.incomeMinor)).toBeGreaterThan(0n);
    // Наполненность: каскад показывает долги, корзины, конверты, категории и цели.
    const kinds = new Set(plan.allocations.map((a) => a.targetKind));
    for (const kind of ['debt', 'bucket', 'envelope', 'category', 'goal']) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    // Факт периода уже есть — иначе цифра дня и burn-rate показывали бы пустоту.
    expect(BigInt(plan.spentLivingMinor)).toBeGreaterThan(0n);
    // Демо обязано показывать работающий каскад, а не всё в нуле: дохода хватает на весь план,
    // поэтому сжатия нет и каждая строка получает свою сумму.
    expect(BigInt(plan.compressedMinor)).toBe(0n);
    // Порог, а не «больше нуля»: строка на 30 RUB вместо 3 000 выглядит как ошибка данных
    // (так уже случилось с fixed-конвертом, где ruleValue — minor units).
    for (const a of plan.allocations)
      expect(BigInt(a.allocatedMinor)).toBeGreaterThanOrEqual(100_000n);
    expect(BigInt(plan.canSpendPerDayMinor)).toBeGreaterThan(0n);
  });

  test('остаток по счетам заполнен и считается в базовой валюте', async () => {
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));
    const balances = await expectOk<{
      totalMinor: string | null;
      byCurrency: { currency: string }[];
      unresolved: string[];
    }>(await guest.get('/v1/accounts/balances'));

    // Три валюты сразу: продукт про жизнь между валютами, и первый экран это показывает.
    expect(new Set(balances.byCurrency.map((b) => b.currency))).toEqual(
      new Set(['RUB', 'EUR', 'RSD']),
    );
    // Итог обязан считаться: «—» вместо суммы означало бы, что курсов демо нет.
    expect(balances.unresolved).toEqual([]);
    expect(BigInt(balances.totalMinor ?? '0')).toBeGreaterThan(0n);
  });

  test('демо показывает подтверждённый доход и правку плана, а не пустые панели', async () => {
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));

    // Правило продукта: новая фича обязана быть видна в демо, иначе показывать нечего.
    const plan = await expectOk<PlanDto & { income: { events: { status: string }[] } }>(
      await guest.get('/v1/plan/current'),
    );
    expect(plan.income.events.some((e) => e.status === 'received')).toBe(true);

    const revisions = await expectOk<{ kind: string; moves: { amountMinor: string }[] }[]>(
      await guest.get('/v1/plan/current/revisions'),
    );
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions[0]?.moves[0]?.amountMinor).toBe('50000');
  });

  test('данные демо на английском', async () => {
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));
    const cats = await expectOk<{ name: string }[]>(await guest.get('/v1/categories'));
    const names = cats.map((c) => c.name);
    expect(names).toContain('Groceries');
    expect(names.some((n) => /[А-Яа-я]/.test(n))).toBe(false);
  });

  test('история шести периодов на месте: аналитике есть на чём считать', async () => {
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));
    const plan = await expectOk<PlanDto>(await guest.get('/v1/plan/current'));
    const from = new Date(
      new Date(`${plan.period.startsOn}T00:00:00Z`).getTime() - 200 * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const past = await expectOk<{ transactions: unknown[] }>(
      await guest.get(`/v1/transactions?from=${from}&to=${plan.period.startsOn}`),
    );
    expect(past.transactions.length).toBeGreaterThanOrEqual(25);
  });

  test('размены с разными спредами показывают копилку потерь', async () => {
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));
    const fx = await expectOk<{
      ops: { spreadPct: string | null; provider: string | null }[];
      totalLost: unknown[];
    }>(await guest.get('/v1/exchange-ops'));
    expect(fx.ops.length).toBeGreaterThanOrEqual(3);
    expect(fx.totalLost.length).toBeGreaterThan(0);

    // Спред обязан быть правдоподобным: меняла берёт своё, а не платит сверху рынка. Пока суммы
    // разменов стояли константами, демо показывало «+9,4%» и «−30,8%» и средний спред −0,4%.
    const spreads = fx.ops.map((o) => Number(o.spreadPct));
    expect(spreads.every((s) => Number.isFinite(s))).toBe(true);
    for (const s of spreads) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(5);
    }
    // Разные провайдеры с разной ценой — иначе сравнивать не с чем.
    expect(new Set(fx.ops.map((o) => o.provider)).size).toBeGreaterThan(1);
    expect(Math.max(...spreads) - Math.min(...spreads)).toBeGreaterThan(0.5);

    /*
     * Демо показывает не только копилку потерь, но и вывод из неё: у кого дешевле (issue #53).
     * Совет требует повторяемости у лучшего провайдера — если сид скатится к одной сделке на
     * обменник, панель в демо останется без главной строки, и это надо ловить здесь.
     */
    const spread = await expectOk<{
      best: { provider: string | null } | null;
      confident: boolean;
      savingMinor: string;
      savingCurrency: string | null;
    }>(await guest.get('/v1/analytics/spread?months=6'));
    expect(spread.best?.provider).toBeTruthy();
    expect(spread.confident).toBe(true);
    expect(spread.savingCurrency).toBe('RUB');
    expect(BigInt(spread.savingMinor)).toBeGreaterThan(0n);
  });

  test('повторный вход не удваивает данные', async () => {
    const first = anonymous();
    await expectOk(await first.post('/v1/demo/enter'));
    const before = await expectOk<{ transactions: unknown[] }>(await first.get('/v1/transactions'));

    const second = anonymous();
    await expectOk(await second.post('/v1/demo/enter'));
    const after = await expectOk<{ transactions: unknown[] }>(await second.get('/v1/transactions'));

    expect(after.transactions.length).toBe(before.transactions.length);
  });

  test('сброс возвращает демо к исходному виду', async () => {
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));
    const cats = await expectOk<{ id: string; name: string }[]>(await guest.get('/v1/categories'));
    const food = cats.find((c) => c.name === 'Groceries')!;
    await expectOk(
      await guest.post('/v1/transactions', {
        amountMinor: '999900',
        currency: 'RUB',
        categoryId: food.id,
        note: 'спонтанная трата смотрящего',
      }),
      201,
    );

    const dirty = await expectOk<{ transactions: { note: string | null }[] }>(
      await guest.get('/v1/transactions'),
    );
    expect(dirty.transactions.some((t) => t.note === 'спонтанная трата смотрящего')).toBe(true);

    await expectOk(await guest.post('/v1/demo/reset'));
    const clean = await expectOk<{ transactions: { note: string | null }[] }>(
      await guest.get('/v1/transactions'),
    );
    expect(clean.transactions.some((t) => t.note === 'спонтанная трата смотрящего')).toBe(false);
  });

  test('вход в демо не подменяет курсы другим воркспейсам', async () => {
    // Демо-курсы — личные курсы демо-воркспейса. Пока они лежали в глобальном fx_rates с
    // source=manual, вход в демо переопределял курс всем: транзакция в EUR считалась по демо-курсу
    // вместо котировки ЦБ (найдено адверсарным аудитом).
    const alice = await onboarded();
    const on = new Date().toISOString().slice(0, 10);
    await seedRate('EUR', 'RUB', '100.0000000000', on, 'cbr');

    await expectOk(await anonymous().post('/v1/demo/enter'));

    const tx = await expectOk<{ rate: string; rateSource: string; baseAmountMinor: string }>(
      await alice.post('/v1/transactions', { amountMinor: '10000', currency: 'EUR' }),
      201,
    );
    expect(tx.rateSource).toBe('cbr');
    // 100 EUR по курсу 100 = 10 000 RUB, а не 9 090 по демо-курсу 90.9.
    expect(tx.baseAmountMinor).toBe('1000000');
  });

  test('демо-сессия не видит чужой воркспейс', async () => {
    const alice = await onboarded();
    const created = await expectOk<{ id: string }>(
      await alice.post('/v1/transactions', { amountMinor: '123400', currency: 'RUB' }),
      201,
    );

    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));
    const list = await expectOk<{ transactions: { id: string }[] }>(
      await guest.get('/v1/transactions'),
    );
    expect(list.transactions.map((t) => t.id)).not.toContain(created.id);
    expect((await guest.del(`/v1/transactions/${created.id}`)).status).toBe(404);
  });

  test('сброс демо доступен только тому, кто уже в демо', async () => {
    /*
     * На публичном адресе (решение владельца 2026-08-02) ручка без проверки была бесплатным
     * генератором нагрузки: один POST переписывает всю демо-базу, а звать его мог кто угодно.
     */
    const stranger = anonymous();
    const denied = await stranger.post('/v1/demo/reset');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'demo_only' });

    // Обычный зарегистрированный пользователь — тоже не демо, и тоже не сбрасывает.
    const outsider = await onboarded();
    expect((await outsider.post('/v1/demo/reset')).status).toBe(403);

    // А тот, кто вошёл в демо, сбросить его может: это его же кабинет.
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));
    await expectOk(await guest.post('/v1/demo/reset'));
  });
});
