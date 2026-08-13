import { describe, expect, test } from 'vitest';
import { expectOk, onboarded } from './client.ts';

/**
 * «Сегодня» приходит с сервера (#109).
 *
 * Клиент вычислял дату сам через `toISOString()` — это UTC, а сервер живёт по таймзоне воркспейса.
 * Между местной полуночью и смещением зоны они расходились на день: трата, введённая ночью,
 * попадала во вчерашний день, а на стыке полумесяцев — в предыдущий период, и цифра дня считалась
 * не там. Нашлось разбором красного CI, который шёл в 22:48 UTC (00:48 в Белграде).
 */
describe('дата «сегодня»', () => {
  test('/v1/me отдаёт дату в таймзоне воркспейса', async () => {
    const client = await onboarded({ timezone: 'Pacific/Kiritimati' });
    const me = await expectOk<{ today: string; workspace: { timezone: string } }>(
      await client.get('/v1/me'),
    );
    expect(me.workspace.timezone).toBe('Pacific/Kiritimati');
    // UTC+14: там уже наступил следующий день относительно UTC почти половину суток.
    const utcToday = new Date().toISOString().slice(0, 10);
    const kiritimati = new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);
    expect(me.today).toBe(kiritimati);
    // Проверка осмысленна только в те часы, когда даты расходятся; иначе просто равенство.
    if (kiritimati !== utcToday) expect(me.today).not.toBe(utcToday);
  });

  test('трата без даты датируется сервером, а не клиентом', async () => {
    const client = await onboarded({ timezone: 'Pacific/Kiritimati', payoutMinor: '30000000' });
    const me = await expectOk<{ today: string }>(await client.get('/v1/me'));
    const tx = await expectOk<{ occurredOn: string }>(
      await client.post('/v1/transactions', { amountMinor: '100000', currency: 'RUB' }),
      201,
    );
    expect(tx.occurredOn).toBe(me.today);
  });
});
