import { describe, expect, test } from 'vitest';
import { categoryId, expectOk, onboarded, signedUp, type TestClient } from './client.ts';

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
    rows: { targetId: string; name: string; cells: { minor: string; state: string }[] }[];
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
