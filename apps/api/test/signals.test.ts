import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, getPlan, onboarded, signedUp, type TestClient } from './client.ts';

/**
 * Сигналы как сущность (issue #50).
 *
 * Ручка проверяется на два обещания: у каждого сигнала есть действие (иначе это шум) и цифры в
 * нём — те же, что на экранах. Расхождение здесь опаснее отсутствия сигнала: список «что делать
 * сейчас», который спорит с планом, обесценивает оба.
 */

interface SignalDto {
  id: string;
  rule: string;
  severity: 'risk' | 'attention' | 'opportunity';
  metric: { kind: string; [k: string]: unknown };
  params: Record<string, string | number>;
  targetId: string | null;
  targetName: string | null;
  actions: { kind: string; [k: string]: unknown }[];
}

const signalsOf = async (client: TestClient): Promise<SignalDto[]> =>
  (await expectOk<{ signals: SignalDto[] }>(await client.get('/v1/signals'))).signals;

/** Трата в текущем периоде: факт нужен, чтобы у сигналов появилась причина. */
async function spend(client: TestClient, categoryName: string, minor: string): Promise<void> {
  const id = await categoryId(client, categoryName);
  await expectOk(
    await client.post('/v1/transactions', {
      kind: 'expense',
      targetKind: 'category',
      targetId: id,
      amountMinor: minor,
      currency: 'RUB',
    }),
    201,
  );
}

describe('сигналы', () => {
  test('спокойный период не выдумывает тревог', async () => {
    const client = await onboarded();
    expect(await signalsOf(client)).toEqual([]);
  });

  test('у каждого сигнала есть правило, метрика и хотя бы одно действие', async () => {
    /*
     * Это и есть суть issue: раньше «сигналы» были подписями без кнопок. Сигнал без действия
     * сообщает о проблеме и оставляет человека с ней один на один.
     */
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '500000' }),
    );
    await spend(client, 'Продукты', '900000');

    const signals = await signalsOf(client);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.rule).toBeTruthy();
      expect(signal.metric.kind).toBeTruthy();
      expect(signal.actions.length).toBeGreaterThan(0);
    }
  });

  test('перерасход приходит суммой, совпадающей с планом', async () => {
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '500000' }),
    );
    // Доход периода 300 000 ₽: чтобы пробить план на жизнь, надо потратить больше него целиком.
    await spend(client, 'Продукты', '31000000');

    const plan = await getPlan(client);
    const overspent = (await signalsOf(client)).find((s) => s.rule === 'overspent');
    // Цифра сигнала обязана совпасть с цифрой плана: два ответа на один вопрос — это ноль ответов.
    expect(overspent?.metric).toMatchObject({ minor: plan.overspentMinor, currency: 'RUB' });
    expect(overspent?.severity).toBe('risk');
  });

  test('сигнал не несёт готового текста — только правило и параметры', async () => {
    // Текст собирается словарём (правило 5): строка с сервера проехала бы мимо i18n.
    const client = await onboarded();
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '500000' }),
    );
    await spend(client, 'Продукты', '31000000');

    const signals = await signalsOf(client);
    for (const signal of signals) {
      expect(Object.keys(signal)).not.toContain('title');
      expect(Object.keys(signal)).not.toContain('text');
    }
  });

  test('порог доли зафиксированного берётся из настроек, а не из константы', async () => {
    const client = await onboarded();
    // Конверт на 20% дохода: при пороге 60% молчим, при пороге 10% — сигналим.
    await expectOk(
      await client.post('/v1/envelopes', {
        name: 'Подушка',
        currency: 'RUB',
        ruleKind: 'percent',
        ruleValue: '20',
      }),
      201,
    );

    expect((await signalsOf(client)).some((s) => s.rule === 'locked_share')).toBe(false);
    await expectOk(
      await client.patch('/v1/workspace/settings', { signals: { lockedWarnPct: 10 } }),
    );
    const locked = (await signalsOf(client)).find((s) => s.rule === 'locked_share');
    expect(locked?.metric).toMatchObject({ kind: 'percent' });
  });

  test('лимит сигналов из настроек соблюдается', async () => {
    const client = await onboarded();
    await expectOk(await client.patch('/v1/workspace/settings', { signals: { maxSignals: 3 } }));
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '500000' }),
    );
    await spend(client, 'Продукты', '31000000');
    expect((await signalsOf(client)).length).toBeLessThanOrEqual(3);
  });

  test('чужие сигналы не видны', async () => {
    const alice = await onboarded();
    const food = await categoryId(alice, 'Продукты');
    await expectOk(
      await alice.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '500000' }),
    );
    await spend(alice, 'Продукты', '31000000');
    expect((await signalsOf(alice)).length).toBeGreaterThan(0);

    const bob = await onboarded();
    expect(await signalsOf(bob)).toEqual([]);
  });

  test('без завершённого онбординга ручка отвечает 409, а не пустым списком', async () => {
    // Пустой список означал бы «всё в порядке», а на самом деле плана ещё нет вовсе.
    const client = await signedUp();
    await expectOk(await client.post('/v1/workspace', { baseCurrency: 'RUB' }), 201);
    const res = await client.get('/v1/signals');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'onboarding_incomplete' });
  });
});
