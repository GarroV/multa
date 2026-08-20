import type { Transaction } from './queries.ts';

/**
 * Подготовка истории трат к показу (issue #137).
 *
 * Экрана истории в продукте не было вовсе: трату можно записать, но найти нельзя — только выгрузить
 * CSV и открыть в том же Excel, из которого человек уходил. Здесь решается, ЧТО показать: дни,
 * итоги, поиск. В компоненте этому места нет (правило 4: домен — не в JSX), да и арифметику итогов
 * иначе как тестом не проверить.
 *
 * Все суммы наружу — строками, как во всём продукте: bigint в JSON не живёт, а во float деньги
 * считать нельзя.
 */

export interface HistoryDay {
  readonly day: string;
  readonly rows: readonly Transaction[];
  /** Сколько потрачено за день в базовой валюте. Приходы сюда НЕ входят. */
  readonly totalBaseMinor: string;
  /** Сколько пришло за день (внеплановый доход) — отдельным числом. */
  readonly incomeBaseMinor: string;
}

/**
 * Группировка по дням, свежее сверху.
 *
 * Суммируем `baseAmountMinor`, а не `amountMinor`: складывать 2 000 RSD и 50 EUR нельзя, это разные
 * деньги. В базовой валюте сумма уже посчитана по курсу на дату траты — тому самому иммутабельному
 * снапшоту, ради которого он и хранится (правило 2).
 *
 * Расход и приход считаются раздельно. Внеплановый приход живёт в той же таблице, и сложив его с
 * расходами, итог дня сказал бы «потратил меньше» — хотя человек не тратил меньше, он заработал.
 */
export function groupByDay(rows: readonly Transaction[]): HistoryDay[] {
  const byDay = new Map<string, Transaction[]>();
  for (const row of rows) {
    const list = byDay.get(row.occurredOn) ?? [];
    list.push(row);
    byDay.set(row.occurredOn, list);
  }

  return (
    [...byDay.entries()]
      // Свежее сверху: историю открывают ради последнего, а не ради начала времён.
      .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
      .map(([day, dayRows]) => ({
        day,
        // Порядок внутри дня задал сервер (дата, затем id) — переставлять его на клиенте нечего.
        rows: dayRows,
        totalBaseMinor: sumBase(dayRows, 'expense'),
        incomeBaseMinor: sumBase(dayRows, 'income'),
      }))
  );
}

function sumBase(rows: readonly Transaction[], kind: 'expense' | 'income'): string {
  let total = 0n;
  for (const row of rows) {
    if (row.kind !== kind) continue;
    total += BigInt(row.baseAmountMinor);
  }
  return total.toString();
}

export interface HistoryTotals {
  readonly spentBaseMinor: string;
  readonly incomeBaseMinor: string;
  readonly rows: number;
}

/** Итоги показанного среза: сколько потрачено, сколько пришло и сколько всего строк. */
export function historyTotals(rows: readonly Transaction[]): HistoryTotals {
  return {
    spentBaseMinor: sumBase(rows, 'expense'),
    incomeBaseMinor: sumBase(rows, 'income'),
    rows: rows.length,
  };
}

/**
 * Поиск по заметке.
 *
 * Пустой запрос пропускает всё: прятать историю до первого введённого символа значило бы наказывать
 * за клик по полю поиска. Трата без заметки по тексту не находится — и это не повод падать.
 */
export function matchesQuery(row: Transaction, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (row.note ?? '').toLowerCase().includes(needle);
}
