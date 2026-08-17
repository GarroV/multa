import { describe, expect, test } from 'vitest';
import { anonymous, categoryId, expectOk, onboarded, signedUp } from './client.ts';

/**
 * Метрики закрытой беты (Спринт 6).
 *
 * До них считать было нечем: флаг завершения онбординга вычислялся на лету и нигде не сохранялся,
 * поэтому брошенный на середине не отличался от «ещё не дошёл»; активность не писалась вовсе.
 *
 * Ручка нарочно скучная — три числа по своей же базе. Внешней аналитики нет и не будет: для трёх
 * чисел это чужие ключи, чужой договор и персональные данные наружу.
 */
interface MetricsDto {
  onboarding: { workspaces: number; completed: number; skipped: number };
  retention: { eligibleD7: number; returnedD7: number };
  rebalances: { applied: number; undone: number };
}

describe('метрики', () => {
  test('завершённый онбординг попадает в воронку', async () => {
    const before = await expectOk<MetricsDto>(await (await signedUp()).get('/v1/metrics'));
    const client = await onboarded();
    // Флаг ставится при чтении /v1/me — там же, где он считается.
    await expectOk(await client.get('/v1/me'));

    const after = await expectOk<MetricsDto>(await client.get('/v1/metrics'));
    expect(after.onboarding.workspaces).toBeGreaterThan(before.onboarding.workspaces);
    expect(after.onboarding.completed).toBeGreaterThan(before.onboarding.completed);
  });

  test('момент завершения не переписывается: иначе это не воронка', async () => {
    const client = await onboarded();
    await expectOk(await client.get('/v1/me'));
    const first = await expectOk<MetricsDto>(await client.get('/v1/metrics'));
    await expectOk(await client.get('/v1/me'));
    const second = await expectOk<MetricsDto>(await client.get('/v1/metrics'));
    // Повторное чтение не добавляет второго завершения тому же воркспейсу.
    expect(second.onboarding.completed).toBe(first.onboarding.completed);
  });

  test('свежий воркспейс не попадает в знаменатель D7', async () => {
    const before = await expectOk<MetricsDto>(await (await signedUp()).get('/v1/metrics'));
    const client = await onboarded();
    await expectOk(await client.get('/v1/plan/current'));
    const after = await expectOk<MetricsDto>(await client.get('/v1/metrics'));
    // Ему ещё нет недели: считать его «не вернувшимся» значило бы врать метрикой в свою пользу.
    expect(after.retention.eligibleD7).toBe(before.retention.eligibleD7);
  });

  test('без входа метрики не отдаются', async () => {
    const { app } = await import('../src/app.ts');
    expect((await app.request('http://localhost:3000/v1/metrics')).status).toBe(401);
  });
});

/*
 * Метрики — не для всех вошедших (найдено сверкой изоляции 17.08.2026).
 *
 * Комментарий над ручкой обещал: «только агрегаты и только владельцу СВОЕГО воркспейса — кроме
 * воронки, которая по природе кросс-аккаунтная». На деле кросс-аккаунтными были все три запроса,
 * включая пересборки. А сторожем стоял `requireAuth`, то есть числа читал любой вошедший — в том
 * числе гость демо, а вход в демо публичный по ссылке.
 *
 * Итог: сколько всего воркспейсов, сколько дошло до конца онбординга и сколько пересборок применено
 * — бизнес-числа основателя — были фактически открыты всем.
 */
describe('доступ к метрикам', () => {
  test('гость демо метрик не видит', async () => {
    const guest = anonymous();
    await expectOk(await guest.post('/v1/demo/enter'));
    const res = await guest.get('/v1/metrics');
    expect(res.status).toBe(403);
  });

  test('пересборки считаются по своему воркспейсу, а не по всем', async () => {
    /*
     * Чужая пересборка не должна попадать в мой счётчик. Проверяем ровно то, что обещал
     * комментарий: кросс-аккаунтна только воронка.
     */
    const other = await onboarded();
    const food = await categoryId(other, 'Продукты');
    await expectOk(
      await other.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '900000' }),
    );

    const mine = await onboarded();
    const metrics = await expectOk<MetricsDto>(await mine.get('/v1/metrics'));
    // У свежего воркспейса своих пересборок нет — сколько бы их ни было у соседей.
    expect(metrics.rebalances.applied).toBe(0);
  });
});
