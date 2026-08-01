import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded, seedRate, type TestClient } from './client.ts';

/**
 * Сравнение провайдеров размена (issue #53).
 *
 * Продукт обещает две вещи: план по полумесяцам и «сколько ты теряешь на менялах». Вторая половина
 * без имени провайдера бесполезна: сумма потерь известна, а что с ней делать — нет. Поэтому «где
 * меняли» — отдельное поле, а ручка отвечает на единственный практический вопрос: у кого дешевле и
 * сколько дал бы переход.
 *
 * Дисциплина совета проверяется здесь же: один провайдер и единичная сделка совета не дают.
 */

interface ProviderDto {
  provider: string | null;
  deals: number;
  avgSpreadPct: number;
  volumeMinor: Record<string, string>;
  lostMinor: Record<string, string>;
}

interface SpreadDto {
  months: number;
  providers: ProviderDto[];
  best: ProviderDto | null;
  worst: ProviderDto | null;
  confident: boolean;
  savingMinor: string;
  savingCurrency: string | null;
}

async function periodStart(client: TestClient): Promise<string> {
  return (await getPlan(client)).period.startsOn;
}

/** Размен 100.00 EUR по заданному курсу: официальный — 100, поэтому спред задаётся суммой к выдаче. */
async function exchange(
  client: TestClient,
  on: string,
  toMinor: string,
  provider?: string,
): Promise<void> {
  await expectOk(
    await client.post('/v1/exchange-ops', {
      fromCurrency: 'EUR',
      toCurrency: 'RUB',
      fromMinor: '10000',
      toMinor,
      occurredOn: on,
      ...(provider ? { provider } : {}),
    }),
    201,
  );
}

describe('сравнение провайдеров размена', () => {
  test('провайдер сохраняется отдельным полем и виден в списке', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);
    await exchange(client, on, '950000', 'Меняльня у рынка');

    const list = await expectOk<{ ops: { provider: string | null; note: string | null }[] }>(
      await client.get('/v1/exchange-ops'),
    );
    expect(list.ops[0]?.provider).toBe('Меняльня у рынка');
    // Заметка осталась своей: провайдер её не занимает и не подменяет.
    expect(list.ops[0]?.note).toBeNull();
  });

  test('пустое поле означает «как обычно»: подставляется провайдер из настроек', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);
    await expectOk(
      await client.patch('/v1/workspace/settings', { currency: { defaultProvider: 'Wise' } }),
    );

    await exchange(client, on, '950000');
    const list = await expectOk<{ ops: { provider: string | null }[] }>(
      await client.get('/v1/exchange-ops'),
    );
    expect(list.ops[0]?.provider).toBe('Wise');
  });

  test('у кого дешевле и сколько дал бы переход — по факту сделок', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);

    // Меняльня: 1% потери на каждой из двух сделок. Банк: 3% на каждой из двух.
    await exchange(client, on, '990000', 'Меняльня');
    await exchange(client, on, '990000', 'Меняльня');
    await exchange(client, on, '970000', 'Банк');
    await exchange(client, on, '970000', 'Банк');

    const spread = await expectOk<SpreadDto>(await client.get('/v1/analytics/spread'));
    expect(spread.best?.provider).toBe('Меняльня');
    expect(spread.worst?.provider).toBe('Банк');
    expect(spread.confident).toBe(true);
    // Банку отдали 200.00 EUR с разницей 2 п.п. → переход сберёг бы 4.00 EUR.
    expect(spread.savingCurrency).toBe('EUR');
    expect(spread.savingMinor).toBe('400');
    const bank = spread.providers.find((p) => p.provider === 'Банк')!;
    expect(bank.deals).toBe(2);
    expect(bank.lostMinor.RUB).toBe('60000');
  });

  test('единичная сделка разницу показывает, но совета не даёт', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);
    await exchange(client, on, '990000', 'Меняльня');
    await exchange(client, on, '970000', 'Банк');

    const spread = await expectOk<SpreadDto>(await client.get('/v1/analytics/spread'));
    expect(spread.best?.provider).toBe('Меняльня');
    // Один поход к каждому — это случай, а не привычка: интерфейс совет не покажет.
    expect(spread.confident).toBe(false);
  });

  test('один провайдер — сравнивать не с чем', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);
    await exchange(client, on, '990000', 'Меняльня');
    await exchange(client, on, '985000', 'Меняльня');

    const spread = await expectOk<SpreadDto>(await client.get('/v1/analytics/spread'));
    expect(spread.providers).toHaveLength(1);
    expect(spread.best).toBeNull();
    expect(spread.savingMinor).toBe('0');
  });

  test('сделки вне горизонта в сравнение не попадают', async () => {
    const client = await onboarded();
    const on = await periodStart(client);
    await seedRate('EUR', 'RUB', '100', on);
    // 13 месяцев назад: заведомо за горизонтом полугода и заведомо внутри двухлетнего.
    const [y, m, d] = on.split('-').map(Number) as [number, number, number];
    const longAgo = new Date(Date.UTC(y, m - 1 - 13, d)).toISOString().slice(0, 10);
    await seedRate('EUR', 'RUB', '100', longAgo);

    await exchange(client, longAgo, '900000', 'Забытый обменник');
    await exchange(client, on, '990000', 'Меняльня');
    await exchange(client, on, '990000', 'Меняльня');

    const spread = await expectOk<SpreadDto>(await client.get('/v1/analytics/spread?months=6'));
    expect(spread.providers.map((p) => p.provider)).toEqual(['Меняльня']);
    // Тот же запрос с широким горизонтом старую сделку видит: дело в окне, а не в потере данных.
    const wide = await expectOk<SpreadDto>(await client.get('/v1/analytics/spread?months=24'));
    expect(wide.providers.map((p) => p.provider)).toContain('Забытый обменник');
  });

  test('чужие размены в сравнение не попадают', async () => {
    const alice = await onboarded();
    const bob = await onboarded();
    const on = await periodStart(alice);
    await seedRate('EUR', 'RUB', '100', on);
    await exchange(alice, on, '990000', 'Меняльня');
    await exchange(alice, on, '990000', 'Меняльня');

    const spread = await expectOk<SpreadDto>(await bob.get('/v1/analytics/spread'));
    expect(spread.providers).toHaveLength(0);
    expect(spread.best).toBeNull();
  });

  test('горизонт вне допустимого отклоняется, а не молча подменяется', async () => {
    const client = await onboarded();
    expect((await client.get('/v1/analytics/spread?months=0')).status).toBe(400);
    expect((await client.get('/v1/analytics/spread?months=99')).status).toBe(400);
  });
});
