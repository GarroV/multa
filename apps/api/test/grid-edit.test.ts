import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, onboarded, seedRate, signedUp, type TestClient } from './client.ts';

/**
 * Правка ячейки мастер-сетки (запрос владельца 13.08.2026: «в режиме таблицы должна быть
 * возможность редактировать поля, и чтобы оттуда шло распределение обратно»).
 *
 * Главное, что здесь проверяется, — разная природа чисел в одной таблице:
 * бюджет категории живёт на периоде и правка меняет ОДИН столбец; платёж долга живёт на сущности,
 * и правка означает «с этой даты и далее столько» (ступень суммы). Если бы обе вели себя одинаково,
 * человек поправил бы декабрь и не понял, почему поехал март — или наоборот.
 */
interface GridDto {
  periods: { startsOn: string; endsOn: string }[];
  groups: {
    kind: string;
    informational?: boolean;
    rows: {
      targetId: string;
      name: string;
      sourceCurrency: string;
      cells: { minor: string; state: string }[];
    }[];
  }[];
  footer: { freeMinor: string[]; perDayMinor: string[] };
}

async function readGrid(client: TestClient): Promise<GridDto> {
  return await expectOk<GridDto>(await client.get('/v1/plan/grid?periods=4'));
}

function cellsOf(g: GridDto, targetId: string): string[] {
  for (const group of g.groups) {
    const row = group.rows.find((r) => r.targetId === targetId);
    if (row) return row.cells.map((c) => c.minor);
  }
  throw new Error(`строка ${targetId} не найдена в сетке`);
}

describe('правка ячейки сетки', () => {
  test('бюджет категории меняется в одном столбце, соседние не трогаются', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const food = await categoryId(client, 'Продукты');
    // Категория без бюджета в сетке не строка: сначала задаём план, иначе сравнивать нечего.
    await expectOk(
      await client.put(`/v1/plan/current/categories/${food}`, { plannedMinor: '2000000' }),
    );
    const before = await readGrid(client);
    const third = before.periods[2]!.startsOn;

    const after = await expectOk<GridDto>(
      await client.put('/v1/plan/grid/cell?periods=4', {
        targetKind: 'category',
        targetId: food,
        startsOn: third,
        plannedMinor: '1234500',
      }),
    );

    const cells = cellsOf(after, food);
    expect(cells[2]).toBe('1234500');
    // Соседние столбцы остались прежними: бюджет категории — свойство периода, а не сущности.
    expect(cells[1]).toBe(cellsOf(before, food)[1]);
    expect(cells[3]).toBe(cellsOf(before, food)[3]);
  });

  test('платёж долга едет с этой даты и дальше: это ступень, а не один столбец', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const debt = await expectOk<{ id: string }>(
      await client.post('/v1/debts', {
        name: 'Кредит',
        currency: 'RUB',
        principalMinor: '9000000',
        remainingMinor: '9000000',
        paymentMinor: '500000',
      }),
      201,
    );
    const before = await readGrid(client);
    const third = before.periods[2]!.startsOn;

    const after = await expectOk<GridDto>(
      await client.put('/v1/plan/grid/cell?periods=4', {
        targetKind: 'debt',
        targetId: debt.id,
        startsOn: third,
        plannedMinor: '700000',
      }),
    );

    const cells = cellsOf(after, debt.id);
    expect(cells[0]).toBe('500000');
    expect(cells[1]).toBe('500000');
    expect(cells[2]).toBe('700000');
    // И дальше тоже: человек сказал «с этой даты столько», а не «в этом месяце столько».
    expect(cells[3]).toBe('700000');
  });

  test('ответ — пересобранная сетка: распределение идёт обратно сразу', async () => {
    const client = await onboarded({ payoutMinor: '3000000' });
    const food = await categoryId(client, 'Продукты');
    const before = await readGrid(client);
    const second = before.periods[1]!.startsOn;

    // Просим больше, чем есть в периоде: каскаду придётся сжимать, и это должно быть видно в ответе.
    const after = await expectOk<GridDto>(
      await client.put('/v1/plan/grid/cell?periods=4', {
        targetKind: 'category',
        targetId: food,
        startsOn: second,
        plannedMinor: '9000000',
      }),
    );
    // Свободных денег в этом столбце стало меньше: каскад забрал их под новый бюджет.
    expect(BigInt(after.footer.freeMinor[1]!)).toBeLessThan(BigInt(before.footer.freeMinor[1]!));
  });

  test('правка валютной строки понимается в базовой валюте, а не в её собственной (issue #153)', async () => {
    /*
     * В таблице всё показано в рублях, и человек правит рубли. До 22.08.2026 введённое число
     * ложилось прямо в валютное поле сущности: у цели в EUR «5 000» превращались в 5 000 EUR
     * (≈ 484 500 ₽) вместо 5 000 ₽. Молча, с кодом 200 — план вырастал в сто раз.
     */
    const client = await onboarded({ payoutMinor: '30000000' });
    const on = new Date().toISOString().slice(0, 10);
    await seedRate('EUR', 'RUB', '100.0000000000', on, 'cbr');

    const goal = await expectOk<{ id: string }>(
      await client.post('/v1/goals', {
        name: 'Мотоцикл',
        currency: 'EUR',
        targetMinor: '400000',
        plannedPerPeriodMinor: '5000',
      }),
      201,
    );

    const before = await readGrid(client);
    // 50 EUR × 100 ₽ = 5 000 ₽ в базовой валюте.
    expect(cellsOf(before, goal.id)[0]).toBe('500000');

    const after = await expectOk<GridDto>(
      await client.put('/v1/plan/grid/cell?periods=4', {
        targetKind: 'goal',
        targetId: goal.id,
        startsOn: before.periods[0]!.startsOn,
        plannedMinor: '1000000',
      }),
    );

    // Ввели 10 000 ₽ → ячейка показывает 10 000 ₽, а взнос стал 100 EUR.
    expect(cellsOf(after, goal.id)[0]).toBe('1000000');
    const row = await expectOk<{ plannedPerPeriodMinor: string }[]>(await client.get('/v1/goals'));
    expect(row.find((g) => g.plannedPerPeriodMinor !== undefined)).toBeDefined();
    expect(
      (
        await expectOk<{ id: string; plannedPerPeriodMinor: string }[]>(
          await client.get('/v1/goals'),
        )
      ).find((g) => g.id === goal.id)?.plannedPerPeriodMinor,
    ).toBe('10000');
  });

  test('регулярный платёж правится на один период: «в этом месяце другая сумма» (issue #154)', async () => {
    /*
     * Жалоба владельца 22.08.2026: «поменял сумму за инет — она не изменилась». Ячейку можно было
     * открыть и ввести число, сервер отвечал 400 (вида строки не было в схеме), а клиент отказ не
     * показывал — правка выглядела как «кнопка не сработала».
     *
     * Смысл правки здесь именно разовый: счёт за интернет в этом месяце другой, а со следующего
     * снова обычный. Поэтому меняется ОДИН столбец, а сама строка остаётся как была.
     */
    const client = await onboarded({ payoutMinor: '30000000' });
    const item = await expectOk<{ id: string }>(
      await client.post('/v1/recurring-items', {
        name: 'Интернет',
        amountMinor: '400000',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [5, 12, 20, 27] },
      }),
      201,
    );

    const before = await readGrid(client);
    const baseline = cellsOf(before, item.id);

    const after = await expectOk<GridDto>(
      await client.put('/v1/plan/grid/cell?periods=4', {
        targetKind: 'recurring',
        targetId: item.id,
        startsOn: before.periods[1]!.startsOn,
        plannedMinor: '250000',
      }),
    );

    const cells = cellsOf(after, item.id);
    expect(cells[1]).toBe('250000');
    // Соседние столбцы прежние: это отклонение периода, а не новая сумма платежа.
    expect(cells[0]).toBe(baseline[0]);
    expect(cells[2]).toBe(baseline[2]);
    expect(cells[3]).toBe(baseline[3]);

    // Сама строка не тронута: со следующего месяца платёж снова обычный.
    const items = await expectOk<{ id: string; amountMinor: string }[]>(
      await client.get('/v1/recurring-items'),
    );
    expect(items.find((r) => r.id === item.id)?.amountMinor).toBe('400000');
  });

  test('отклонение регулярного платежа снимается пустым значением', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const item = await expectOk<{ id: string }>(
      await client.post('/v1/recurring-items', {
        name: 'Связь',
        amountMinor: '200000',
        currency: 'RUB',
        schedule: { kind: 'monthly-days', days: [5, 12, 20, 27] },
      }),
      201,
    );
    const before = await readGrid(client);
    const startsOn = before.periods[1]!.startsOn;
    const baseline = cellsOf(before, item.id);

    await expectOk<GridDto>(
      await client.put('/v1/plan/grid/cell?periods=4', {
        targetKind: 'recurring',
        targetId: item.id,
        startsOn,
        plannedMinor: '100000',
      }),
    );
    const cleared = await expectOk<GridDto>(
      await client.put('/v1/plan/grid/cell?periods=4', {
        targetKind: 'recurring',
        targetId: item.id,
        startsOn,
        plannedMinor: '0',
      }),
    );

    // Ноль здесь — «верни как было», а не «платежа нет»: иначе снять отклонение было бы нечем.
    expect(cellsOf(cleared, item.id)[1]).toBe(baseline[1]);
  });

  test('доход через ячейку не правится: отказ явный, а не молчание (issue #154)', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const grid = await readGrid(client);
    const income = grid.groups.find((g) => g.kind === 'income')!.rows[0]!;

    const res = await client.put('/v1/plan/grid/cell?periods=4', {
      targetKind: 'income',
      targetId: income.targetId,
      startsOn: grid.periods[0]!.startsOn,
      plannedMinor: '100000',
    });
    // 422 «так нельзя», а не 400 «непонятный запрос»: вид строки известен, правка не поддержана.
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('cell_not_editable');
  });

  test('прошлый период не правится: план закрытого периода — история', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const food = await categoryId(client, 'Продукты');
    const res = await client.put('/v1/plan/grid/cell?periods=4', {
      targetKind: 'category',
      targetId: food,
      startsOn: '2020-01-01',
      plannedMinor: '100000',
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'period_is_past' });
  });

  test('чужую строку через сетку не поправить', async () => {
    const alice = await onboarded({ payoutMinor: '30000000' });
    const food = await categoryId(alice, 'Продукты');
    const bob = await onboarded({ payoutMinor: '30000000' });
    const g = await readGrid(bob);
    const res = await bob.put('/v1/plan/grid/cell?periods=4', {
      targetKind: 'category',
      targetId: food,
      startsOn: g.periods[1]!.startsOn,
      plannedMinor: '100000',
    });
    expect(res.status).toBe(404);
  });

  test('участник сетку не правит: он смотрит и не меняет', async () => {
    const owner = await onboarded({ payoutMinor: '30000000' });
    const invite = await expectOk<{ code: string }>(
      await owner.post('/v1/workspace/invites', { role: 'member' }),
      201,
    );
    // Именно без своего воркспейса: с ним резолвился бы он, и мы проверяли бы не то.
    const guest = await signedUp();
    await expectOk(await guest.post(`/v1/workspace/invites/${invite.code}/accept`));

    const food = await categoryId(owner, 'Продукты');
    const g = await readGrid(owner);
    const res = await guest.put('/v1/plan/grid/cell?periods=4', {
      targetKind: 'category',
      targetId: food,
      startsOn: g.periods[1]!.startsOn,
      plannedMinor: '100000',
    });
    expect(res.status).toBe(403);
  });
});
