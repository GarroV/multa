import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded, seedRate, type TestClient } from './client.ts';

/**
 * Размен валюты со спредом (Спринт 3): пользователь вводит обе стороны сделки, ядро считает
 * фактический курс и потерю против официального. Официальный курс кладётся снапшотом рядом —
 * история не пересчитывается, даже если котировку потом уточнят (правило 2).
 */

interface OpDto {
  id: string;
  actualRate: string;
  officialRate: string | null;
  officialSource: string | null;
  spreadPct: string | null;
  spreadMinor: string | null;
}

async function periodStart(client: TestClient): Promise<string> {
  return (await getPlan(client)).period.startsOn;
}

describe('размен валюты', () => {
  test('спред считается против официального курса', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);

    // Отдал 100.00 EUR, получил 9 500.00 RUB: обменник дал 95 вместо 100 → потеря 500.00 RUB.
    const op = await expectOk<OpDto>(
      await client.post('/v1/exchange-ops', {
        fromCurrency: 'EUR',
        toCurrency: 'RUB',
        fromMinor: '10000',
        toMinor: '950000',
        occurredOn: on,
      }),
      201,
    );

    expect(Number(op.actualRate)).toBe(95);
    expect(Number(op.officialRate)).toBe(100);
    expect(op.officialSource).toBe('cbr');
    expect(op.spreadMinor).toBe('50000');
    expect(Number(op.spreadPct)).toBeCloseTo(5, 5);
  });

  test('без официального курса размен пишется, но потеря не выдумывается', async () => {
    const client = await onboarded();
    const op = await expectOk<OpDto>(
      await client.post('/v1/exchange-ops', {
        fromCurrency: 'JPY',
        toCurrency: 'KRW',
        fromMinor: '10000',
        toMinor: '900000',
      }),
      201,
    );

    expect(op.officialRate).toBeNull();
    expect(op.spreadMinor).toBeNull();
    expect(op.spreadPct).toBeNull();
  });

  test('копилка потерь суммирует спред по валюте получения', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);

    for (const toMinor of ['950000', '960000']) {
      await expectOk(
        await client.post('/v1/exchange-ops', {
          fromCurrency: 'EUR',
          toCurrency: 'RUB',
          fromMinor: '10000',
          toMinor,
          occurredOn: on,
        }),
        201,
      );
    }

    const list = await expectOk<{ totalLost: { currency: string; minor: string }[] }>(
      await client.get('/v1/exchange-ops'),
    );
    expect(list.totalLost).toEqual([{ currency: 'RUB', minor: '90000' }]);
  });

  test('размен валюты в саму себя отклоняется', async () => {
    const client = await onboarded();
    const res = await client.post('/v1/exchange-ops', {
      fromCurrency: 'RUB',
      toCurrency: 'RUB',
      fromMinor: '10000',
      toMinor: '10000',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'same_currency' });
  });

  test('нулевая сторона сделки отклоняется валидацией', async () => {
    const client = await onboarded();
    const res = await client.post('/v1/exchange-ops', {
      fromCurrency: 'EUR',
      toCurrency: 'RUB',
      fromMinor: '0',
      toMinor: '950000',
    });
    expect(res.status).toBe(400);
  });

  test('чужой размен не виден и не удаляется', async () => {
    const alice = await onboarded();
    const bob = await onboarded();
    const op = await expectOk<OpDto>(
      await alice.post('/v1/exchange-ops', {
        fromCurrency: 'EUR',
        toCurrency: 'RUB',
        fromMinor: '10000',
        toMinor: '950000',
      }),
      201,
    );

    const bobList = await expectOk<{ ops: OpDto[] }>(await bob.get('/v1/exchange-ops'));
    expect(bobList.ops.map((o) => o.id)).not.toContain(op.id);
    expect((await bob.del(`/v1/exchange-ops/${op.id}`)).status).toBe(404);
    expect((await alice.del(`/v1/exchange-ops/${op.id}`)).status).toBe(204);
  });
});

describe('курсы', () => {
  test('кросс-курс выводится из котировок к базе источника', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);
    await seedRate('USD', 'RUB', '80', on);

    const snap = await expectOk<{ rate: string; from: string; to: string }>(
      await client.get(`/v1/fx/rate?from=EUR&to=USD&on=${on}`),
    );
    expect(Number(snap.rate)).toBeCloseTo(1.25, 6);
  });

  test('курса нет — честный 404, а не курс 1:1', async () => {
    const client = await onboarded();
    const res = await client.get('/v1/fx/rate?from=JPY&to=KRW&on=2020-01-15');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'rate_unavailable' });
  });
});

describe('корзина в размене (находка аудита)', () => {
  test('чужую корзину привязать нельзя, и её удаление не блокируется', async () => {
    const alice = await onboarded();
    const bob = await onboarded();
    const bucket = await expectOk<{ id: string }>(
      await bob.post('/v1/buckets', {
        name: 'Евро на лето',
        fromCurrency: 'RUB',
        toCurrency: 'EUR',
        amountMinor: '10000000',
      }),
      201,
    );

    // Клиент присылает id корзины сам — принадлежность обязан проверять сервер (правило 7).
    const res = await alice.post('/v1/exchange-ops', {
      fromCurrency: 'RUB',
      toCurrency: 'EUR',
      fromMinor: '1000000',
      toMinor: '10000',
      bucketId: bucket.id,
    });
    expect(res.status).toBe(404);

    // Владельцу корзина по-прежнему доступна: чужая ссылка не появилась и FK её не держит.
    expect((await bob.del(`/v1/buckets/${bucket.id}`)).status).toBe(204);
    const left = await expectOk<{ id: string }[]>(await bob.get('/v1/buckets'));
    expect(left.map((b) => b.id)).not.toContain(bucket.id);
  });
});
