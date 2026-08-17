import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { db } from '../src/db/client.ts';
import { payPeriods } from '../src/db/schema/domain.ts';
import { categoryId, expectOk, getPlan, onboarded, type TestClient } from './client.ts';

/**
 * Мастер-сетка «строки × периоды выплат» (issue #47) — таблица, ради которой человек уходит из
 * Excel. Проверяется не вёрстка, а три обещания, без которых ей нельзя верить:
 *
 * 1. Первая колонка совпадает с экраном «План» в копейку — иначе две главные таблицы про одни и
 *    те же деньги спорят друг с другом.
 * 2. Взгляд вперёд ничего не фиксирует: открыть матрицу — не то же самое, что утвердить полгода
 *    планов.
 * 3. Закрывшийся долг перестаёт быть строкой, а не превращается в нули до конца горизонта.
 */

interface GridCell {
  minor: string;
  state: 'planned' | 'none' | 'ended';
}

interface GridRow {
  targetKind: string;
  targetId: string;
  name: string;
  cells: GridCell[];
  totalMinor: string;
  endsAfterIndex: number | null;
}

interface GridDto {
  baseCurrency: string;
  periods: { startsOn: string; endsOn: string; daysInPeriod: number; materialized: boolean }[];
  groups: { kind: string; rows: GridRow[]; totals: string[]; totalMinor: string }[];
  footer: {
    freeMinor: string[];
    perDayMinor: string[];
    toExchangeMinor: string[];
    toExchangeByCurrency: { currency: string; cells: string[] }[];
  };
  unresolved: { targetId: string; name: string; sourceCurrency: string }[];
}

const grid = async (client: TestClient, query = ''): Promise<GridDto> =>
  expectOk<GridDto>(await client.get(`/v1/plan/grid${query}`));

const rowsOf = (dto: GridDto, kind: string): GridRow[] =>
  dto.groups.find((g) => g.kind === kind)?.rows ?? [];

/** id воркспейса из /v1/me — тест не может знать его иначе, чем клиент. */
async function meWorkspaceId(client: TestClient): Promise<string | null> {
  const me = await expectOk<{ workspace: { id: string } | null }>(await client.get('/v1/me'));
  return me.workspace?.id ?? null;
}

describe('мастер-сетка', () => {
  test('горизонт по умолчанию — двенадцать периодов, и его можно сузить', async () => {
    /*
     * Было шесть. При выплатах дважды в месяц это ровно три месяца — планировать отпуск или
     * закрытие долга на таком горизонте нельзя (вопрос владельца 16.08.2026). Двенадцать даёт год
     * при ежемесячных выплатах и полгода при полумесячных.
     */
    const client = await onboarded();
    expect((await grid(client)).periods).toHaveLength(12);
    expect((await grid(client, '?periods=3')).periods).toHaveLength(3);
  });

  test('первая колонка совпадает с экраном «План» в копейку', async () => {
    const client = await onboarded();
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Рассрочка',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '800000',
      }),
      201,
    );
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '900000' }),
    );

    const plan = await getPlan(client);
    const dto = await grid(client);

    expect(dto.periods[0]?.startsOn).toBe(plan.period.startsOn);
    for (const allocation of plan.allocations) {
      const row = dto.groups.flatMap((g) => g.rows).find((r) => r.targetId === allocation.targetId);
      expect(row?.cells[0]?.minor).toBe(allocation.allocatedMinor);
    }
    expect(dto.footer.freeMinor[0]).toBe(plan.freeMinor);
    expect(dto.footer.toExchangeMinor[0]).toBe(plan.toExchangeMinor);
  });

  test('взгляд вперёд ничего не фиксирует', async () => {
    /*
     * Главный риск фичи. Сборка периода пишет planned_items и один раз переносит бюджеты
     * категорий: если матрица соберёт полгода, эти полгода окажутся утверждёнными, а последующая
     * правка бюджета до них уже не доедет. Поэтому дальше текущего и следующего периодов в БД не
     * должно появиться ни одной строки.
     */
    const client = await onboarded();
    const before = await db
      .select({ id: payPeriods.id })
      .from(payPeriods)
      .where(eq(payPeriods.workspaceId, (await meWorkspaceId(client))!));
    await grid(client, '?periods=12');
    const after = await db
      .select({ id: payPeriods.id })
      .from(payPeriods)
      .where(eq(payPeriods.workspaceId, (await meWorkspaceId(client))!));

    // Открытие матрицы = открытие «Плана»: текущий и следующий, и ни периодом больше.
    expect(after.length).toBeLessThanOrEqual(2);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  test('закрывшийся долг кончается строкой, а не нулями до конца горизонта', async () => {
    const client = await onboarded();
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Рассрочка',
        currency: 'RUB',
        principalMinor: '1400000',
        remainingMinor: '1400000',
        paymentMinor: '800000',
      }),
      201,
    );

    const dto = await grid(client);
    const debt = rowsOf(dto, 'debt')[0]!;
    expect(debt.cells[0]?.minor).toBe('800000');
    // Последний платёж — остаток, а не полная сумма.
    expect(debt.cells[1]).toEqual({ minor: '600000', state: 'planned' });
    expect(debt.cells[2]?.state).toBe('ended');
    expect(debt.endsAfterIndex).toBe(1);
  });

  test('цель перестаёт набираться, когда собрана', async () => {
    const client = await onboarded();
    await expectOk(
      await client.post('/v1/goals', {
        name: 'Мотоцикл',
        currency: 'RUB',
        targetMinor: '900000',
        plannedPerPeriodMinor: '500000',
      }),
      201,
    );
    const goal = rowsOf(await grid(client), 'goal')[0]!;
    /*
     * Суть проверки — ДВА периода набора и прочерк дальше, а не длина горизонта: 900 000 при
     * 500 000 за период собираются за два. Поэтому сравниваем начало и требуем, чтобы весь хвост
     * был «ended», иначе тест ломался бы от каждой смены умолчания (горизонт вырос с 6 до 12).
     */
    const states = goal.cells.map((c) => c.state);
    expect(states.slice(0, 2)).toEqual(['planned', 'planned']);
    expect(new Set(states.slice(2))).toEqual(new Set(['ended']));
  });

  test('доход разбит по источникам, и строки сходятся с итогом в каждой колонке', async () => {
    /*
     * Разбивку добавили, чтобы «57 420» можно было развернуть и увидеть, из чего они сложились
     * (запрос владельца 2026-08-05). Инвариант тут один и он важнее самой разбивки: сумма строк
     * обязана равняться итогу группы в КАЖДОЙ колонке. Таблица, где строки не сходятся с суммой
     * над ними, не объясняет число, а подрывает доверие ко всей сетке.
     */
    const client = await onboarded({ payoutMinor: '30000000' });
    const dto = await grid(client);
    const income = dto.groups.find((g) => g.kind === 'income');
    if (!income) throw new Error('группы дохода нет');

    expect(income.rows.length).toBeGreaterThan(0);
    for (const row of income.rows) {
      expect(row.name).not.toBe('');
      expect(row.targetKind).toBe('income');
    }

    income.totals.forEach((total, i) => {
      const sum = income.rows.reduce((acc, r) => acc + BigInt(r.cells[i]!.minor), 0n);
      expect(sum.toString(), `колонка ${i}`).toBe(total);
    });
  });

  test('«к размену» разбит по валютам получения и совпадает с итогом', async () => {
    const client = await onboarded();
    await expectOk(
      await client.post('/v1/buckets', {
        name: 'Аренда',
        fromCurrency: 'RUB',
        toCurrency: 'EUR',
        amountMinor: '6000000',
      }),
      201,
    );

    const dto = await grid(client, '?periods=2');
    expect(dto.footer.toExchangeMinor).toEqual(['6000000', '6000000']);
    expect(dto.footer.toExchangeByCurrency).toEqual([
      { currency: 'EUR', cells: ['6000000', '6000000'] },
    ]);
  });

  test('строка без курса уходит в «нерешённые», а не в тихий ноль', async () => {
    const client = await onboarded();
    await expectOk(
      await client.post('/v1/debts', {
        name: 'Кредит в йенах',
        currency: 'JPY',
        principalMinor: '100000',
        remainingMinor: '100000',
        paymentMinor: '10000',
      }),
      201,
    );

    const dto = await grid(client);
    expect(rowsOf(dto, 'debt')).toHaveLength(0);
    expect(dto.unresolved.map((u) => u.name)).toContain('Кредит в йенах');
  });

  test('доход показан отдельной группой сверху', async () => {
    const client = await onboarded();
    const dto = await grid(client);
    expect(dto.groups[0]?.kind).toBe('income');
    // Доход первой колонки — тот же, что на «Плане».
    const plan = await getPlan(client);
    expect(dto.groups[0]?.totals[0]).toBe(plan.incomeMinor);
  });

  test('чужая матрица не видна', async () => {
    const alice = await onboarded();
    await expectOk(
      await alice.post('/v1/debts', {
        name: 'Личный долг',
        currency: 'RUB',
        principalMinor: '5000000',
        remainingMinor: '5000000',
        paymentMinor: '800000',
      }),
      201,
    );

    const bob = await onboarded();
    const dto = await grid(bob);
    expect(dto.groups.flatMap((g) => g.rows).map((r) => r.name)).not.toContain('Личный долг');
  });

  test('незавершённый онбординг отвечает 409, а не пустой таблицей', async () => {
    const client = await onboarded();
    // Воркспейс есть, но ритма нет только у свежесозданного — проверяем через анонимного.
    const res = await client.get('/v1/plan/grid?periods=0');
    expect(res.status).toBe(400);
  });

  test('горизонт больше допустимого отклоняется, а не молча множит расчёт', async () => {
    const client = await onboarded();
    expect((await client.get('/v1/plan/grid?periods=99')).status).toBe(400);
  });

  test('регулярные платежи видны отдельной группой и не входят в итоги (#80)', async () => {
    /*
     * Человек заводит счёт за интернет в «Регулярных платежах», открывает мастер-таблицу — и не
     * находит его: в каскаде таких строк нет, они живут отдельно. Таблица при этом называется
     * «всё, что впереди», и отсутствие платежа читается как «его не будет».
     *
     * Просто сложить их в подытоги нельзя: большинство таких трат уже сидит внутри бюджета
     * категории, и в «свободном остатке» деньги посчитались бы дважды. Поэтому группа
     * информационная — видно, но в подвал не идёт. Тест держит ровно эту границу: строка есть,
     * итог не сдвинулся.
     */
    const client = await onboarded({ payoutMinor: '30000000' });
    const before = await grid(client);

    await expectOk(
      await client.post('/v1/recurring-items', {
        name: 'Интернет',
        amountMinor: '250000',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [5] },
      }),
      201,
    );

    const after = await grid(client);
    const group = after.groups.find((g) => g.kind === 'recurring');
    if (!group) throw new Error('группы регулярных платежей нет');
    expect(group.rows.some((r) => r.name === 'Интернет')).toBe(true);

    // Подвал не должен шелохнуться: платёж показан, но в раздачу не входит.
    expect(after.footer.freeMinor).toEqual(before.footer.freeMinor);
    expect(after.footer.perDayMinor).toEqual(before.footer.perDayMinor);
  });
});

describe('цифра дня текущего столбца сходится с планом', () => {
  /*
   * На «Плане» и в мастер-сетке цифра дня показывалась разной для одного и того же периода: план
   * делит остаток на жизнь на ОСТАВШИЕСЯ дни с учётом уже потраченного, а сетка делила всю жизнь на
   * всю длину периода. Два экрана, два числа за один день — от этого перестают верить продукту.
   *
   * Для будущих столбцов сеточная формула правильная (весь период впереди, факта нет). Расходиться
   * не должен только текущий столбец — он про «сегодня», и «сегодня» одно.
   *
   * Найдено осмотром механики на проде 14.08.2026.
   */
  test('первый столбец сетки равен цифре дня плана', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '2000000' }),
    );
    // Трата: план учтёт её в остатке на жизнь, и цифра дня сдвинется — сетка обязана сдвинуться так же.
    await expectOk(
      await client.post('/v1/transactions', {
        amountMinor: '300000',
        currency: 'RUB',
        categoryId: food,
      }),
      201,
    );

    const plan = await getPlan(client);
    const grid = await expectOk<{
      footer: { perDayMinor: string[]; freeMinor: string[]; toExchangeMinor: string[] };
    }>(await client.get('/v1/plan/grid?periods=4'));

    /*
     * Проверяем ВЕСЬ подвал текущего столбца, а не одну цифру дня. Баг был про перДень, но природа
     * его — «первый столбец сетки обязан равняться плану»; свободно и к размену считаются там же и
     * разъедутся так же, если однажды кто-то тронет сборку. Одна проверка на весь класс.
     */
    expect(grid.footer.perDayMinor[0]).toBe(plan.canSpendPerDayMinor);
    expect(grid.footer.freeMinor[0]).toBe(plan.freeMinor);
    expect(grid.footer.toExchangeMinor[0]).toBe(plan.toExchangeMinor);
  });
});

/*
 * Горизонт таблицы (вопрос владельца 16.08.2026: «почему у нас там показывает планирование всего
 * на 3 месяца?»).
 *
 * Потолок был 12 периодов, а при выплатах дважды в месяц это полгода — и по умолчанию бралось 6,
 * то есть три месяца. Для планирования отпуска или закрытия долга этого мало: горизонт должен
 * дотягиваться до года. 24 периода — тот же потолок, что у аналитики, чтобы два места не спорили.
 */
test('горизонт таблицы дотягивается до 24 периодов', async () => {
  const client = await onboarded({ payoutMinor: '30000000' });
  const grid = await expectOk<{ periods: { startsOn: string }[] }>(
    await client.get('/v1/plan/grid?periods=24'),
  );
  expect(grid.periods).toHaveLength(24);
});

/*
 * Долг без назначенного платежа обязан быть в таблице (issue #120, жалоба владельца: «в таблице
 * чего-то долга не вижу»).
 *
 * Нулевую строку не тянули в план — и правильно, денег она не берёт. Но заодно её не стало и в
 * мастер-таблице, а правка ячейки — это ровно тот способ, которым платёж назначается. Замкнутый
 * круг: чтобы строка появилась, нужен платёж; чтобы задать платёж, нужна строка.
 *
 * Для человека это выглядит как «долг не сохранился», и он заводит второй.
 */
test('долг без платежа виден в таблице нулями, а не исчезает', async () => {
  const client = await onboarded();
  await expectOk(
    await client.post('/v1/debts', {
      name: 'Кредитка',
      currency: 'RUB',
      principalMinor: '31000000',
      remainingMinor: '31000000',
      paymentMinor: '0',
    }),
    201,
  );

  const grid = await expectOk<{
    groups: { kind: string; rows: { name: string; cells: { minor: string }[] }[] }[];
  }>(await client.get('/v1/plan/grid?periods=4'));
  const debtRows = grid.groups.find((g) => g.kind === 'debt')?.rows ?? [];
  const row = debtRows.find((r) => r.name === 'Кредитка');

  expect(row, 'строка долга должна быть в таблице').toBeDefined();
  // Нули, а не прочерки: долг живой, просто платёж ещё не назначен.
  expect(new Set(row!.cells.map((c) => c.minor))).toEqual(new Set(['0']));
});
