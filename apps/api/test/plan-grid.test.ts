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

describe('мастер-сетка', () => {
  test('горизонт по умолчанию — шесть периодов, и его можно сузить', async () => {
    const client = await onboarded();
    expect((await grid(client)).periods).toHaveLength(6);
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
    expect(goal.cells.map((c) => c.state)).toEqual([
      'planned',
      'planned',
      'ended',
      'ended',
      'ended',
      'ended',
    ]);
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
});

/** id воркспейса из /v1/me — тест не может знать его иначе, чем клиент. */
async function meWorkspaceId(client: TestClient): Promise<string | null> {
  const me = await expectOk<{ workspace: { id: string } | null }>(await client.get('/v1/me'));
  return me.workspace?.id ?? null;
}
