import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, getPlan, listCategories, onboarded } from './client.ts';

/**
 * Чеки (Спринт 5). QR — бесплатный путь и пробуется первым; разбор сам ничего не записывает,
 * фактом чек становится только по подтверждению раскладки.
 */

interface QrResponse {
  receipt: { id: string; status: string; method: string };
  currency: string;
  totalMinor: string;
  confidence: string;
  split: { categoryId: string; amountMinor: string }[];
}

/** QR ФНС: сумма и дата прямо в payload, реквизиты обязательны — без них чек непроверяем. */
function fnsQr(sum: string, date = '20260715T1215'): string {
  return `t=${date}&s=${sum}&fn=9999078900012345&i=12345&fp=1234567890&n=1`;
}

describe('чеки по QR', () => {
  test('разбор QR отдаёт раскладку и сохраняет чек, но не создаёт трат', async () => {
    const client = await onboarded();
    const parsed = await expectOk<QrResponse>(
      await client.post('/v1/receipts/qr', { payload: fnsQr('1250.50') }),
      201,
    );

    expect(parsed.currency).toBe('RUB');
    expect(parsed.totalMinor).toBe('125050');
    // Позиций у ФНС-QR нет — вся сумма падает в системную «Общее» с низкой уверенностью.
    expect(parsed.split).toHaveLength(1);
    const general = (await listCategories(client)).find((c) => c.isSystem);
    expect(parsed.split[0]?.categoryId).toBe(general?.id);
    expect(parsed.split[0]?.amountMinor).toBe('125050');
    expect(parsed.confidence).not.toBe('high');

    const list = await expectOk<{ transactions: unknown[] }>(await client.get('/v1/transactions'));
    expect(list.transactions).toHaveLength(0);
  });

  test('не фискальный QR отклоняется, а не превращается в трату', async () => {
    const client = await onboarded();
    const res = await client.post('/v1/receipts/qr', { payload: 'https://example.com/promo' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'qr_not_recognized' });
  });

  test('подтверждение раскладки создаёт траты, повторное — не удваивает', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const parsed = await expectOk<QrResponse>(
      await client.post('/v1/receipts/qr', { payload: fnsQr('900.00') }),
      201,
    );
    const food = await categoryId(client, 'Продукты');
    const cafe = await categoryId(client, 'Кафе');

    const first = await expectOk<{ ok: boolean; transactions: number }>(
      await client.post(`/v1/receipts/${parsed.receipt.id}/confirm`, {
        split: [
          { categoryId: food, amountMinor: '60000' },
          { categoryId: cafe, amountMinor: '30000' },
        ],
      }),
    );
    expect(first.transactions).toBe(2);

    // Правка раскладки: было две строки, стала одна — старые траты чека переписываются.
    const second = await expectOk<{ transactions: number }>(
      await client.post(`/v1/receipts/${parsed.receipt.id}/confirm`, {
        split: [{ categoryId: food, amountMinor: '90000' }],
      }),
    );
    expect(second.transactions).toBe(1);

    const list = await expectOk<{ transactions: { amountMinor: string }[] }>(
      await client.get('/v1/transactions?from=2026-07-01&to=2026-08-01'),
    );
    expect(list.transactions).toHaveLength(1);
    expect(list.transactions[0]?.amountMinor).toBe('90000');
  });

  test('раскладка в чужую категорию отклоняется целиком', async () => {
    const client = await onboarded();
    const other = await onboarded();
    const parsed = await expectOk<QrResponse>(
      await client.post('/v1/receipts/qr', { payload: fnsQr('500.00') }),
      201,
    );

    const res = await client.post(`/v1/receipts/${parsed.receipt.id}/confirm`, {
      split: [
        { categoryId: await categoryId(client, 'Продукты'), amountMinor: '20000' },
        { categoryId: await categoryId(other, 'Кафе'), amountMinor: '30000' },
      ],
    });
    expect(res.status).toBe(404);

    // Ни одна строка не записалась: раскладка применяется целиком или никак.
    const list = await expectOk<{ transactions: unknown[] }>(
      await client.get('/v1/transactions?from=2026-07-01&to=2026-08-01'),
    );
    expect(list.transactions).toHaveLength(0);
  });

  test('отклонённая правка раскладки не стирает уже записанные траты', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const other = await onboarded();
    const parsed = await expectOk<QrResponse>(
      await client.post('/v1/receipts/qr', { payload: fnsQr('400.00') }),
      201,
    );
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.post(`/v1/receipts/${parsed.receipt.id}/confirm`, {
        split: [{ categoryId: food, amountMinor: '40000' }],
      }),
    );

    // Вторая попытка битая: чужая категория. Прежний факт должен уцелеть.
    const res = await client.post(`/v1/receipts/${parsed.receipt.id}/confirm`, {
      split: [{ categoryId: await categoryId(other, 'Кафе'), amountMinor: '40000' }],
    });
    expect(res.status).toBe(404);

    const list = await expectOk<{ transactions: { amountMinor: string }[] }>(
      await client.get('/v1/transactions?from=2026-07-01&to=2026-08-01'),
    );
    expect(list.transactions.map((t) => t.amountMinor)).toEqual(['40000']);
  });

  test('чужой чек подтвердить нельзя', async () => {
    const client = await onboarded();
    const other = await onboarded();
    const parsed = await expectOk<QrResponse>(
      await client.post('/v1/receipts/qr', { payload: fnsQr('700.00') }),
      201,
    );

    const res = await other.post(`/v1/receipts/${parsed.receipt.id}/confirm`, {
      split: [{ categoryId: await categoryId(other, 'Продукты'), amountMinor: '70000' }],
    });
    expect(res.status).toBe(404);
  });

  test('сербский QR без суммы требует её отдельно, а не выдумывает итог', async () => {
    const client = await onboarded();
    const url = 'https://suf.purs.gov.rs/v/?vl=A0ZLN1ZaTjdY';
    const res = await client.post('/v1/receipts/qr', { payload: url });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'total_unknown' });

    const withTotal = await expectOk<QrResponse>(
      await client.post('/v1/receipts/qr', { payload: url, totalMinor: '250000' }),
      201,
    );
    expect(withTotal.currency).toBe('RSD');
    expect(withTotal.totalMinor).toBe('250000');
  });

  test('фото чека без ключа OpenAI отвечает 422, а не молчит', async () => {
    const client = await onboarded();
    const res = await client.post('/v1/receipts/photo', {
      imageUrl: `data:image/png;base64,${'A'.repeat(64)}`,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'vision_failed' });
  });

  test('траты по чеку попадают в факт периода', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const plan = await getPlan(client);
    // Дата покупки внутри текущего периода: тогда чек виден в его факте.
    const day = plan.period.startsOn.replace(/-/g, '');
    const parsed = await expectOk<QrResponse>(
      await client.post('/v1/receipts/qr', { payload: fnsQr('300.00', `${day}T1000`) }),
      201,
    );
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.post(`/v1/receipts/${parsed.receipt.id}/confirm`, {
        split: [{ categoryId: food, amountMinor: '30000' }],
      }),
    );

    const after = await getPlan(client);
    expect(BigInt(after.spentLivingMinor)).toBe(30_000n);
  });
});
