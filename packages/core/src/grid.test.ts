import { describe, expect, it } from 'vitest';
import { projectGrid, type GridInput, type GridRowSpec } from './grid.ts';

/**
 * Мастер-сетка «строки × периоды выплат» (issue #47) — то, ради чего человек уходит из Excel:
 * увидеть полгода вперёд одной таблицей, а не собирать её руками каждый месяц.
 *
 * Правило, из которого следует всё остальное: **матрица ничего не решает сама**. Каждая колонка —
 * тот же каскад ядра, что и на «Плане»; матрица только раскладывает его результат по столбцам.
 * Поэтому здесь проверяется не арифметика раздачи (она в cascade.test.ts), а жизненный цикл строк
 * и то, что инварианты каскада держатся во ВСЕХ колонках, а не только в текущей.
 */

const periods = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    startsOn: `2026-0${i + 1}-01`,
    endsOn: `2026-0${i + 1}-15`,
    daysInPeriod: 15,
  }));

const input = (over: Partial<GridInput>): GridInput => ({
  periods: periods(3),
  incomeMinor: [10_000_00n, 10_000_00n, 10_000_00n],
  rows: [],
  ...over,
});

const row = (over: Partial<GridRowSpec>): GridRowSpec => ({
  targetKind: 'category',
  targetId: 'cat-1',
  name: 'Продукты',
  sourceCurrency: 'RUB',
  perPeriodMinor: 1_000_00n,
  ...over,
});

describe('projectGrid', () => {
  it('раскладывает строку по всем колонкам', () => {
    const grid = projectGrid(input({ rows: [row({})] }));
    expect(grid.rows[0]?.cells.map((c) => c.minor)).toEqual([1_000_00n, 1_000_00n, 1_000_00n]);
    expect(grid.rows[0]?.cells.every((c) => c.state === 'planned')).toBe(true);
  });

  it('закрывшийся долг даёт «кончилось», а не нули до конца горизонта', () => {
    /*
     * Ноль и «строки больше нет» — разные вещи. Если закрытый долг рисовать нулями, человек будет
     * искать в таблице платёж, которого уже не существует, и не увидит главного: с этого месяца
     * деньги освободились.
     */
    const grid = projectGrid(
      input({
        rows: [
          row({
            targetKind: 'debt',
            targetId: 'debt-1',
            name: 'Рассрочка',
            perPeriodMinor: 800_00n,
            remainingMinor: 1_400_00n,
          }),
        ],
      }),
    );

    const cells = grid.rows[0]!.cells;
    // Последний платёж — остаток, а не полная сумма: банк не берёт больше долга.
    expect(cells.map((c) => c.minor)).toEqual([800_00n, 600_00n, 0n]);
    expect(cells.map((c) => c.state)).toEqual(['planned', 'planned', 'ended']);
    expect(grid.rows[0]?.endsAfterIndex).toBe(1);
  });

  it('цель перестаёт набираться, когда собрана', () => {
    const grid = projectGrid(
      input({
        rows: [
          row({
            targetKind: 'goal',
            targetId: 'goal-1',
            name: 'Мотоцикл',
            perPeriodMinor: 500_00n,
            remainingMinor: 900_00n,
          }),
        ],
      }),
    );
    expect(grid.rows[0]?.cells.map((c) => c.minor)).toEqual([500_00n, 400_00n, 0n]);
    expect(grid.rows[0]?.endsAfterIndex).toBe(1);
  });

  it('конверт «процент с выплаты» пересчитывается от дохода каждого периода', () => {
    // Иначе таблица показывает прошлую зарплату там, где доход изменился: доля перестаёт быть долей.
    const grid = projectGrid(
      input({
        incomeMinor: [10_000_00n, 20_000_00n, 5_000_00n],
        rows: [
          row({
            targetKind: 'envelope',
            targetId: 'env-1',
            name: 'Подушка',
            perPeriodMinor: 1_000_00n,
            percent: '10',
          }),
        ],
      }),
    );
    expect(grid.rows[0]?.cells.map((c) => c.minor)).toEqual([1_000_00n, 2_000_00n, 500_00n]);
  });

  it('долги и корзины не режутся ни в одной колонке, даже когда денег не хватает', () => {
    // Инвариант каскада (правило 3) обязан держаться на всём горизонте, а не только в текущем месяце.
    const grid = projectGrid(
      input({
        incomeMinor: [1_000_00n, 1_000_00n, 1_000_00n],
        rows: [
          row({ targetKind: 'debt', targetId: 'debt-1', name: 'Кредит', perPeriodMinor: 700_00n }),
          row({
            targetKind: 'bucket',
            targetId: 'buck-1',
            name: 'Аренда',
            perPeriodMinor: 600_00n,
          }),
          row({ targetKind: 'goal', targetId: 'goal-1', name: 'Отпуск', perPeriodMinor: 400_00n }),
        ],
      }),
    );

    const byId = (id: string) => grid.rows.find((r) => r.targetId === id)!;
    expect(byId('debt-1').cells.every((c) => c.minor === 700_00n)).toBe(true);
    expect(byId('buck-1').cells.every((c) => c.minor === 600_00n)).toBe(true);
    // Цель уступает первой и уходит в ноль — но остаётся строкой, а не исчезает.
    expect(byId('goal-1').cells.every((c) => c.minor === 0n)).toBe(true);
    // Нехватку показываем честно: свободный остаток отрицательный.
    expect(grid.footer.freeMinor.every((v) => v < 0n)).toBe(true);
  });

  it('строки идут в порядке каскада, а не в порядке входа', () => {
    const grid = projectGrid(
      input({
        rows: [
          row({ targetKind: 'goal', targetId: 'g', name: 'Цель' }),
          row({ targetKind: 'debt', targetId: 'd', name: 'Долг' }),
          row({ targetKind: 'category', targetId: 'c', name: 'Продукты' }),
        ],
      }),
    );
    expect(grid.rows.map((r) => r.targetKind)).toEqual(['debt', 'category', 'goal']);
  });

  it('подвал считает то же, что план: свободный остаток, день и «к размену»', () => {
    const grid = projectGrid(
      input({
        periods: periods(2),
        incomeMinor: [3_000_00n, 3_000_00n],
        rows: [
          row({ targetKind: 'bucket', targetId: 'b1', name: 'Аренда', perPeriodMinor: 1_000_00n }),
          row({
            targetKind: 'bucket',
            targetId: 'b2',
            name: 'Жизнь',
            perPeriodMinor: 200_00n,
            toCurrency: 'RSD',
          }),
          row({ targetKind: 'category', targetId: 'c', name: 'Еда', perPeriodMinor: 800_00n }),
        ],
      }),
    );

    expect(grid.footer.toExchangeMinor).toEqual([1_200_00n, 1_200_00n]);
    // Свободный остаток = доход − всё роздано.
    expect(grid.footer.freeMinor).toEqual([1_000_00n, 1_000_00n]);
    // На день = (категории 800 + свободный остаток 1 000) ÷ 15 дней; делит ядро, а не React.
    expect(grid.footer.perDayMinor).toEqual([120_00n, 120_00n]);
  });

  it('«к размену» разбивается по валютам получения', () => {
    const grid = projectGrid(
      input({
        periods: periods(2),
        rows: [
          row({
            targetKind: 'bucket',
            targetId: 'b1',
            name: 'Аренда',
            perPeriodMinor: 1_000_00n,
            toCurrency: 'EUR',
          }),
          row({
            targetKind: 'bucket',
            targetId: 'b2',
            name: 'Жизнь',
            perPeriodMinor: 200_00n,
            toCurrency: 'RSD',
          }),
          row({
            targetKind: 'bucket',
            targetId: 'b3',
            name: 'Ещё евро',
            perPeriodMinor: 300_00n,
            toCurrency: 'EUR',
          }),
        ],
      }),
    );

    expect(grid.footer.toExchangeByCurrency).toEqual([
      { currency: 'EUR', cells: [1_300_00n, 1_300_00n] },
      { currency: 'RSD', cells: [200_00n, 200_00n] },
    ]);
  });

  it('сохранённый план материализованного периода сильнее проекции', () => {
    /*
     * Первая колонка обязана в копейку совпадать с экраном «План»: там человек мог перенести
     * деньги между строками, и матрица не вправе показать ему пересчитанную заново версию.
     */
    const grid = projectGrid(
      input({
        rows: [
          row({ targetKind: 'category', targetId: 'c1', name: 'Еда', perPeriodMinor: 1_000_00n }),
        ],
        saved: [new Map([['category:c1', 1_500_00n]]), undefined, undefined],
      }),
    );
    expect(grid.rows[0]?.cells.map((c) => c.minor)).toEqual([1_500_00n, 1_000_00n, 1_000_00n]);
  });

  it('платёж сохранённого периода тоже приближает закрытие долга', () => {
    /*
     * Ловушка, на которой матрица врала: сохранённый период считался «уже посчитанным» и остаток
     * долга по нему не уменьшался. Из-за этого долг в таблице закрывался на период позже, чем в
     * жизни, — а именно ради даты свободы человек в эту таблицу и смотрит.
     */
    const grid = projectGrid(
      input({
        rows: [
          row({
            targetKind: 'debt',
            targetId: 'd1',
            name: 'Рассрочка',
            perPeriodMinor: 800_00n,
            remainingMinor: 1_400_00n,
          }),
        ],
        saved: [new Map([['debt:d1', 800_00n]]), undefined, undefined],
      }),
    );
    expect(grid.rows[0]?.cells.map((c) => c.minor)).toEqual([800_00n, 600_00n, 0n]);
    expect(grid.rows[0]?.endsAfterIndex).toBe(1);
  });

  it('строки нет в сохранённом плане — значит в том периоде её не было', () => {
    // Так выглядит замороженная цель (issue #54): взноса нет, но строка на месте.
    const grid = projectGrid(
      input({
        rows: [row({ targetKind: 'goal', targetId: 'g1', name: 'Цель' })],
        saved: [new Map(), undefined, undefined],
      }),
    );
    expect(grid.rows[0]?.cells[0]).toEqual({ minor: 0n, state: 'none' });
    expect(grid.rows[0]?.cells[1]?.state).toBe('planned');
  });

  it('итог строки — сумма её колонок, итог группы — сумма строк', () => {
    const grid = projectGrid(
      input({
        periods: periods(2),
        rows: [
          row({ targetKind: 'category', targetId: 'c1', name: 'Еда', perPeriodMinor: 500_00n }),
          row({ targetKind: 'category', targetId: 'c2', name: 'Дом', perPeriodMinor: 300_00n }),
        ],
      }),
    );
    expect(grid.rows[0]?.totalMinor).toBe(1_000_00n);
    const cats = grid.groups.find((g) => g.kind === 'category')!;
    expect(cats.totals).toEqual([800_00n, 800_00n]);
    expect(cats.totalMinor).toBe(1_600_00n);
  });

  it('пустой горизонт не ломает подвал', () => {
    const grid = projectGrid(input({ periods: [], incomeMinor: [], rows: [row({})] }));
    expect(grid.rows).toEqual([]);
    expect(grid.footer.freeMinor).toEqual([]);
  });
});
