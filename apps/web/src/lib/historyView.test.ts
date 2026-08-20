import { describe, expect, test } from 'vitest';
import { groupByDay, historyTotals, matchesQuery } from './historyView.ts';
import type { Transaction } from './queries.ts';

/**
 * Список трат (issue #137, вопрос владельца: «где история трат у нас в проекте вообще?»).
 *
 * Экрана не было вовсе: траты можно записать, но найти нельзя — только выгрузить CSV и открыть в
 * том же Excel, из которого человек уходил. Здесь — та часть, которая решает, ЧТО показать:
 * группировка по дням, итоги и поиск. В компоненте её держать нельзя (правило 4), да и проверить
 * арифметику итогов иначе как тестом невозможно.
 */

const tx = (over: Partial<Transaction>): Transaction => ({
  id: crypto.randomUUID(),
  kind: 'expense',
  categoryId: null,
  amountMinor: '100000',
  currency: 'RUB',
  baseAmountMinor: '100000',
  rate: '1',
  rateSource: 'base',
  rateDate: '2026-08-19',
  occurredOn: '2026-08-19',
  source: 'manual',
  note: null,
  ...over,
});

describe('группировка трат по дням', () => {
  test('дни идут от свежего к старому, внутри дня — как пришло', () => {
    /*
     * Свежее сверху: человек открывает историю, чтобы увидеть последнее, а не начало времён.
     * Порядок внутри дня сервер уже задал (по дате и id), и перетасовывать его на клиенте значило
     * бы спорить с ним без причины.
     */
    const groups = groupByDay([
      tx({ occurredOn: '2026-08-17', amountMinor: '100' }),
      tx({ occurredOn: '2026-08-19', amountMinor: '200' }),
      tx({ occurredOn: '2026-08-19', amountMinor: '300' }),
    ]);
    expect(groups.map((g) => g.day)).toEqual(['2026-08-19', '2026-08-17']);
    expect(groups[0]!.rows.map((r) => r.amountMinor)).toEqual(['200', '300']);
  });

  test('итог дня считается в базовой валюте, а не в валюте траты', () => {
    /*
     * Складывать 2 000 RSD и 50 EUR нельзя — это разные деньги. Для суммы дня берём
     * `baseAmountMinor`: он посчитан по курсу на дату траты и уже приведён к базовой.
     */
    const groups = groupByDay([
      tx({
        occurredOn: '2026-08-19',
        amountMinor: '5000',
        currency: 'EUR',
        baseAmountMinor: '585000',
      }),
      tx({
        occurredOn: '2026-08-19',
        amountMinor: '200000',
        currency: 'RSD',
        baseAmountMinor: '156000',
      }),
    ]);
    expect(groups[0]!.totalBaseMinor).toBe('741000');
  });

  test('приход не складывается с тратами: это разные знаки', () => {
    /*
     * Внеплановый приход (side hustle) живёт в той же таблице. Смешав его с расходами, итог дня
     * показал бы «потратил меньше», хотя человек не тратил меньше — он заработал.
     */
    const groups = groupByDay([
      tx({ occurredOn: '2026-08-19', kind: 'expense', baseAmountMinor: '300000' }),
      tx({ occurredOn: '2026-08-19', kind: 'income', baseAmountMinor: '1000000' }),
    ]);
    expect(groups[0]!.totalBaseMinor).toBe('300000');
    expect(groups[0]!.incomeBaseMinor).toBe('1000000');
  });

  test('пустой список не даёт групп', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('итоги истории', () => {
  test('расходы и приходы считаются раздельно, число строк — общее', () => {
    const totals = historyTotals([
      tx({ kind: 'expense', baseAmountMinor: '300000' }),
      tx({ kind: 'expense', baseAmountMinor: '150000' }),
      tx({ kind: 'income', baseAmountMinor: '2000000' }),
    ]);
    expect(totals).toEqual({ spentBaseMinor: '450000', incomeBaseMinor: '2000000', rows: 3 });
  });

  test('пусто — нули, а не пропуск: «трат нет» это тоже ответ', () => {
    expect(historyTotals([])).toEqual({ spentBaseMinor: '0', incomeBaseMinor: '0', rows: 0 });
  });
});

describe('поиск по строке', () => {
  test('ищет в заметке независимо от регистра', () => {
    expect(matchesQuery(tx({ note: 'Кофе на вынос' }), 'кофе')).toBe(true);
    expect(matchesQuery(tx({ note: 'Кофе на вынос' }), 'такси')).toBe(false);
  });

  test('пустой запрос пропускает всё: поиск не должен прятать историю до первого символа', () => {
    expect(matchesQuery(tx({ note: null }), '')).toBe(true);
    expect(matchesQuery(tx({ note: null }), '   ')).toBe(true);
  });

  test('трата без заметки не находится по тексту, но и не роняет поиск', () => {
    expect(matchesQuery(tx({ note: null }), 'кофе')).toBe(false);
  });
});
