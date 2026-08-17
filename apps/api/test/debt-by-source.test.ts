import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded, type TestClient } from './client.ts';

/**
 * Платёж по долгу, разный для разных выплат (запрос владельца 16.08.2026: «плачу я и с аванса и с
 * зарплаты… разные суммы»).
 *
 * До этого у долга было одно число на период. «5 000 с аванса, 15 000 с зарплаты» выразить было
 * нечем: ступени суммы меняют её с даты и навсегда, а не чередуют от выплаты к выплате.
 *
 * Проверяется сквозной путь — от заведения долга до цифры в плане и в мастер-таблице: именно там
 * расхождение и было бы заметно человеку, а не в чистой функции ядра.
 */

/** Воркспейс с двумя источниками: аванс 10-го, зарплата 25-го — ритм самого владельца. */
async function withTwoSources(): Promise<{
  client: TestClient;
  advanceId: string;
  salaryId: string;
}> {
  const client = await onboarded();
  /*
   * Заготовка создаёт зарплату дважды в месяц (10 и 25). Владельцу же приходит аванс 10-го и
   * зарплата 25-го — по одной выплате на период, и именно на таком ритме разбивка имеет смысл.
   * Без этой правки обе суммы складывались в первом периоде, и тест ловил бы не то.
   */
  const seeded = await expectOk<{ id: string; label: string }[]>(
    await client.get('/v1/income-sources'),
  );
  await expectOk(
    await client.patch(`/v1/income-sources/${seeded[0]!.id}`, {
      schedule: { kind: 'monthly-days', days: [25] },
    }),
  );
  await expectOk(
    await client.post('/v1/income-sources', {
      label: 'Аванс',
      currency: 'RUB',
      schedule: { kind: 'monthly-days', days: [10] },
      amount: { kind: 'absolute', amountMinor: '10000000' },
      stability: 'fixed',
    }),
    201,
  );
  const sources = await expectOk<{ id: string; label: string }[]>(
    await client.get('/v1/income-sources'),
  );
  return {
    client,
    advanceId: sources.find((s) => s.label === 'Аванс')!.id,
    salaryId: sources.find((s) => s.label === 'Зарплата')!.id,
  };
}

const debtIn = (plan: { allocations: { targetKind: string; plannedMinor: string }[] }) =>
  plan.allocations.find((a) => a.targetKind === 'debt')?.plannedMinor;

describe('платёж по долгу с разных выплат', () => {
  test('без разбивки долг платит одну и ту же сумму, как раньше', async () => {
    const { client } = await withTwoSources();
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Сбер',
        currency: 'RUB',
        principalMinor: '8000000',
        remainingMinor: '8000000',
        paymentMinor: '2000000',
      }),
      201,
    );
    expect(debtIn(await getPlan(client))).toBe('2000000');
  });

  test('с разбивкой в план попадает сумма той выплаты, что приходит в этом периоде', async () => {
    const { client, advanceId, salaryId } = await withTwoSources();
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Сбер',
        currency: 'RUB',
        principalMinor: '8000000',
        remainingMinor: '8000000',
        paymentMinor: '2000000',
        paymentsBySource: [
          { sourceId: advanceId, amountMinor: '500000' },
          { sourceId: salaryId, amountMinor: '1500000' },
        ],
      }),
      201,
    );

    /*
     * Считаем по мастер-таблице: у неё видны все периоды сразу, и по ним видно чередование —
     * ровно то, ради чего разбивка и заводилась. План проверяет ту же строку в текущем периоде.
     */
    const grid = await expectOk<{
      rows: { targetKind: string; cells: { minor: string }[] }[];
      groups: { kind: string; rows: { targetKind: string; cells: { minor: string }[] }[] }[];
    }>(await client.get('/v1/plan/grid?periods=4'));
    const debtRow = grid.groups.find((g) => g.kind === 'debt')?.rows[0];
    const amounts = debtRow?.cells.map((c) => c.minor) ?? [];

    // Ровно две разные суммы, и обе — заданные, а не общая 2 000 000.
    expect(new Set(amounts)).toEqual(new Set(['500000', '1500000']));
  });

  test('план и таблица показывают по долгу одно и то же число', async () => {
    /*
     * Второй раз наступать не будем: своя формула в сетке однажды уже развела план и таблицу по
     * цифре дня, и два экрана про одни деньги показывали разное.
     */
    const { client, advanceId, salaryId } = await withTwoSources();
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Сбер',
        currency: 'RUB',
        principalMinor: '8000000',
        remainingMinor: '8000000',
        paymentMinor: '2000000',
        paymentsBySource: [
          { sourceId: advanceId, amountMinor: '500000' },
          { sourceId: salaryId, amountMinor: '1500000' },
        ],
      }),
      201,
    );

    const plan = await getPlan(client);
    const grid = await expectOk<{
      groups: { kind: string; rows: { cells: { minor: string }[] }[] }[];
    }>(await client.get('/v1/plan/grid?periods=4'));
    const firstCell = grid.groups.find((g) => g.kind === 'debt')?.rows[0]?.cells[0]?.minor;

    expect(firstCell).toBe(debtIn(plan));
  });

  test('источник без своей суммы не платит: новый доход не начинает гасить долг сам', async () => {
    const { client, salaryId } = await withTwoSources();
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Сбер',
        currency: 'RUB',
        principalMinor: '8000000',
        remainingMinor: '8000000',
        paymentMinor: '2000000',
        paymentsBySource: [{ sourceId: salaryId, amountMinor: '1500000' }],
      }),
      201,
    );

    const grid = await expectOk<{
      groups: { kind: string; rows: { cells: { minor: string }[] }[] }[];
    }>(await client.get('/v1/plan/grid?periods=4'));
    const amounts = grid.groups.find((g) => g.kind === 'debt')?.rows[0]?.cells.map((c) => c.minor);

    // В авансовых периодах ноль, а не общая сумма платежа.
    expect(new Set(amounts)).toEqual(new Set(['0', '1500000']));
  });
});

/*
 * Разбивку должно быть можно задать СРАЗУ при заведении (замечание владельца 16.08.2026: «какой
 * долг на правку? как сразу задать-то?»).
 *
 * Иначе путь такой: завести долг с одной суммой, найти его в списке, открыть правку, разбить — и
 * всё это ради того, что человек знал с самого начала. Проверяем, что создание принимает разбивку
 * и она сразу работает в плане.
 */
test('разбивку можно задать сразу при заведении долга', async () => {
  const { client, advanceId, salaryId } = await withTwoSources();
  const created = await expectOk<{ id: string; paymentsBySource: unknown }>(
    await client.post('/v1/debts', {
      name: 'Сбер',
      currency: 'RUB',
      principalMinor: '8000000',
      remainingMinor: '8000000',
      paymentMinor: '0',
      paymentsBySource: [
        { sourceId: advanceId, amountMinor: '500000' },
        { sourceId: salaryId, amountMinor: '1500000' },
      ],
    }),
    201,
  );

  // Ответ на создание уже несёт разбивку: клиенту не нужен второй запрос, чтобы её увидеть.
  expect(created.paymentsBySource).toEqual([
    { sourceId: advanceId, amountMinor: '500000' },
    { sourceId: salaryId, amountMinor: '1500000' },
  ]);

  const plan = await getPlan(client);
  // Общий платёж нулевой, и без разбивки долг бы вовсе не попал в план.
  expect(debtIn(plan)).toBeDefined();
});

/*
 * Окно платежей (issue #117, вопрос владельца: «как выбрать период, допустим, что долг у меня в
 * плане с ноября по февраль?»).
 *
 * Проверяем сквозной путь: вне окна долг не берёт денег ни в плане, ни в мастер-таблице. Одного
 * теста ядра тут мало — расхождение между двумя экранами уже случалось.
 */
test('вне окна платежей долг не берёт денег ни в плане, ни в таблице', async () => {
  const { client } = await withTwoSources();
  const plan = await getPlan(client);
  // Окно целиком в прошлом: и текущий период, и все будущие колонки обязаны показать ноль.
  await expectOk(
    await client.post('/v1/debts', {
      name: 'Старый кредит',
      currency: 'RUB',
      principalMinor: '8000000',
      remainingMinor: '8000000',
      paymentMinor: '2000000',
      paysFrom: '2020-01-01',
      paysUntil: '2020-12-31',
    }),
    201,
  );

  expect(debtIn(await getPlan(client))).toBeUndefined();

  const grid = await expectOk<{
    groups: { kind: string; rows: { cells: { minor: string }[] }[] }[];
  }>(await client.get('/v1/plan/grid?periods=6'));
  const debtRows = grid.groups.find((g) => g.kind === 'debt')?.rows ?? [];
  for (const row of debtRows) {
    expect(new Set(row.cells.map((c) => c.minor))).toEqual(new Set(['0']));
  }
  expect(plan.period.startsOn > '2020-12-31').toBe(true);
});

test('внутри окна долг платит как обычно', async () => {
  const { client } = await withTwoSources();
  const plan = await getPlan(client);
  // Окно с запасом вокруг сегодняшнего периода: границы включительные, край не должен отсекать.
  await expectOk(
    await client.post('/v1/debts', {
      name: 'Сбер',
      currency: 'RUB',
      principalMinor: '8000000',
      remainingMinor: '8000000',
      paymentMinor: '2000000',
      paysFrom: plan.period.startsOn,
      paysUntil: '2030-12-31',
    }),
    201,
  );
  expect(debtIn(await getPlan(client))).toBe('2000000');
});

/*
 * Прогноз обязан считать платёж тем же правилом, что план и таблица.
 *
 * Найдено сверкой кода 17.08.2026, а не сообщением о баге: прогноз ходил через `amountOn` — то есть
 * знал про ступени суммы, но НЕ знал ни про разбивку по выплатам, ни про окно платежей, которые
 * появились сегодня. Значит «долг закроется через N периодов» считалось по платежу, которого в
 * этих периодах нет.
 *
 * Это ровно тот класс, что уже кусал дважды: два места считают одни деньги по-разному, и человек
 * не понимает, какой цифре верить.
 */
test('прогноз не обещает закрытия долга, который вне окна платежей', async () => {
  const { client } = await withTwoSources();
  await expectOk(
    await client.post('/v1/debts', {
      name: 'Старый кредит',
      currency: 'RUB',
      principalMinor: '8000000',
      remainingMinor: '8000000',
      paymentMinor: '2000000',
      paysFrom: '2020-01-01',
      paysUntil: '2020-12-31',
    }),
    201,
  );

  const forecast = await expectOk<{ events: { kind: string; name?: string }[] }>(
    await client.get('/v1/forecast'),
  );
  // Долг вне окна денег не берёт — обещать его закрытие нечем.
  expect(
    forecast.events.filter((e) => e.kind === 'debt_closed' && e.name === 'Старый кредит'),
  ).toEqual([]);
});

test('прогноз учитывает разбивку по выплатам, а не общую сумму', async () => {
  const { client, advanceId, salaryId } = await withTwoSources();
  await expectOk(
    await client.post('/v1/debts', {
      name: 'Сбер',
      currency: 'RUB',
      principalMinor: '4000000',
      remainingMinor: '4000000',
      // Общая сумма заведомо велика: если прогноз возьмёт её, закрытие выйдет намного раньше.
      paymentMinor: '4000000',
      paymentsBySource: [
        { sourceId: advanceId, amountMinor: '100000' },
        { sourceId: salaryId, amountMinor: '100000' },
      ],
    }),
    201,
  );

  const forecast = await expectOk<{ events: { kind: string; name?: string; date?: string }[] }>(
    await client.get('/v1/forecast'),
  );
  const closing = forecast.events.find((e) => e.kind === 'debt_closed' && e.name === 'Сбер');
  /*
   * 40 000 остатка по 1 000 за выплату — это двадцать периодов, то есть за горизонтом прогноза.
   * По общей сумме долг закрылся бы первым же платежом, и прогноз соврал бы в приятную сторону.
   */
  expect(closing, 'закрытие не должно попасть в горизонт').toBeUndefined();
});
